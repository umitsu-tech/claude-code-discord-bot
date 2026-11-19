import { describe, expect, test } from 'bun:test'
import { agentsEnabled, buildPresence, countWorkingAgents, type Dump } from './presence'

describe('countWorkingAgents', () => {
  test('counts background sessions that are working or blocked', () => {
    const agents = [
      { kind: 'background', state: 'working', status: 'busy' },
      { kind: 'background', state: 'blocked', status: 'waiting' },
      { kind: 'background', state: 'done', status: 'idle' },
      { kind: 'background', state: 'failed' },
      { kind: 'background', state: 'stopped' },
      { kind: 'interactive', status: 'busy' },
      { kind: 'interactive', state: 'working' },
    ]
    expect(countWorkingAgents(agents)).toBe(2)
  })

  test('returns 0 for an empty list and null for output that is not a list', () => {
    expect(countWorkingAgents([])).toBe(0)
    expect(countWorkingAgents({ sessions: [] })).toBeNull()
    expect(countWorkingAgents(null)).toBeNull()
  })

  test('ignores entries that are not objects', () => {
    expect(countWorkingAgents([null, 'background', 3, { kind: 'background', state: 'working' }])).toBe(1)
  })
})

describe('agentsEnabled', () => {
  test('is off unless set to an on value', () => {
    expect(agentsEnabled(undefined)).toBe(false)
    expect(agentsEnabled('')).toBe(false)
    expect(agentsEnabled('off')).toBe(false)
    expect(agentsEnabled('0')).toBe(false)
    for (const v of ['on', 'ON', 'true', 'yes', '1', ' on ']) expect(agentsEnabled(v)).toBe(true)
  })
})

describe('buildPresence', () => {
  const dump: Dump = {
    context_window: { used_percentage: 53, total_input_tokens: 106_000, context_window_size: 200_000 },
    rate_limits: { five_hour: { used_percentage: 46 }, seven_day: { used_percentage: 17 } },
  }

  test('appends the number of working sessions after the usage', () => {
    expect(buildPresence(dump, 2).line1).toBe('ctx 53% · 5h 46% · 7d 17% · 作業 2')
  })

  test('shows nothing extra for 0, unknown, or no argument', () => {
    for (const agents of [0, null, undefined]) {
      expect(buildPresence(dump, agents).line1).toBe('ctx 53% · 5h 46% · 7d 17%')
    }
  })

  test('does not add the count when there is no session dump', () => {
    expect(buildPresence(null, 3).line1).toBe('Claude セッションなし')
  })
})
