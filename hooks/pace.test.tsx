import { expect, mock, test } from 'claude-code/testing'

import { barSvg, formatDuration, formatReset, fromAppUsage, fromRateLimits, mergeWindows, paceOf } from './pace'

const HOUR = 3_600_000
const NOW = Date.parse('2026-11-04T12:00:00.000Z')

const fiveHour = (percentUsed: number, hoursLeft: number) => ({
  id: 'five_hour',
  label: '5-hour limit',
  percentUsed,
  lengthMs: 5 * HOUR,
  resetsAt: new Date(NOW + hoursLeft * HOUR).toISOString(),
})

test('usage below the steady line reads as under pace', async () => {
  const pace = paceOf(fiveHour(22, 1), NOW)
  expect(pace?.verdict).toBe('58% under pace')
  expect(pace?.tone).toBe('success')
  expect(pace?.expected).toBe(80)
})

test('usage on the steady line reads as on pace', async () => {
  expect(paceOf(fiveHour(52, 2.5), NOW)?.verdict).toBe('On pace')
})

test('usage above the steady line says when the limit runs out', async () => {
  const pace = paceOf(fiveHour(60, 2.5), NOW)
  expect(pace?.verdict).toBe('10% over pace · runs out in 1h 40m')
  expect(pace?.tone).toBe('warning')
})

test('far over the line turns from warning to error', async () => {
  expect(paceOf(fiveHour(80, 2.5), NOW)?.tone).toBe('error')
})

test('a window that just started gives no verdict on pace', async () => {
  expect(paceOf(fiveHour(4, 4.9), NOW)?.verdict).toBe('Window just started')
})

test('a full window reads as limit reached', async () => {
  expect(paceOf(fiveHour(100, 2), NOW)?.verdict).toBe('Limit reached')
})

test('an unknown window or missing reset has no pace', async () => {
  const [spend] = fromRateLimits([{ kind: 'spend_limit', percentUsed: 40 }])
  expect(spend?.label).toBe('Spend limit')
  expect(paceOf(spend!, NOW)).toBeUndefined()

  const [week] = fromRateLimits([{ kind: 'seven_day', percentUsed: 40 }])
  expect(week?.lengthMs).toBe(7 * 24 * HOUR)
  expect(paceOf(week!, NOW)).toBeUndefined()
})

test('durations read like the app does', async () => {
  expect(formatDuration(59 * 60_000)).toBe('59m')
  expect(formatDuration(64 * 60_000)).toBe('1h 4m')
  expect(formatDuration(30 * HOUR)).toBe('1d 6h')
})

test('the app usage payload keeps the per-model weekly window', async () => {
  const body = {
    plan: {
      status: 'ok',
      plan: 'Max',
      windows: [
        { label: '5-hour limit', percentUsed: 22, resetsAt: '2026-11-04T12:39:59.867Z' },
        { label: 'Weekly · Fable', percentUsed: 52, resetsAt: '2026-11-05T17:59:59.867Z' },
      ],
    },
  }
  const parsed = fromAppUsage({ content: [{ type: 'text', text: JSON.stringify(body) }] })
  if ('error' in parsed) throw new Error(parsed.error)
  expect(parsed.plan).toBe('Max')
  expect(parsed.windows.map(window => window.lengthMs)).toEqual([5 * HOUR, 7 * 24 * HOUR])
  expect(parsed.windows.map(window => window.id)).toEqual(['five_hour', 'Weekly · Fable'])

  const unavailable = fromAppUsage({
    content: [{ type: 'text', text: '{"plan":{"status":"unavailable","note":"try again shortly"}}' }],
  })
  expect('error' in unavailable && unavailable.error).toBe('the app reports plan limits unavailable: try again shortly')
  const garbage = fromAppUsage({ content: [{ type: 'text', text: 'nope' }] })
  expect('error' in garbage).toBe(true)
})

test('a limit missing from the newest reading is kept from the last one', async () => {
  const before = [fiveHour(22, 1), weekly('Weekly · Fable', 52, 30)]
  const merged = mergeWindows(before, [weekly('Weekly · all models', 36, 30)], NOW)
  expect(merged.map(window => window.id)).toEqual(['five_hour', 'Weekly · Fable', 'Weekly · all models'])
  expect(merged[0]?.percentUsed).toBe(22)

  // A kept limit whose reset has passed shows as empty, with no reset to count down to.
  const afterReset = mergeWindows([fiveHour(60, -0.5)], [], NOW)
  expect(afterReset[0]?.percentUsed).toBe(0)
  expect(afterReset[0]?.resetsAt).toBeUndefined()

  // A fresh reading of the same limit replaces the kept one.
  const replaced = mergeWindows([fiveHour(60, 1)], [fiveHour(5, 4.9)], NOW)
  expect(replaced).toHaveLength(1)
  expect(replaced[0]?.percentUsed).toBe(5)
})

test('the bar marks headroom in blue and overage in amber', async () => {
  expect(barSvg(20, 50, 40)).toContain('url(#hatch-blue)')
  expect(barSvg(20, 50, 40)).not.toContain('url(#hatch-amber)')
  expect(barSvg(60, 50, 40)).not.toContain('url(#hatch-blue)')
  expect(barSvg(60, undefined, 40)).not.toContain('class="tick"')
  expect(barSvg(60, 50, 40)).toContain('url(#hatch-amber)')
})

const weekly = (label: string, percentUsed: number, hoursLeft: number) => ({
  id: label,
  label,
  percentUsed,
  lengthMs: 7 * 24 * HOUR,
  resetsAt: new Date(NOW + hoursLeft * HOUR).toISOString(),
})

const CHIP = {
  plugin: 'usage-pace',
  component: 'SessionMode',
  requestId: 'session-mode',
  props: { modes: [] },
} as const

const BAND = {
  plugin: 'usage-pace',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 60,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('the chip is a fixed label that opens and closes the details', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('command.register', () => ({ value: { command: 'usage-pace' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('mcp.call', () => {
    throw new Error('no such server')
  })
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { window: 1 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 22, resetsAt: new Date(NOW + HOUR).toISOString() }],
    },
  }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const chip = await $.ui.mount({ ...CHIP, surface })
    expect((await chip.find({ type: 'Text', text: /Pace/ }))?.text).toBe('Pace')

    const band = await $.ui.mount({ ...BAND, surface })
    expect((await band.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')

    await chip.press({ key: 'usage-pace-chip' })
    expect((await band.find({ type: 'Text', text: /under pace/ }))?.text).toBe('58% under pace')
    expect((await band.find({ type: 'Text', text: /Resets/ }))?.text).toBe('Resets in 1h')

    await band.press({ key: 'usage-pace-close' })
    expect((await band.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')

    await chip.unmount()
    await band.unmount()
  }
})

test('the chip keeps the mode labels the engine already shows', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('command.register', () => ({ value: { command: 'usage-pace' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('mcp.call', () => {
    throw new Error('no such server')
  })
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { window: 1 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 22, resetsAt: new Date(NOW + HOUR).toISOString() }],
    },
  }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const chip = await $.ui.mount({ ...CHIP, props: { modes: ['focus', 'memory paused'] }, surface: 'desktop' })
  expect((await chip.find({ type: 'Text', text: /focus/ }))?.text).toBe('focus & memory paused')
  expect((await chip.find({ type: 'Text', text: /Pace/ }))?.text).toBe('Pace')
  await chip.unmount()
})

test('the details use the app usage tool and show the plan', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('command.register', () => ({ value: { command: 'usage-pace' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('mcp.call', () => ({
    value: {
      isError: false,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            plan: {
              status: 'ok',
              plan: 'Max',
              windows: [{ label: 'Weekly · Fable', percentUsed: 52, resetsAt: new Date(NOW + 30 * HOUR).toISOString() }],
            },
          }),
        },
      ],
    },
  }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const chip = await $.ui.mount({ ...CHIP, surface: 'desktop' })
  await chip.press({ key: 'usage-pace-chip' })
  await chip.unmount()

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Plan usage/ }))?.text).toBe('Plan usage pace · Max')
  expect((await ui.find({ type: 'Text', text: /Fable/ }))?.text).toBe('Weekly · Fable')
  await ui.unmount()
})

test('resets read as a countdown in days, hours and minutes', async () => {
  expect(formatReset(fiveHour(22, 1), NOW)).toBe('Resets in 1h')
  expect(formatReset(fiveHour(22, 3.55), NOW)).toBe('Resets in 3h 33m')
  expect(formatReset(weekly('Weekly · all models', 36, 27.2), NOW)).toBe('Resets in 1d 3h 12m')
  expect(formatReset(weekly('Weekly · all models', 36, 48), NOW)).toBe('Resets in 2d')
  expect(formatReset(fiveHour(22, 0.01), NOW)).toBe('Resets in 1m')
  expect(formatReset(fiveHour(22, -1), NOW)).toBe('Resetting')
})

test('the chip label comes from the mod options', { options: { label: 'Usage' } }, async ($, on) => {
  on('command.register', () => ({ value: { command: 'usage-pace' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('mcp.call', () => {
    throw new Error('no such server')
  })
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 1 }, rateLimits: [] } }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const chip = await $.ui.mount({ ...CHIP, surface: 'desktop' })
  expect((await chip.find({ type: 'Text', text: /Usage/ }))?.text).toBe('Usage')
  await chip.unmount()
})

test('a failed app usage call at start does not stop later refreshes from using it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('command.register', () => ({ value: { command: 'usage-pace' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  let calls = 0
  on('mcp.call', () => {
    calls += 1
    if (calls === 1) throw new Error('server not connected yet')
    return {
      value: {
        isError: false,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              plan: {
                status: 'ok',
                plan: 'Max',
                windows: [{ label: 'Weekly · Fable', percentUsed: 52, resetsAt: new Date(NOW + 30 * HOUR).toISOString() }],
              },
            }),
          },
        ],
      },
    }
  })
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { window: 1 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 22, resetsAt: new Date(NOW + HOUR).toISOString() }],
    },
  }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const chip = await $.ui.mount({ ...CHIP, surface: 'desktop' })
  await chip.press({ key: 'usage-pace-chip' })
  await chip.unmount()

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /Fable/ })).toBeUndefined()

  await clock.advance(60_000)
  expect((await band.find({ type: 'Text', text: /Fable/ }))?.text).toBe('Weekly · Fable')
  await band.unmount()
})

test('a limit survives its reset and an unavailable app answer, which is reported', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('command.register', () => ({ value: { command: 'usage-pace' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  let readings = 0
  on('mcp.call', () => {
    readings += 1
    const plan =
      readings === 1
        ? {
            status: 'ok',
            plan: 'Max',
            windows: [
              { label: '5-hour limit', percentUsed: 21, resetsAt: new Date(NOW + 30_000).toISOString() },
              { label: 'Weekly · all models', percentUsed: 4, resetsAt: new Date(NOW + 6 * 24 * HOUR).toISOString() },
              { label: 'Weekly · Fable', percentUsed: 9, resetsAt: new Date(NOW + 6 * 24 * HOUR).toISOString() },
            ],
          }
        : { status: 'unavailable', note: 'could not be read now' }
    return { value: { isError: false, content: [{ type: 'text', text: JSON.stringify({ plan }) }] } }
  })
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { window: 1 },
      rateLimits:
        readings <= 1
          ? [{ kind: 'five_hour', percentUsed: 21, resetsAt: new Date(NOW + 30_000).toISOString() }]
          : [{ kind: 'seven_day', percentUsed: 4, resetsAt: new Date(NOW + 6 * 24 * HOUR).toISOString() }],
    },
  }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const chip = await $.ui.mount({ ...CHIP, surface: 'desktop' })
  await chip.press({ key: 'usage-pace-chip' })
  await chip.unmount()

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /5-hour/ }))?.text).toBe('5-hour limit')
  expect((await band.find({ type: 'Text', text: /Fable/ }))?.text).toBe('Weekly · Fable')

  // Two minutes on: the 5-hour window has reset, the engine no longer lists it, the app has no reading.
  await clock.advance(120_000)
  expect((await band.find({ type: 'Text', text: /5-hour/ }))?.text).toBe('5-hour limit')
  expect((await band.find({ type: 'Text', text: /Fable/ }))?.text).toBe('Weekly · Fable')
  expect((await band.find({ type: 'Text', text: /unavailable/ }))?.text).toBe(
    'Per-model limits unavailable: the app reports plan limits unavailable: could not be read now',
  )
  await band.unmount()
})
