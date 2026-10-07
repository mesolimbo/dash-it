export type DashTask = {
  id: string
  kind: string
  label: string
  detail?: string
  status: 'running' | 'ended' | 'killed'
  startedAt: number
  endedAt?: number
  command?: string
  description?: string
}

export type DashAgent = {
  id: string
  name: string
  type: string
  description: string
  status: string
  parentId?: string
  startedAt: number
  endedAt?: number
}

export type DashCron = {
  id: string
  schedule: string
  recurring: boolean
  prompt: string
}

export type DashFeedItem = { at: number; text: string; ref?: string }

export type DashAgentDetail = {
  prompt: string
  model?: string
  background: boolean
  tools: number
  lastTool?: string
  result?: string
}

declare module 'claude-code' {
  interface PluginState {
    'dash-it': {
      tasks: DashTask[]
      agents: DashAgent[]
      crons: DashCron[]
      feed: DashFeedItem[]
      collapsed: string[]
      now: number
      history: number[]
      selected: string
      sync: { requestedAt: number; doneAt: number }
      spawns: Record<string, DashAgentDetail>
    }
  }
}
