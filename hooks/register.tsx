import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { dashboard } from './dashboard'
import {
  addTask,
  endTask,
  isAgentLive,
  pushFeed,
  reconcileAgents,
  reconcileTasks,
  sameCrons,
} from './model'
import type { InFlight } from './model'

const PANE = 'dash-it'

const tasks = atom({ plugin: 'dash-it', key: 'tasks' } as const, [])
const agents = atom({ plugin: 'dash-it', key: 'agents' } as const, [])
const crons = atom({ plugin: 'dash-it', key: 'crons' } as const, [])
const feed = atom({ plugin: 'dash-it', key: 'feed' } as const, [])
const collapsed = atom({ plugin: 'dash-it', key: 'collapsed' } as const, [])
const now = atom({ plugin: 'dash-it', key: 'now' } as const, 0)
const history = atom({ plugin: 'dash-it', key: 'history' } as const, [])
const TICK_MS = 250
let ticks = 0

async function note($: EngineInterface, texts: string[]) {
  if (texts.length === 0) return
  const at = await $.clock.now()
  await update($, feed, list => pushFeed(list, texts, at))
}

async function refresh($: EngineInterface) {
  const at = await $.clock.now()
  const prev = await read($, agents)
  const [next, notes] = reconcileAgents(prev, await $.agent.list(), at)
  if (JSON.stringify(prev) !== JSON.stringify(next)) await update($, agents, () => next)
  await note($, notes)

  await touch($)
}

async function liveCount($: EngineInterface) {
  const running = (await read($, tasks)).filter(t => t.status === 'running').length

  return running + (await read($, agents)).filter(isAgentLive).length
}

// Moves the clock the pane animates from, only while something is running.
async function touch($: EngineInterface) {
  if ((await liveCount($)) === 0) return
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
    ...started.map(t => `${t.kind} started: ${t.label}`),
    ...ended.map(t => `${t.kind} finished: ${t.label}`),
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
    await refresh($)
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
          status: 'running',
          startedAt: at,
        }),
      )
      await note($, [`shell started: ${label}`])
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
          status: 'running',
          startedAt: at,
        }),
      )
      await note($, [`monitor started: ${e.description}`])
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

  on('classic.Stop', async ($, e, next) => {
    await syncInFlight($, e.background_tasks, e.session_crons)

    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
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
      width: e.props.bodyColumns,
    }

    const toggle = (id: string) =>
      update($, collapsed, list =>
        list.includes(id) ? list.filter(one => one !== id) : [...list, id],
      )

    return dashboard(ui, snapshot, toggle)
  })
}
