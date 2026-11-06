import { readFile } from "node:fs/promises"
import { join } from "node:path"

export type TimeoutMode = "busy_only" | "wall_clock"
export type RestartMode = "resume" | "new_session"

export type WatcherConfig = {
  /** Effective supervision switch. Invalid configuration always forces this to false. */
  enabled: boolean
  /** Required when enabled; 30m fallback keeps the read-only UI informative. */
  agentsTimeoutMs: number
  pollIntervalMs: number
  timeoutMode: TimeoutMode
  restartMode: RestartMode
  maxRestarts: number
  autoRestart: boolean
  confirmFirstRestart: boolean
}

export type ConfigSnapshot = {
  config: WatcherConfig
  warnings: string[]
  exists: boolean
  path: string
}

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
export const DEFAULT_POLL_INTERVAL_MS = 10 * 1000
export const MIN_POLL_INTERVAL_MS = 1 * 1000

export const DEFAULT_CONFIG: WatcherConfig = {
  enabled: false,
  agentsTimeoutMs: DEFAULT_TIMEOUT_MS,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  timeoutMode: "busy_only",
  restartMode: "resume",
  maxRestarts: 2,
  autoRestart: false,
  confirmFirstRestart: true,
}

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/i
const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
}

/**
 * Parse a duration such as `30s`, `5m`, `30m`, or `2h`.
 * Returns undefined for anything malformed or non-positive. Invalid durations
 * are never coerced to zero.
 */
export function parseDuration(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined
  const match = value.trim().match(DURATION_PATTERN)
  if (!match) return undefined
  const amount = Number(match[1])
  const multiplier = UNIT_MS[match[2].toLowerCase()]
  if (!Number.isFinite(amount) || amount <= 0 || multiplier === undefined) return undefined
  const ms = amount * multiplier
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

function readBoolean(
  raw: Record<string, unknown>,
  key: string,
  fallback: boolean,
  warnings: string[],
): boolean {
  const value = raw[key]
  if (value === undefined) return fallback
  if (typeof value === "boolean") return value
  warnings.push(`${key} must be a boolean; supervision disabled`)
  return fallback
}

function readStringEnum<Value extends string>(
  raw: Record<string, unknown>,
  key: string,
  allowed: readonly Value[],
  fallback: Value,
  warnings: string[],
): Value {
  const value = raw[key]
  if (value === undefined) return fallback
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as Value
  warnings.push(`${key} must be one of ${allowed.map((item) => `"${item}"`).join(", ")}; supervision disabled`)
  return fallback
}

/**
 * Validate `monitor.json`. Any invalid value produces a warning and an
 * effective read-only configuration; the parsed defaults are kept only so the
 * UI can describe what a valid file would look like.
 */
export function parseMonitorConfig(value: unknown): { config: WatcherConfig; warnings: string[] } {
  const warnings: string[] = []

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      config: { ...DEFAULT_CONFIG, enabled: false },
      warnings: ["monitor.json must contain a JSON object; supervision disabled"],
    }
  }

  const raw = value as Record<string, unknown>
  const enabled = readBoolean(raw, "enabled", false, warnings)

  let agentsTimeoutMs = DEFAULT_TIMEOUT_MS
  if (raw.agents_timeout === undefined) {
    if (enabled) warnings.push("agents_timeout is required when enabled is true; supervision disabled")
  } else {
    const parsed = parseDuration(raw.agents_timeout)
    if (parsed === undefined) {
      warnings.push('agents_timeout must be a positive duration such as "30m"; supervision disabled')
    } else {
      agentsTimeoutMs = parsed
    }
  }

  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
  if (raw.poll_interval === undefined) {
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
  } else {
    const parsed = parseDuration(raw.poll_interval)
    if (parsed === undefined) {
      warnings.push('poll_interval must be a positive duration such as "10s"; supervision disabled')
    } else {
      pollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, parsed)
    }
  }

  const timeoutMode = readStringEnum(raw, "timeout_mode", ["busy_only", "wall_clock"] as const, "busy_only", warnings)
  const restartMode = readStringEnum(raw, "restart_mode", ["resume", "new_session"] as const, "resume", warnings)

  let maxRestarts = 2
  if (raw.max_restarts !== undefined) {
    if (
      typeof raw.max_restarts === "number" &&
      Number.isInteger(raw.max_restarts) &&
      raw.max_restarts >= 0
    ) {
      maxRestarts = raw.max_restarts
    } else {
      warnings.push("max_restarts must be a non-negative integer; supervision disabled")
    }
  }

  const autoRestart = readBoolean(raw, "auto_restart", false, warnings)
  let confirmFirstRestart = !autoRestart
  if (raw.confirm_first_restart !== undefined) {
    if (typeof raw.confirm_first_restart === "boolean") {
      confirmFirstRestart = raw.confirm_first_restart
    } else {
      warnings.push("confirm_first_restart must be a boolean; supervision disabled")
    }
  }

  return {
    config: {
      enabled: enabled && warnings.length === 0,
      agentsTimeoutMs,
      pollIntervalMs,
      timeoutMode,
      restartMode,
      maxRestarts,
      autoRestart,
      confirmFirstRestart,
    },
    warnings,
  }
}

async function readConfigFile(path: string): Promise<ConfigSnapshot> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") {
      return { config: { ...DEFAULT_CONFIG, enabled: false }, warnings: [], exists: false, path }
    }
    return {
      config: { ...DEFAULT_CONFIG, enabled: false },
      warnings: [`Could not read ${path}: ${errorMessage(error)}; supervision disabled`],
      exists: true,
      path,
    }
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return {
      config: { ...DEFAULT_CONFIG, enabled: false },
      warnings: [`${path} is not valid JSON: ${errorMessage(error)}; supervision disabled`],
      exists: true,
      path,
    }
  }

  const parsed = parseMonitorConfig(value)
  return { config: parsed.config, warnings: parsed.warnings, exists: true, path }
}

// `.opencode/monitor.json` wins; the project-root file remains supported so
// existing installations keep working.
export async function readMonitorConfig(projectRoot: string): Promise<ConfigSnapshot> {
  const preferred = await readConfigFile(join(projectRoot, ".opencode", "monitor.json"))
  if (preferred.exists) return preferred

  const legacy = await readConfigFile(join(projectRoot, "monitor.json"))
  return legacy.exists ? legacy : preferred
}

export function errorMessage(error: unknown, fallback = "unknown error"): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  if (error && typeof error === "object") {
    const data = (error as { data?: { message?: unknown } }).data
    if (data && typeof data.message === "string" && data.message) return data.message
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message) return message
  }
  return fallback
}
