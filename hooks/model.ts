import type { DashAgent, DashAgentDetail, DashCron, DashFeedItem, DashTask } from '../types'

export type InFlight = {
  id: string
  type: string
  description: string
  command?: string
  agent_type?: string
  name?: string
  server?: string
}

export type AgentSeen = {
  id: string
  name?: string
  type: string
  description: string
  status: string
  parentId?: string
}

const LIVE_AGENT = ['pending', 'running', 'waiting', 'idle']
const KEEP_ENDED = 20
const KEEP_FEED = 40

export const isAgentLive = (a: { status: string }) => LIVE_AGENT.includes(a.status)

const trimEnded = <T extends { endedAt?: number }>(list: T[]): T[] => {
  const ended = list.filter(one => one.endedAt !== undefined).slice(-KEEP_ENDED)
  return list.filter(one => one.endedAt === undefined || ended.includes(one))
}

export type Note = { text: string; ref?: string }

export function addTask(list: DashTask[], task: DashTask): DashTask[] {
  if (list.some(one => one.id === task.id)) {
    return list.map(one =>
      one.id === task.id
        ? {
            ...one,
            command: task.command ?? one.command,
            description: task.description ?? one.description,
          }
        : one,
    )
  }

  return trimEnded([...list, task])
}

export function endTask(
  list: DashTask[],
  id: string,
  status: 'ended' | 'killed',
  now: number,
): DashTask[] {
  return list.map(one =>
    one.id === id && one.status === 'running' ? { ...one, status, endedAt: now } : one,
  )
}

// Subagents are shown by the agents widget, so they are skipped here.
export function reconcileTasks(
  list: DashTask[],
  inflight: InFlight[],
  now: number,
): DashTask[] {
  const live = new Set(inflight.map(one => one.id))
  let next = list.map(one => {
    if (one.status === 'running' && !live.has(one.id)) {
      return { ...one, status: 'ended' as const, endedAt: now }
    }
    if (one.status === 'ended' && live.has(one.id)) {
      return { ...one, status: 'running' as const, endedAt: undefined }
    }

    return one
  })
  for (const one of inflight) {
    if (one.type === 'subagent') continue
    next = addTask(next, {
      id: one.id,
      kind: one.type,
      label: one.command ?? one.description,
      detail: one.command ? one.description : (one.name ?? one.server),
      command: one.command,
      description: one.description,
      status: 'running',
      startedAt: now,
    })
  }

  return next
}

export function reconcileAgents(
  prev: DashAgent[],
  seen: AgentSeen[],
  now: number,
): [DashAgent[], Note[]] {
  const notes: Note[] = []
  const byId = new Map(seen.map(one => [one.id, one]))
  const known = new Set(prev.map(one => one.id))
  const next: DashAgent[] = prev.map(one => {
    const cur = byId.get(one.id)
    if (cur === undefined) {
      if (one.endedAt !== undefined) return one
      notes.push({ text: `agent ended: ${one.name || one.type}`, ref: `agent:${one.id}` })

      return { ...one, status: 'ended', endedAt: now }
    }
    const wasLive = isAgentLive(one)
    const live = isAgentLive(cur)
    const who = cur.name || one.name || cur.type
    const ref = `agent:${one.id}`
    if (wasLive && !live) notes.push({ text: `agent ${cur.status}: ${who}`, ref })
    if (!wasLive && live) notes.push({ text: `agent resumed: ${who}`, ref })

    return {
      ...one,
      name: cur.name || one.name,
      type: cur.type,
      parentId: cur.parentId,
      status: cur.status,
      description: cur.description,
      endedAt: live ? undefined : (one.endedAt ?? now),
    }
  })
  for (const one of seen) {
    if (known.has(one.id)) continue
    notes.push({ text: `agent started: ${one.name || one.type}`, ref: `agent:${one.id}` })
    next.push({
      id: one.id,
      name: one.name ?? '',
      type: one.type,
      description: one.description,
      status: one.status,
      parentId: one.parentId,
      startedAt: now,
      endedAt: isAgentLive(one) ? undefined : now,
    })
  }

  return [trimEnded(next), notes]
}

export function sameCrons(a: DashCron[], b: DashCron[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function pushFeed(feed: DashFeedItem[], notes: Note[], now: number): DashFeedItem[] {
  if (notes.length === 0) return feed

  return [...feed, ...notes.map(n => ({ at: now, text: n.text, ref: n.ref }))].slice(-KEEP_FEED)
}

const KEEP_SPAWNS = 60
const BLANK: DashAgentDetail = { prompt: '', background: false, tools: 0 }

// The spawn hook, the per-agent tool tally and the stop report each fill part of one record.
export function mergeSpawn(
  all: Record<string, DashAgentDetail>,
  id: string,
  patch: Partial<DashAgentDetail>,
  bump = 0,
): Record<string, DashAgentDetail> {
  const cur = all[id] ?? BLANK
  const next = { ...all, [id]: { ...cur, ...patch, tools: cur.tools + bump } }
  const keys = Object.keys(next)

  return keys.length <= KEEP_SPAWNS
    ? next
    : Object.fromEntries(keys.slice(-KEEP_SPAWNS).map(k => [k, next[k] as DashAgentDetail]))
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… ${text.length - max} more characters`
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`

  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function clockTime(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')

  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

const SPARK = '▁▂▃▄▅▆▇█'
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function spark(history: number[], cells: number): string {
  const tail = history.slice(-cells)
  const peak = Math.max(4, ...tail)
  const bars = tail.map(n =>
    n <= 0 ? '▁' : (SPARK[Math.min(7, Math.ceil((n / peak) * 8) - 1)] ?? '▁'),
  )

  return bars.join('').padStart(cells, '▁')
}

export const spinner = (at: number) => FRAMES[Math.floor(at / 120) % FRAMES.length] ?? '⠋'

export function truncate(text: string, cells: number): string {
  const one = text.replace(/\s+/g, ' ')
  if (cells <= 0) return ''

  return one.length <= cells ? one : `${one.slice(0, Math.max(0, cells - 1))}…`
}

export const pad = (text: string, cells: number) => truncate(text, cells).padEnd(cells)

// A bright pair of cells bouncing across a bar: motion for work with no known progress.
export function shimmer(at: number, cells: number): string {
  const span = Math.max(1, cells * 2 - 2)
  const raw = Math.floor(at / 110) % span
  const head = raw < cells ? raw : span - raw

  return Array.from({ length: cells }, (_, i) =>
    Math.abs(i - head) <= 1 ? '▰' : '▱',
  ).join('')
}

export function timelineBar(
  start: number,
  end: number,
  winStart: number,
  span: number,
  cells: number,
): { before: number; run: number; after: number } {
  const from = Math.min(cells - 1, Math.max(0, Math.floor(((start - winStart) / span) * cells)))
  const to = Math.min(cells, Math.max(from + 1, Math.ceil(((end - winStart) / span) * cells)))

  return { before: from, run: to - from, after: cells - to }
}

// Records saved before commands were stored kept the command as `detail` (or as `label`).
export function taskCommand(t: DashTask): string | undefined {
  if (t.command !== undefined) return t.command

  return t.description === undefined ? (t.detail ?? t.label) : undefined
}
