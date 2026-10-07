import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { dashboard } from './dashboard'
import {
  addTask,
  clip,
  endTask,
  isAgentLive,
  mergeSpawn,
  pushFeed,
  reconcileAgents,
  reconcileTasks,
  sameCrons,
  scanTranscript,
} from './model'
import type { InFlight, Note } from './model'

const PANE = 'dash-it'

const tasks = atom({ plugin: 'dash-it', key: 'tasks' } as const, [])
const agents = atom({ plugin: 'dash-it', key: 'agents' } as const, [])
const crons = atom({ plugin: 'dash-it', key: 'crons' } as const, [])
const feed = atom({ plugin: 'dash-it', key: 'feed' } as const, [])
const collapsed = atom({ plugin: 'dash-it', key: 'collapsed' } as const, [])
const now = atom({ plugin: 'dash-it', key: 'now' } as const, 0)
const history = atom({ plugin: 'dash-it', key: 'history' } as const, [])
const selected = atom({ plugin: 'dash-it', key: 'selected' } as const, '')
const spawns = atom({ plugin: 'dash-it', key: 'spawns' } as const, {})
const sync = atom({ plugin: 'dash-it', key: 'sync' } as const, { requestedAt: 0, doneAt: 0 })
const SYNC_PROMPT = 'dash-it sync: reply with only "ok".'
const SYNC_WAIT_MS = 30_000
const TICK_MS = 250
let ticks = 0

async function note($: EngineInterface, notes: Note[]) {
  if (notes.length === 0) return
  const at = await $.clock.now()
  await update($, feed, list => pushFeed(list, notes, at))
}

async function refresh($: EngineInterface) {
  const at = await $.clock.now()
  const prev = await read($, agents)
  const [next, notes] = reconcileAgents(prev, await $.agent.list(), at)
  if (JSON.stringify(prev) !== JSON.stringify(next)) await update($, agents, () => next)
  await note($, notes)

  await touch($)
}

// Free: rebuilds what the conversation already shows and polls the agent list.
async function backfill($: EngineInterface) {
  const at = await $.clock.now()
  const found = scanTranscript(await $.session.messages(), at)
  await update($, tasks, list => found.tasks.reduce(addTask, list))
  await update($, spawns, all =>
    Object.entries(found.spawns).reduce(
      (acc, [id, patch]) => (acc[id]?.prompt ? acc : mergeSpawn(acc, id, patch)),
      all,
    ),
  )
  await refresh($)
}

// Costs one short turn: its Stop event carries the engine's real in-flight list.
async function requestSync($: EngineInterface) {
  const at = await $.clock.now()
  const cur = await read($, sync)
  await backfill($)
  const isWaiting = cur.requestedAt > cur.doneAt && at - cur.requestedAt < SYNC_WAIT_MS
  if (isWaiting) return
  await update($, sync, s => ({ ...s, requestedAt: at }))
  void $.prompt.submit({ text: SYNC_PROMPT }).catch(() => undefined)
}

async function liveCount($: EngineInterface) {
  const running = (await read($, tasks)).filter(t => t.status === 'running').length

  return running + (await read($, agents)).filter(isAgentLive).length
}

// Moves the clock the pane animates from, only while something is running.
async function touch($: EngineInterface) {
  const wait = await read($, sync)
  const isWaiting = wait.requestedAt > wait.doneAt
  if ((await liveCount($)) === 0 && !isWaiting) return
  const at = await $.clock.now()
  await update($, now, () => at)
}

async function sample($: EngineInterface) {
  const live = await liveCount($)
  await update($, history, list =>
    live === 0 && (list.at(-1) ?? 0) === 0 ? list : [...list, live].slice(-60),
  )
}

async function tick($: EngineInterface, n: number) {
  if (n % 4 === 0) await refresh($)
  else await touch($)
  if (n % 8 === 0) await sample($)
}

// Stop and SubagentStop carry the engine's own list of in-flight background work.
async function syncInFlight(
  $: EngineInterface,
  inflight: InFlight[] | undefined,
  schedules: { id: string; schedule: string; recurring: boolean; prompt: string }[] | undefined,
) {
  const at = await $.clock.now()
  const before = await read($, tasks)
  const after = reconcileTasks(before, inflight ?? [], at)
  const started = after.filter(a => !before.some(b => b.id === a.id))
  const ended = after.filter(
    a => a.status === 'ended' && before.find(b => b.id === a.id)?.status === 'running',
  )
  await update($, tasks, () => after)
  await note($, [
    ...started.map(t => ({ text: `${t.kind} started: ${t.label}`, ref: `task:${t.id}` })),
    ...ended.map(t => ({ text: `${t.kind} finished: ${t.label}`, ref: `task:${t.id}` })),
  ])
  if (schedules !== undefined && !sameCrons(await read($, crons), schedules)) {
    await update($, crons, () => schedules)
  }
  await update($, now, () => at)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dash-it',
      description: 'Open a dashboard of background shells, subagents and schedules',
    })
    $.clock.every(TICK_MS, () => {
      ticks += 1
      void tick($, ticks)
    })

    return next(e)
  })

  on('command.run', { command: 'dash-it' }, async ($, e) => {
    if (e.args.trim() === 'close') {
      await $.ui.close({ id: PANE })

      return { text: 'Dashboard closed.' }
    }
    if (e.args.trim() === 'refresh') {
      await requestSync($)

      return { text: 'Refreshing: asked Claude for a short turn to sync background tasks.' }
    }
    await backfill($)
    await $.ui.open({ id: PANE, title: 'Dashboard', rows: 40, columns: 84 })

    return { text: 'Dashboard opened. Run /dash-it close to close it.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const out = ran.result as { backgroundTaskId?: string } | undefined
    if (out?.backgroundTaskId) {
      const at = await $.clock.now()
      const label = e.description ?? e.command
      await update($, tasks, list =>
        addTask(list, {
          id: out.backgroundTaskId as string,
          kind: 'shell',
          label,
          detail: e.description ? e.command : undefined,
          command: e.command,
          description: e.description,
          status: 'running',
          startedAt: at,
        }),
      )
      await note($, [{ text: `shell started: ${label}`, ref: `task:${out.backgroundTaskId}` }])
    }

    return ran
  })

  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const ran = await next(e)
    const out = ran.result as { taskId?: string } | undefined
    if (out?.taskId) {
      const at = await $.clock.now()
      await update($, tasks, list =>
        addTask(list, {
          id: out.taskId as string,
          kind: 'monitor',
          label: e.description,
          detail: e.command,
          command: e.command,
          description: e.description,
          status: 'running',
          startedAt: at,
        }),
      )
      await note($, [{ text: `monitor started: ${e.description}`, ref: `task:${out.taskId}` }])
    }

    return ran
  })

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    const id = e.task_id ?? e.shell_id
    if (id !== undefined && ran.isError !== true && ran.deny === undefined) {
      const at = await $.clock.now()
      await update($, tasks, list => endTask(list, id, 'killed', at))
    }

    return ran
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      const tool = String(e.tool)
      await update($, spawns, all => mergeSpawn(all, id, { lastTool: tool }, 1))
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const out = await next(e)
    const id = (out as { agentId?: string }).agentId
    if (id !== undefined) {
      const model = (out as { model?: string }).model
      await update($, spawns, all =>
        mergeSpawn(all, id, { prompt: clip(e.prompt, 6000), model, background: e.background }),
      )
    }

    return out
  })

  on('classic.Stop', async ($, e, next) => {
    await syncInFlight($, e.background_tasks, e.session_crons)
    const at = await $.clock.now()
    await update($, sync, s => ({ ...s, doneAt: at }))

    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    const report = e.last_assistant_message
    if (report) {
      await update($, spawns, all => mergeSpawn(all, e.agent_id, { result: clip(report, 6000) }))
    }
    await syncInFlight($, e.background_tasks, e.session_crons)
    await refresh($)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const snapshot = {
      tasks: await read($, tasks),
      agents: await read($, agents),
      crons: await read($, crons),
      feed: await read($, feed),
      collapsed: await read($, collapsed),
      now: await read($, now),
      history: await read($, history),
      selected: await read($, selected),
      spawns: await read($, spawns),
      sync: await read($, sync),
      width: e.props.bodyColumns,
    }

    const toggle = (id: string) =>
      update($, collapsed, list =>
        list.includes(id) ? list.filter(one => one !== id) : [...list, id],
      )

    const select = (ref: string) => update($, selected, () => ref)

    const refreshNow = () => requestSync($)

    return dashboard(ui, snapshot, { toggle, select, refresh: refreshNow })
  })
}
