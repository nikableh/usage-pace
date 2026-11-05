export type PaceWindow = {
  id: string
  label: string
  percentUsed: number
  resetsAt?: string
  lengthMs?: number
}

export type Snapshot = {
  windows: PaceWindow[]
  plan?: string
  at?: number
  appError?: string
}

declare module 'claude-code' {
  interface PluginState {
    'usage-pace': { snapshot: Shaped<Snapshot>; isOpen: boolean }
  }
}
