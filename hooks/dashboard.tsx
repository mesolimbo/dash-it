import type { Elements } from 'claude-code'

import type { DashAgent, DashCron, DashFeedItem, DashTask } from '../types'
import {
  clockTime,
  elapsed,
  isAgentLive,
  pad,
  shimmer,
  spark,
  spinner,
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
  now: number
  width: number
}

type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

// A widget is one titled card: add an entry to WIDGETS and it shows up.
// `count` is the badge on its header, `render` draws its body from the snapshot.
export type Widget = {
  id: string
  title: string
  accent: string
  count: (s: Snapshot) => number
  render: (s: Snapshot, ui: Ui) => JSX.Element
}

type Item = {
  id: string
  kind: string
  name: string
  status: string
  startedAt: number
  endedAt?: number
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
  })),
  ...s.agents.map(a => ({
    id: a.id,
    kind: 'agent',
    name: a.name || a.type,
    status: a.status,
    startedAt: a.startedAt,
    endedAt: a.endedAt,
  })),
]

const liveCount = (s: Snapshot) => items(s).filter(one => isLive(one.status)).length
const inner = (s: Snapshot) => Math.max(36, s.width - 4)
const empty = (ui: Ui, text: string) => <ui.Text dimColor>{text}</ui.Text>

function workRow(
  ui: Ui,
  s: Snapshot,
  one: { id: string; status: string; startedAt: number; endedAt?: number },
  title: string,
) {
  const { Box, Text } = ui
  const live = isLive(one.status)
  const solid = '▰'.repeat(BAR)

  return (
    <Box flexDirection="row">
      <Text color={tone(one.status)}>{icon(one.status, s.now)}</Text>
      <Text> </Text>
      <Text dimColor={!live}>{pad(title, inner(s) - 4 - BAR - TIME)}</Text>
      <Text> </Text>
      <Text color={tone(one.status)} dimColor={!live}>
        {live ? shimmer(s.now, BAR) : solid}
      </Text>
      <Text> </Text>
      <Text dimColor>{elapsed((one.endedAt ?? s.now) - one.startedAt).padStart(TIME)}</Text>
    </Box>
  )
}

function timeline(s: Snapshot, ui: Ui) {
  const { Box, Text } = ui
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
            <Text>{pad(one.name, label)}</Text>
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
    render: (s, ui) => (
      <ui.Box flexDirection="column">
        {s.tasks.length === 0 && empty(ui, 'No background shells or monitors.')}
        {[...s.tasks]
          .reverse()
          .map(one =>
            workRow(
              ui,
              s,
              one,
              `${one.kind}: ${one.label}${one.detail ? ` · ${one.detail}` : ''}`,
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
    render: (s, ui) => (
      <ui.Box flexDirection="column">
        {s.agents.length === 0 && empty(ui, 'No subagents yet.')}
        {[...s.agents]
          .reverse()
          .map(one => workRow(ui, s, one, `${one.name || one.type}: ${one.description}`))}
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
    render: (s, ui) => (
      <ui.Box flexDirection="column">
        {s.feed.length === 0 && empty(ui, 'Nothing yet.')}
        {[...s.feed]
          .reverse()
          .slice(0, 10)
          .map(one => (
            <ui.Box flexDirection="row" gap={1}>
              <ui.Text dimColor>{clockTime(one.at)}</ui.Text>
              <ui.Text color={feedTone(one.text)}>{truncate(one.text, inner(s) - 10)}</ui.Text>
            </ui.Box>
          ))}
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

export function dashboard(ui: Ui, s: Snapshot, onToggle: (id: string) => void) {
  const { Box, Text, Button } = ui

  return (
    <Box flexDirection="column">
      {header(s, ui)}
      {WIDGETS.map(w => {
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
                onPress={() => onToggle(w.id)}
              />
              <Text dimColor>{`(${w.count(s)})`}</Text>
            </Box>
            {isOpen && w.render(s, ui)}
          </Box>
        )
      })}
    </Box>
  )
}
