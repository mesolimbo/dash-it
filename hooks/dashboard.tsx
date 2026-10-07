import type { Elements } from 'claude-code'

import type { DashAgent, DashAgentDetail, DashCron, DashFeedItem, DashTask } from '../types'
import {
  clip,
  clockTime,
  elapsed,
  isAgentLive,
  pad,
  shimmer,
  spark,
  spinner,
  taskCommand,
  timelineBar,
  truncate,
} from './model'

export type Snapshot = {
  tasks: DashTask[]
  agents: DashAgent[]
  crons: DashCron[]
  feed: DashFeedItem[]
  collapsed: string[]
  history: number[]
  selected: string
  spawns: Record<string, DashAgentDetail>
  now: number
  width: number
}

type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Code' | 'Markdown'>

export type Handlers = {
  toggle: (id: string) => void
  select: (ref: string) => void
}

// A widget is one titled card: add an entry to WIDGETS and it shows up.
// `count` is the badge on its header, `render` draws its body from the snapshot.
export type Widget = {
  id: string
  title: string
  accent: string
  count: (s: Snapshot) => number
  render: (s: Snapshot, ui: Ui, acts: Handlers) => JSX.Element
}

type Item = {
  id: string
  kind: string
  name: string
  status: string
  startedAt: number
  endedAt?: number
  ref: string
}

const BAR = 8
const TIME = 7

const isLive = (status: string) => status === 'running' || isAgentLive({ status })
const bad = (status: string) => status === 'killed' || status === 'failed'
const tone = (status: string) => (isLive(status) ? 'success' : bad(status) ? 'error' : 'subtle')
const icon = (status: string, at: number) => (isLive(status) ? spinner(at) : bad(status) ? '✗' : '✓')

const items = (s: Snapshot): Item[] => [
  ...s.tasks.map(t => ({
    id: t.id,
    kind: t.kind,
    name: t.label,
    status: t.status,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    ref: `task:${t.id}`,
  })),
  ...s.agents.map(a => ({
    id: a.id,
    kind: 'agent',
    name: a.name || a.type,
    status: a.status,
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    ref: `agent:${a.id}`,
  })),
]

const liveCount = (s: Snapshot) => items(s).filter(one => isLive(one.status)).length
const inner = (s: Snapshot) => Math.max(36, s.width - 4)
const empty = (ui: Ui, text: string) => <ui.Text dimColor>{text}</ui.Text>

function workRow(
  ui: Ui,
  s: Snapshot,
  acts: Handlers,
  one: { id: string; status: string; startedAt: number; endedAt?: number },
  title: string,
  ref: string,
) {
  const { Box, Text, Button } = ui
  const live = isLive(one.status)
  const solid = '▰'.repeat(BAR)

  return (
    <Box flexDirection="row">
      <Text color={tone(one.status)}>{icon(one.status, s.now)}</Text>
      <Text> </Text>
      <Button
        plain
        dimColor={!live}
        key={`open-${ref}`}
        label={pad(title, inner(s) - 4 - BAR - TIME)}
        onPress={() => acts.select(ref)}
      />
      <Text> </Text>
      <Text color={tone(one.status)} dimColor={!live}>
        {live ? shimmer(s.now, BAR) : solid}
      </Text>
      <Text> </Text>
      <Text dimColor>{elapsed((one.endedAt ?? s.now) - one.startedAt).padStart(TIME)}</Text>
    </Box>
  )
}

function timeline(s: Snapshot, ui: Ui, acts: Handlers) {
  const { Box, Text, Button } = ui
  const all = items(s)
  if (all.length === 0) return empty(ui, 'Nothing has run yet. Launch a shell or subagent.')
  const label = 16
  const cells = Math.max(12, inner(s) - label - TIME - 4)
  const earliest = Math.min(...all.map(one => one.startedAt))
  const span = Math.min(900_000, Math.max(60_000, s.now - earliest))
  const winStart = s.now - span
  const shown = [...all]
    .sort(
      (a, b) =>
        Number(isLive(b.status)) - Number(isLive(a.status)) || b.startedAt - a.startedAt,
    )
    .slice(0, 8)
  const left = `-${elapsed(span)}`
  const axis = `${left}${' '.repeat(Math.max(1, cells - left.length - 3))}now`

  return (
    <Box flexDirection="column">
      <Text dimColor>{`${' '.repeat(label + 3)}${axis}`}</Text>
      {shown.map(one => {
        const live = isLive(one.status)
        const bar = timelineBar(one.startedAt, one.endedAt ?? s.now, winStart, span, cells)

        return (
          <Box flexDirection="row">
            <Text color={tone(one.status)}>{icon(one.status, s.now)}</Text>
            <Text> </Text>
            <Button
              plain
              key={`tl-${one.ref}`}
              label={pad(one.name, label)}
              onPress={() => acts.select(one.ref)}
            />
            <Text> </Text>
            <Text dimColor>{'·'.repeat(bar.before)}</Text>
            <Text color={tone(one.status)} dimColor={!live}>
              {'━'.repeat(Math.max(0, bar.run - 1))}
              {live ? '●' : '━'}
            </Text>
            <Text dimColor>{'·'.repeat(bar.after)}</Text>
            <Text> </Text>
            <Text dimColor>
              {elapsed((one.endedAt ?? s.now) - one.startedAt).padStart(TIME - 1)}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

const feedTone = (text: string) =>
  /failed|killed/.test(text) ? 'error' : /started|resumed/.test(text) ? 'success' : 'subtle'

export const WIDGETS: Widget[] = [
  {
    id: 'timeline',
    title: 'Timeline',
    accent: 'claude',
    count: s => items(s).length,
    render: timeline,
  },
  {
    id: 'shells',
    title: 'Background tasks',
    accent: 'success',
    count: s => s.tasks.filter(t => t.status === 'running').length,
    render: (s, ui, acts) => (
      <ui.Box flexDirection="column">
        {s.tasks.length === 0 && empty(ui, 'No background shells or monitors.')}
        {[...s.tasks]
          .reverse()
          .map(one =>
            workRow(
              ui,
              s,
              acts,
              one,
              `${one.kind}: ${one.label}${one.detail ? ` · ${one.detail}` : ''}`,
              `task:${one.id}`,
            ),
          )}
      </ui.Box>
    ),
  },
  {
    id: 'agents',
    title: 'Subagents',
    accent: 'permission',
    count: s => s.agents.filter(isAgentLive).length,
    render: (s, ui, acts) => (
      <ui.Box flexDirection="column">
        {s.agents.length === 0 && empty(ui, 'No subagents yet.')}
        {[...s.agents]
          .reverse()
          .map(one =>
            workRow(
              ui,
              s,
              acts,
              one,
              `${one.name || one.type}: ${one.description}`,
              `agent:${one.id}`,
            ),
          )}
      </ui.Box>
    ),
  },
  {
    id: 'crons',
    title: 'Scheduled',
    accent: 'warning',
    count: s => s.crons.length,
    render: (s, ui) => (
      <ui.Box flexDirection="column">
        {s.crons.length === 0 && empty(ui, 'Nothing scheduled.')}
        {s.crons.map(one => (
          <ui.Box flexDirection="row" gap={1}>
            <ui.Text color="warning">{one.recurring ? '↻' : '◷'}</ui.Text>
            <ui.Text>{one.schedule}</ui.Text>
            <ui.Text dimColor wrap="truncate-end">
              {truncate(one.prompt, inner(s) - one.schedule.length - 4)}
            </ui.Text>
          </ui.Box>
        ))}
      </ui.Box>
    ),
  },
  {
    id: 'feed',
    title: 'Activity',
    accent: 'suggestion',
    count: s => s.feed.length,
    render: (s, ui, acts) => (
      <ui.Box flexDirection="column">
        {s.feed.length === 0 && empty(ui, 'Nothing yet.')}
        {s.feed
          .map((one, i) => ({ one, i }))
          .reverse()
          .slice(0, 10)
          .map(({ one, i }) => {
            const ref = one.ref
            const text = truncate(one.text, inner(s) - 10)

            return (
              <ui.Box flexDirection="row" gap={1}>
                <ui.Text dimColor>{clockTime(one.at)}</ui.Text>
                {ref === undefined ? (
                  <ui.Text color={feedTone(one.text)}>{text}</ui.Text>
                ) : (
                  <ui.Button
                    plain
                    key={`feed-${i}`}
                    label={text}
                    onPress={() => acts.select(ref)}
                  />
                )}
              </ui.Box>
            )
          })}
      </ui.Box>
    ),
  },
]

function pill(ui: Ui, n: number, noun: string, color: string) {
  return n > 0 ? (
    <ui.Text inverse color={color}>{` ${n} ${noun} `}</ui.Text>
  ) : (
    <ui.Text dimColor>{` 0 ${noun} `}</ui.Text>
  )
}

function header(s: Snapshot, ui: Ui) {
  const { Box, Text } = ui
  const live = liveCount(s)
  const shells = s.tasks.filter(t => t.status === 'running').length
  const agents = s.agents.filter(isAgentLive).length
  const peak = Math.max(0, ...s.history)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" gap={1}>
          <Text bold color="claude">◆ dash-it</Text>
          <Text dimColor>background activity</Text>
        </Box>
        {live > 0 ? (
          <Text color="success" bold>{`${spinner(s.now)} LIVE ${live}`}</Text>
        ) : (
          <Text dimColor>○ idle</Text>
        )}
      </Box>
      <Box flexDirection="row" gap={1} marginTop={1}>
        {pill(ui, shells, 'shells', 'success')}
        {pill(ui, agents, 'agents', 'permission')}
        {pill(ui, s.crons.length, 'scheduled', 'warning')}
      </Box>
      <Box flexDirection="row" marginTop={1}>
        <Text dimColor>{'load '}</Text>
        <Text color="suggestion">{spark(s.history, Math.max(10, inner(s) - 16))}</Text>
        <Text dimColor>{` peak ${peak}`}</Text>
      </Box>
    </Box>
  )
}

const fmt = (at: number) => clockTime(at)

function field(ui: Ui, label: string, value: string, color?: string) {
  return (
    <ui.Box flexDirection="row">
      <ui.Text dimColor>{label.padEnd(10)}</ui.Text>
      <ui.Text color={color}>{value}</ui.Text>
    </ui.Box>
  )
}

const heading = (ui: Ui, text: string, accent: string) => (
  <ui.Box marginTop={1}>
    <ui.Text bold color={accent}>{text}</ui.Text>
  </ui.Box>
)

function frame(ui: Ui, s: Snapshot, acts: Handlers, accent: string, title: string, body: JSX.Element[]) {
  const { Box, Text, Button } = ui

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Button key="back" hotkey="b" variant="primary" label="← Back" onPress={() => acts.select('')} />
        <Text dimColor>to the dashboard</Text>
      </Box>
      <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1}>
        <Text bold color={accent}>{truncate(title, inner(s))}</Text>
        {body}
      </Box>
    </Box>
  )
}

function taskDetail(s: Snapshot, ui: Ui, acts: Handlers, t: DashTask) {
  const end = t.endedAt ?? s.now
  const command = taskCommand(t)

  return frame(ui, s, acts, 'success', `${icon(t.status, s.now)} ${t.kind}: ${t.label}`, [
    heading(ui, 'Overview', 'success'),
    field(ui, 'Status', t.status, tone(t.status)),
    field(ui, 'Kind', t.kind),
    field(ui, 'Task id', t.id),
    field(ui, 'Started', fmt(t.startedAt)),
    ...(t.endedAt === undefined ? [] : [field(ui, 'Ended', fmt(t.endedAt))]),
    field(ui, 'Duration', elapsed(end - t.startedAt)),
    ...(t.description && t.description !== command
      ? [heading(ui, 'Why (description)', 'success'), <ui.Text>{t.description}</ui.Text>]
      : []),
    heading(ui, t.kind === 'shell' ? 'Command' : 'Script', 'success'),
    command === undefined ? (
      <ui.Text dimColor>Not captured: the engine did not report this task's command.</ui.Text>
    ) : (
      <ui.Code source={clip(command, 6000)} language="bash" wrap="wrap" />
    ),
  ])
}

function agentDetail(s: Snapshot, ui: Ui, acts: Handlers, a: DashAgent) {
  const info = s.spawns[a.id]
  const parent = s.agents.find(one => one.id === a.parentId)
  const end = a.endedAt ?? s.now

  return frame(ui, s, acts, 'permission', `${icon(a.status, s.now)} ${a.name || a.type}`, [
    heading(ui, 'Overview', 'permission'),
    field(ui, 'Status', a.status, tone(a.status)),
    field(ui, 'Type', a.type),
    field(ui, 'Agent id', a.id),
    field(ui, 'Model', info?.model ?? 'unknown'),
    field(ui, 'Mode', info === undefined ? 'unknown' : info.background ? 'background' : 'foreground'),
    field(ui, 'Parent', a.parentId === undefined ? 'main session' : parent ? parent.name || parent.type : a.parentId),
    field(ui, 'Started', fmt(a.startedAt)),
    field(ui, 'Duration', elapsed(end - a.startedAt)),
    field(ui, 'Tool calls', info === undefined ? '0' : `${info.tools}${info.lastTool ? ` (last: ${info.lastTool})` : ''}`),
    heading(ui, 'Task', 'permission'),
    <ui.Text>{a.description || 'No description.'}</ui.Text>,
    heading(ui, 'Prompt (why it ran)', 'permission'),
    info?.prompt ? (
      <ui.Markdown text={info.prompt} />
    ) : (
      <ui.Text dimColor>Not captured: it started before the dashboard was loaded.</ui.Text>
    ),
    heading(ui, 'Final report', 'permission'),
    info?.result ? (
      <ui.Markdown text={info.result} />
    ) : (
      <ui.Text dimColor>{isLive(a.status) ? 'Still working…' : 'No report captured.'}</ui.Text>
    ),
  ])
}

function detail(s: Snapshot, ui: Ui, acts: Handlers) {
  const [kind, ...rest] = s.selected.split(':')
  const id = rest.join(':')
  const task = kind === 'task' ? s.tasks.find(t => t.id === id) : undefined
  const agent = kind === 'agent' ? s.agents.find(a => a.id === id) : undefined
  if (task) return taskDetail(s, ui, acts, task)
  if (agent) return agentDetail(s, ui, acts, agent)

  return frame(ui, s, acts, 'subtle', 'Not tracked', [
    <ui.Text dimColor>This item is no longer in the dashboard's history.</ui.Text>,
  ])
}

export function dashboard(ui: Ui, s: Snapshot, acts: Handlers) {
  const { Box, Text, Button } = ui

  return (
    <Box flexDirection="column">
      {header(s, ui)}
      {s.selected !== '' ? (
        detail(s, ui, acts)
      ) : (
        WIDGETS.map(w => {
          const isOpen = !s.collapsed.includes(w.id)

          return (
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor={isOpen ? w.accent : 'subtle'}
              paddingX={1}
            >
              <Box flexDirection="row" gap={1}>
                <Button
                  plain
                  key={`toggle-${w.id}`}
                  label={`${isOpen ? '▾' : '▸'} ${w.title}`}
                  onPress={() => acts.toggle(w.id)}
                />
                <Text dimColor>{`(${w.count(s)})`}</Text>
              </Box>
              {isOpen && w.render(s, ui, acts)}
            </Box>
          )
        })
      )}
    </Box>
  )
}
