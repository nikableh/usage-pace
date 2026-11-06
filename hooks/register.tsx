import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import { barSvg, barWidth, formatDuration, formatReset, fromAppUsage, fromRateLimits, mergeWindows, paceOf } from './pace'
import type { AppUsage, Tone } from './pace'
import type { PaceWindow, Snapshot } from '../types'

const DEFAULT_LABEL = 'Pace'
const REFRESH_MS = 60_000
const STALE_MS = 3 * REFRESH_MS
const EARLY_RETRIES_MS = [5_000, 15_000, 30_000]
const WARMUP_MS = 45_000

const snapshot = atom({ plugin: 'usage-pace', key: 'snapshot' } as const, { windows: [] } as Snapshot, {
  shape: 'snapshot-1',
})
const isOpen = atom({ plugin: 'usage-pace', key: 'isOpen' } as const, false)

const TONE_COLOR: Record<Exclude<Tone, 'muted'>, 'success' | 'warning' | 'error'> = {
  success: 'success',
  warning: 'warning',
  error: 'error',
}

let timer: Timer | undefined
let startedAt = 0

// Both sources are read on every refresh and merged, the app's reading winning for a limit
// both name: the app alone knows the per-model limits, but its helper is not connected for the
// first seconds of a session and has moments with no reading, and a session outside the desktop
// app has no such helper at all.
const loadApp = async ($: EngineInterface): Promise<AppUsage> => {
  try {
    const result = await $.mcp.call('ccd_session_mgmt', 'get_usage')
    if (result.isError) {
      const text = result.content.map(block => ('text' in block ? block.text : '')).join(' ').trim()
      return { error: text || 'the app reported an error' }
    }
    return fromAppUsage(result)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

const loadEngine = async ($: EngineInterface): Promise<PaceWindow[]> => {
  try {
    return fromRateLimits((await $.session.usage()).rateLimits)
  } catch {
    return []
  }
}

const refresh = async ($: EngineInterface) => {
  const [app, engine] = await Promise.all([loadApp($), loadEngine($)])
  const now = await $.clock.now()
  const fresh = 'error' in app ? engine : [...engine, ...app.windows]
  await update($, snapshot, last => ({
    windows: mergeWindows(last.windows, fresh, now),
    ...('error' in app ? { appError: app.error } : {}),
    ...(!('error' in app) && app.plan ? { plan: app.plan } : last.plan ? { plan: last.plan } : {}),
    at: now,
  }))
}

export const register: Register = (on, options) => {
  const label = typeof options.label === 'string' && options.label.trim() !== '' ? options.label : DEFAULT_LABEL

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-pace',
      description: 'Show or hide plan usage pace above the prompt',
    })
    startedAt = await $.clock.now()
    await refresh($)
    timer?.cancel()
    timer = $.clock.every(REFRESH_MS, () => void refresh($))
    // The app's servers connect a few seconds after the session starts, so the first readings retry early.
    for (const ms of EARLY_RETRIES_MS) $.clock.after(ms, () => void refresh($))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    if (measured.changed.includes('rateLimits')) await refresh($)

    return measured
  })

  on('command.run', { command: 'usage-pace' }, async $ => {
    const shown = await update($, isOpen, value => !value)
    await refresh($)

    return { text: shown ? 'Usage pace shown above the prompt.' : 'Usage pace hidden.' }
  })

  // The chip is a fixed label: the numbers show only once it is pressed.
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" alignItems="center" columnGap="xs">
        {e.props.modes.length > 0 && <Text dimColor>{e.props.modes.join(' & ')}</Text>}
        <Button key="usage-pace-chip" plain onPress={() => update($, isOpen, value => !value)}>
          <Text>{label}</Text>
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isOpen))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const { windows, plan, at, appError } = await read($, snapshot)
    const now = await $.clock.now()
    const isWarming = now - startedAt < WARMUP_MS
    const columns = e.props.bodyColumns

    const barOf = (percentUsed: number, expected: number | undefined) => {
      if (e.surface === 'terminal') {
        const cells = Math.max(10, columns - 2)
        const filled = Math.round((Math.min(100, percentUsed) / 100) * cells)
        return (
          <Text>
            <Text color="suggestion">{'━'.repeat(filled)}</Text>
            <Text dimColor>{'─'.repeat(cells - filled)}</Text>
          </Text>
        )
      }
      const { Svg } = $.ui.resolve(e)
      const alt = `${Math.round(percentUsed)}% used${expected === undefined ? '' : `, pace ${Math.round(expected)}%`}`
      return <Svg source={barSvg(percentUsed, expected, barWidth(columns))} alt={alt} />
    }

    // The band is capped at eleven text lines, so the spacing stays tight enough for three limits without scrolling.
    return (
      <Box flexDirection="column" gap="md" paddingTop="sm" paddingBottom="md">
        {/* The Button carries its own inner padding, so its row gets less on the right than the limits below it. */}
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" paddingLeft="lg" paddingRight="sm">
          <Text size="body" weight="semibold">
            {plan ? `Plan usage pace · ${plan}` : 'Plan usage pace'}
          </Text>
          <Button
            key="usage-pace-close"
            plain
            role="dismiss"
            label="Close"
            onPress={() => update($, isOpen, () => false)}
          />
        </Box>
        {windows.length === 0 && (
          <Box paddingX="lg">
            <Text size="footnote" dimColor>
              {at === undefined || isWarming ? 'Reading plan usage…' : 'No plan limits to show'}
            </Text>
          </Box>
        )}
        {windows.map(window => {
          const pace = paceOf(window, now)
          const reset = formatReset(window, now)

          return (
            <Box flexDirection="column" paddingX="lg">
              <Box flexDirection="row" justifyContent="space-between" columnGap="sm">
                <Text size="footnote">{window.label}</Text>
                <Box flexDirection="row" columnGap="sm">
                  {reset && <Text size="footnote">{reset}</Text>}
                  <Text size="footnote" tabular>
                    {Math.round(window.percentUsed)}%
                  </Text>
                </Box>
              </Box>
              {barOf(window.percentUsed, pace?.expected)}
              {pace && (
                <Box flexDirection="row" justifyContent="space-between" columnGap="sm">
                  {pace.tone === 'muted' ? (
                    <Text size="caption" dimColor>
                      {pace.verdict}
                    </Text>
                  ) : (
                    <Text size="caption" color={TONE_COLOR[pace.tone]}>
                      {pace.verdict}
                    </Text>
                  )}
                  <Text size="caption" tabular>
                    Pace {Math.round(pace.expected)}%
                  </Text>
                </Box>
              )}
            </Box>
          )
        })}
        {appError && !isWarming && (
          <Box paddingX="lg">
            <Text size="caption" dimColor wrap="truncate-end">
              Per-model limits unavailable: {appError}
            </Text>
          </Box>
        )}
        {at !== undefined && now - at >= STALE_MS && (
          <Box paddingX="lg">
            <Text size="caption" dimColor>
              Updated {formatDuration(now - at)} ago
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}
