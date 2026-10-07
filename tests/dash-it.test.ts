import { describe, expect, mock, test } from 'claude-code/testing'

import {
  addTask,
  elapsed,
  endTask,
  reconcileAgents,
  reconcileTasks,
  shimmer,
  spark,
  timelineBar,
  truncate,
} from '../hooks/model'

describe('model', () => {
  test('reconcileTasks adds in-flight work and ends what vanished', async () => {
    const started = reconcileTasks(
      [],
      [
        { id: 'b1', type: 'shell', description: 'tests', command: 'npm test' },
        { id: 'a1', type: 'subagent', description: 'scan' },
      ],
      1000,
    )
    expect(started.map(t => t.id)).toEqual(['b1'])
    expect(started[0]?.label).toBe('npm test')

    const ended = reconcileTasks(started, [], 5000)
    expect(ended[0]).toMatchObject({ status: 'ended', endedAt: 5000 })
  })

  test('endTask only ends running tasks and addTask dedupes', async () => {
    const task = {
      id: 't',
      kind: 'shell',
      label: 'x',
      status: 'running' as const,
      startedAt: 0,
    }
    const once = addTask(addTask([], task), task)
    expect(once).toHaveLength(1)
    const killed = endTask(once, 't', 'killed', 9)
    expect(killed[0]?.status).toBe('killed')
    expect(endTask(killed, 't', 'ended', 10)[0]?.endedAt).toBe(9)
  })

  test('reconcileAgents reports starts and ends', async () => {
    const seen = [{ id: 'g', type: 'Explore', description: 'look', status: 'running' }]
    const [first, startNotes] = reconcileAgents([], seen, 100)
    expect(startNotes).toEqual(['agent started: Explore'])
    const [second, endNotes] = reconcileAgents(first, [], 200)
    expect(endNotes).toEqual(['agent ended: Explore'])
    expect(second[0]?.endedAt).toBe(200)
  })

  test('a task that reappears in flight runs again', async () => {
    const flight = [{ id: 'b1', type: 'shell', description: 'x', command: 'x' }]
    const ended = reconcileTasks(reconcileTasks([], flight, 0), [], 10)
    expect(ended[0]?.status).toBe('ended')
    const back = reconcileTasks(ended, flight, 20)
    expect(back[0]).toMatchObject({ status: 'running', endedAt: undefined })
  })

  test('reconcileAgents refreshes fields and notes a failure', async () => {
    const run = { id: 'g', type: 'Explore', description: 'look', status: 'running' }
    const [first] = reconcileAgents([], [run], 0)
    const [next, notes] = reconcileAgents(
      first ?? [],
      [{ ...run, name: 'scout', status: 'failed' }],
      50,
    )
    expect(next[0]).toMatchObject({ name: 'scout', status: 'failed', endedAt: 50 })
    expect(notes).toEqual(['agent failed: scout'])
  })

  test('visual helpers stay inside their cells', async () => {
    expect(spark([0, 2, 4], 6)).toHaveLength(6)
    expect(shimmer(0, 8)).toHaveLength(8)
    expect(truncate('abcdefghij', 5)).toBe('abcd…')
    const bar = timelineBar(0, 100, 0, 100, 20)
    expect(bar.before + bar.run + bar.after).toBe(20)
    expect(timelineBar(99, 100, 0, 100, 20).run).toBeGreaterThan(0)
  })

  test('elapsed formats seconds, minutes and hours', async () => {
    expect(elapsed(4000)).toBe('4s')
    expect(elapsed(125000)).toBe('2m 5s')
    expect(elapsed(3_900_000)).toBe('1h 5m')
  })
})

describe('dashboard', () => {
  test('a Stop event feeds the pane and a header toggles collapse', async ($, on) => {
    mock.clock(on)
    on('classic.Stop', () => ({}))
    on('agent.list', () => [] as never)
    await $.classic.Stop({
      stop_hook_active: false,
      background_tasks: [
        { id: 'b1', type: 'shell', status: 'running', description: 'run tests', command: 'npm test' },
      ],
      session_crons: [],
    })
    const pane = {
      title: 'Dashboard',
      isFocused: false,
      bodyColumns: 60,
      placement: 'inline',
      scroll: {},
      view: {},
    } as never
    const ui = await $.ui.mount({
      plugin: 'dash-it',
      surface: 'terminal',
      component: 'Pane',
      props: pane,
      requestId: 'dash-it',
    })
    expect(await ui.find({ type: 'Text', text: /^shell: npm test/ })).toBeDefined()
    expect(await ui.find({ key: 'toggle-shells' })).toBeDefined()
    await ui.press({ key: 'toggle-shells' })
    expect(await ui.find({ type: 'Text', text: /^shell: npm test/ })).toBeUndefined()
    await ui.press({ key: 'toggle-shells' })
    expect(await ui.find({ type: 'Text', text: /^shell: npm test/ })).toBeDefined()
  })

  test('a background Bash call lands on the pane and TaskStop kills it', async ($, on) => {
    mock.clock(on)
    on('tool.call', { tool: 'Bash' }, () => ({
      result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg1' },
    }) as never)
    on('tool.call', { tool: 'TaskStop' }, () => ({
      result: { message: 'ok', task_id: 'bg1', task_type: 'shell' },
    }) as never)
    await $.tool.call({
      tool: 'Bash',
      command: 'sleep 9',
      description: 'nap',
      run_in_background: true,
    } as never)
    const pane = {
      title: 'Dashboard',
      isFocused: false,
      bodyColumns: 80,
      placement: 'inline',
      scroll: {},
      view: {},
    } as never
    const target = {
      plugin: 'dash-it',
      surface: 'terminal',
      component: 'Pane',
      props: pane,
      requestId: 'dash-it',
    } as const
    const ui = await $.ui.mount(target)
    expect(await ui.find({ type: 'Text', text: /^shell: nap/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✗' })).toBeUndefined()
    await $.tool.call({ tool: 'TaskStop', task_id: 'bg1' } as never)
    expect(await ui.find({ type: 'Text', text: '✗' })).toBeDefined()
  })
})
