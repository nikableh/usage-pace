import type { PaceWindow, Snapshot } from '../types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const FIVE_HOURS = 5 * HOUR
const SEVEN_DAYS = 7 * DAY

const ON_PACE_POINTS = 3
const FAR_OVER_POINTS = 15
// Before this share of a window has passed, one request swings the pace by more than it means.
const TOO_EARLY = 0.05

export type Tone = 'success' | 'warning' | 'error' | 'muted'

export type Pace = {
  expected: number
  delta: number
  verdict: string
  tone: Tone
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value))

export const formatDuration = (ms: number): string => {
  const minutes = Math.max(1, Math.floor(ms / MINUTE))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  return hours % 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${Math.floor(hours / 24)}d`
}

// Days, hours and minutes, each shown only when it is not zero: "1d 3h 12m", "3h", "45m".
export const formatCountdown = (ms: number): string => {
  const minutes = Math.max(1, Math.floor(ms / MINUTE))
  const days = Math.floor(minutes / (24 * 60))
  const hours = Math.floor((minutes % (24 * 60)) / 60)
  const rest = minutes % 60
  const parts = [days && `${days}d`, hours && `${hours}h`, rest && `${rest}m`].filter(Boolean)
  return parts.join(' ')
}

// A countdown rather than the app's clock time, so no date arithmetic is left to the reader.
export const formatReset = (window: PaceWindow, now: number): string | undefined => {
  if (!window.resetsAt) return undefined
  const reset = Date.parse(window.resetsAt)
  if (Number.isNaN(reset)) return undefined
  if (reset <= now) return 'Resetting'
  return `Resets in ${formatCountdown(reset - now)}`
}

export const paceOf = (window: PaceWindow, now: number): Pace | undefined => {
  if (!window.lengthMs || !window.resetsAt) return undefined
  const reset = Date.parse(window.resetsAt)
  if (Number.isNaN(reset)) return undefined

  const start = reset - window.lengthMs
  const elapsed = clamp((now - start) / window.lengthMs, 0, 1)
  const expected = elapsed * 100
  const delta = window.percentUsed - expected
  const points = Math.round(Math.abs(delta))

  if (window.percentUsed >= 100) {
    return { expected, delta, tone: 'error', verdict: 'Limit reached' }
  }
  if (elapsed < TOO_EARLY) {
    return { expected, delta, tone: 'muted', verdict: 'Window just started' }
  }
  if (delta < -ON_PACE_POINTS) {
    return { expected, delta, tone: 'success', verdict: `${points}% under pace` }
  }
  if (delta <= ON_PACE_POINTS) {
    return { expected, delta, tone: 'muted', verdict: 'On pace' }
  }
  const emptyAt = start + (window.lengthMs * elapsed * 100) / window.percentUsed
  return {
    expected,
    delta,
    tone: delta >= FAR_OVER_POINTS ? 'error' : 'warning',
    verdict: `${points}% over pace · runs out in ${formatDuration(emptyAt - now)}`,
  }
}

const LABELS: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: 'Weekly · all models',
}

const lengthOfKind = (kind: string) =>
  kind.startsWith('five_hour') ? FIVE_HOURS : kind.startsWith('seven_day') ? SEVEN_DAYS : undefined

const labelOfKind = (kind: string) => {
  const words = kind.replaceAll('_', ' ')
  return LABELS[kind] ?? words.charAt(0).toUpperCase() + words.slice(1)
}

export const fromRateLimits = (
  limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[],
): PaceWindow[] =>
  limits.map(limit => {
    const lengthMs = lengthOfKind(limit.kind)
    return {
      id: limit.kind,
      label: labelOfKind(limit.kind),
      percentUsed: limit.percentUsed,
      ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
      ...(lengthMs ? { lengthMs } : {}),
    }
  })

const lengthOfLabel = (label: string) =>
  /5.?hour/i.test(label) ? FIVE_HOURS : /week/i.test(label) ? SEVEN_DAYS : undefined

// The same limit gets the same id from both sources, so their readings merge.
const idOfLabel = (label: string) =>
  /5.?hour/i.test(label) ? 'five_hour' : /week/i.test(label) && /all models/i.test(label) ? 'seven_day' : label

type AppResult = {
  structuredContent?: unknown
  content?: readonly { type: string; text?: string }[]
}

export type AppUsage = { windows: PaceWindow[]; plan?: string } | { error: string }

// The app's usage tool also names the per-model weekly limits, which the engine's list may lack.
export const fromAppUsage = (result: AppResult): AppUsage => {
  let body = result.structuredContent
  if (!body) {
    const text = result.content?.find(block => block.type === 'text')?.text
    if (!text) return { error: 'the app answered with no text' }
    try {
      body = JSON.parse(text)
    } catch {
      return { error: 'the app answered with something other than JSON' }
    }
  }

  const plan = (body as { plan?: { status?: string; plan?: string; windows?: unknown; note?: unknown } }).plan
  if (!plan) return { error: 'the app answered without a plan section' }
  if (plan.status !== 'ok') {
    const note = typeof plan.note === 'string' && plan.note.trim() !== '' ? `: ${plan.note.trim()}` : ''
    return { error: `the app reports plan limits ${plan.status ?? 'unknown'}${note}` }
  }
  if (!Array.isArray(plan.windows)) return { error: 'the app answered without a list of limits' }

  const windows: PaceWindow[] = []
  for (const row of plan.windows as { label?: unknown; percentUsed?: unknown; resetsAt?: unknown }[]) {
    if (typeof row.label !== 'string' || typeof row.percentUsed !== 'number') continue
    const lengthMs = lengthOfLabel(row.label)
    windows.push({
      id: idOfLabel(row.label),
      label: row.label,
      percentUsed: row.percentUsed,
      ...(typeof row.resetsAt === 'string' ? { resetsAt: row.resetsAt } : {}),
      ...(lengthMs ? { lengthMs } : {}),
    })
  }
  return { windows, ...(plan.plan ? { plan: plan.plan } : {}) }
}

// A limit the newest readings do not mention is kept from the last ones: the engine has no
// reading for a window right after it resets, and the app's helper has moments with none at all.
// A kept limit whose reset has passed shows as empty until a new reading comes.
export const mergeWindows = (
  previous: readonly PaceWindow[],
  fresh: readonly PaceWindow[],
  now: number,
): PaceWindow[] => {
  const byId = new Map<string, PaceWindow>()
  for (const window of previous) {
    const reset = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN
    if (!Number.isNaN(reset) && reset <= now) {
      const { resetsAt: _dropped, ...rest } = window
      byId.set(window.id, { ...rest, percentUsed: 0 })
    } else {
      byId.set(window.id, window)
    }
  }
  for (const window of fresh) byId.set(window.id, window)
  return [...byId.values()]
}

const BLUE = '#2B7CDF'
const AMBER = '#D9822B'
const CELL_PX = 8
const BAR_TOP = 2
const BAR_HEIGHT = 7
const SVG_HEIGHT = 11
const TICK_WIDTH = 3
const HATCH_STEP = 6

const hatchPattern = (id: string, color: string) =>
  `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${HATCH_STEP}" height="${HATCH_STEP}" patternTransform="rotate(45)">` +
  `<line x1="0" y1="0" x2="0" y2="${HATCH_STEP}" stroke="${color}" stroke-width="2" stroke-opacity="0.75"/></pattern>`

// The theme keys do not reach inside an SVG, so the tick picks its contrast from the color scheme.
export const barWidth =(columns: number) => Math.max(120, columns * CELL_PX)

export const barSvg = (percentUsed: number, expected: number | undefined, width: number): string => {
  const x =(percent: number) => (clamp(percent, 0, 100) / 100) * width
  const used = x(percentUsed)
  const pace = expected === undefined ? undefined : x(expected)

  const segment = (from: number, to: number, fill: string, opacity = 1) =>
    to > from
      ? `<rect x="${from.toFixed(1)}" y="${BAR_TOP}" width="${(to - from).toFixed(1)}" height="${BAR_HEIGHT}" fill="${fill}" fill-opacity="${opacity}"/>`
      : ''

  // The stripes mark the room to fill before the tick, or the stretch past it to slow down for; the rest of the track stays plain.
  const hatched = (from: number, to: number, pattern: string, fill: string) =>
    to > from
      ? segment(from, to, fill, 0.18) +
        `<rect x="${from.toFixed(1)}" y="${BAR_TOP}" width="${(to - from).toFixed(1)}" height="${BAR_HEIGHT}" fill="url(#${pattern})"/>`
      : ''

  const fills =
    pace === undefined
      ? segment(0, used, BLUE)
      : used <= pace
        ? segment(0, used, BLUE) + hatched(used, pace, 'hatch-blue', BLUE)
        : segment(0, pace, BLUE) + hatched(pace, used, 'hatch-amber', AMBER)

  const tick =
    pace === undefined
      ? ''
      : `<rect class="tick" x="${clamp(pace - TICK_WIDTH / 2, 0, width - TICK_WIDTH).toFixed(1)}" y="0" width="${TICK_WIDTH}" height="${SVG_HEIGHT}" rx="1.5"/>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${SVG_HEIGHT}" viewBox="0 0 ${width} ${SVG_HEIGHT}">` +
    `<style>.tick{fill:#1F1F1D;stroke:#FAF9F5;stroke-width:1}@media (prefers-color-scheme:dark){.tick{fill:#FFFFFF;stroke:#262624}}</style>` +
    `<defs>${hatchPattern('hatch-blue', BLUE)}${hatchPattern('hatch-amber', AMBER)}</defs>` +
    `<clipPath id="bar"><rect y="${BAR_TOP}" width="${width}" height="${BAR_HEIGHT}" rx="3.5"/></clipPath>` +
    `<g clip-path="url(#bar)"><rect y="${BAR_TOP}" width="${width}" height="${BAR_HEIGHT}" fill="#888888" fill-opacity="0.14"/>${fills}</g>` +
    `${tick}</svg>`
  )
}
