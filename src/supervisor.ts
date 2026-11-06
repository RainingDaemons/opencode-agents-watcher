import type { ConfigSnapshot, WatcherConfig } from "./config"
import { errorMessage } from "./config"
import type { StateStore } from "./state"

export type LiveStatus = "idle" | "busy" | "retry" | "unknown"
export type WatchStatus =
  | "busy"
  | "retry"
  | "idle"
  | "timed_out"
  | "recovering"
  | "restarted"
  | "failed"
  | "restart_limit"
export type WatchPhase = "monitoring" | "recovering" | "failed" | "limit"

export type AgentRecord = {
  session_id: string
  parent_id: string
  agent: string
  model: string
  original_prompt: string
  title: string
  started_at: string
  last_activity_at: string
  restart_count: number
  status: WatchStatus
  phase: WatchPhase
  live_status: LiveStatus
  recovering: boolean
  busy_ms: number
  busy_since?: number
  last_restart_at?: string
  timed_out_at?: string
  error?: string
  previous_session_id?: string
  replacement_session_id?: string
}

export type ObservedSession = {
  id: string
  parentID?: string
  title: string
  agent?: string
  time: { created: number; updated: number }
  model?: { id?: string }
}

export type SessionDetails = {
  prompt?: string
  agent?: string
  model?: string
}

export type RecoveryClient = {
  abortSession(sessionID: string): Promise<void>
  promptSession(
    sessionID: string,
    text: string,
    options?: { agent?: string; model?: { providerID: string; modelID: string } },
  ): Promise<void>
  createChildSession(input: {
    parentID: string
    title?: string
    agent?: string
    model?: { providerID: string; modelID: string }
  }): Promise<{ id: string }>
}

export type SupervisorDeps = {
  config: () => ConfigSnapshot
  reloadConfig?: () => Promise<ConfigSnapshot>
  getStatus: (sessionID: string) => LiveStatus
  store: StateStore
  client: RecoveryClient
  loadDetails?: (sessionID: string) => Promise<SessionDetails | undefined>
  isBlocked?: (sessionID: string) => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  notify?: () => void
  cancellationGraceMs?: number
}

export type RestartResult = { ok: boolean; reason?: string }

const ABORT_TIMEOUT_MS = 10_000
const PROMPT_TIMEOUT_MS = 15_000
const CREATE_TIMEOUT_MS = 10_000
const MAX_ERROR_LENGTH = 240

export const RESUME_PROMPT = [
  "This subagent exceeded the configured execution timeout and was interrupted.",
  "Resume the assigned task from the current workspace state.",
  "Do not redo completed work.",
  "Inspect the current diff and continue safely.",
  "Return a concise status report when finished.",
].join("\n")

export function buildNewSessionPrompt(originalPrompt: string, attempt: number, max: number): string {
  return [
    originalPrompt,
    "",
    `This is recovery attempt ${attempt} of ${max}.`,
    "The previous session timed out.",
    "Read the current workspace and diff first.",
    "Continue completed work; do not overwrite or duplicate it.",
  ].join("\n")
}

export function recoveryCooldownMs(config: WatcherConfig): number {
  return Math.max(5_000, Math.min(30_000, config.pollIntervalMs * 2))
}

export function activityGraceMs(config: WatcherConfig): number {
  return Math.max(30_000, config.pollIntervalMs * 3)
}

function hasRecentActivity(record: AgentRecord, config: WatcherConfig, nowMs: number): boolean {
  const last = Date.parse(record.last_activity_at)
  if (!Number.isFinite(last)) return false
  return nowMs - last < activityGraceMs(config)
}

export function activeElapsedMs(record: AgentRecord, nowMs: number): number {
  const running =
    record.busy_since !== undefined && (record.live_status === "busy" || record.live_status === "retry")
      ? Math.max(0, nowMs - record.busy_since)
      : 0
  return Math.max(0, record.busy_ms + running)
}

export function timeoutElapsedMs(record: AgentRecord, config: WatcherConfig, nowMs: number): number {
  if (config.timeoutMode === "wall_clock") {
    const started = Date.parse(record.started_at)
    return Number.isFinite(started) ? Math.max(0, nowMs - started) : 0
  }
  return activeElapsedMs(record, nowMs)
}

function cooldownRemaining(record: AgentRecord, config: WatcherConfig, nowMs: number): number {
  if (!record.last_restart_at) return 0
  const last = Date.parse(record.last_restart_at)
  if (!Number.isFinite(last)) return 0
  const cooldown = recoveryCooldownMs(config)
  return Math.max(0, cooldown - Math.max(0, nowMs - last))
}

export function isTimeoutEligible(
  record: AgentRecord,
  config: WatcherConfig,
  live: LiveStatus,
  nowMs: number,
  inFlight = false,
  blocked = false,
): boolean {
  if (!config.enabled) return false
  if (inFlight || record.recovering) return false
  if (record.phase !== "monitoring") return false
  if (live !== "busy" && live !== "retry") return false
  if (blocked) return false
  if (record.restart_count >= config.maxRestarts) return false
  if (cooldownRemaining(record, config, nowMs) > 0) return false
  // A busy agent that is still producing message/activity events is making
  // progress; do not restart it just because it has been thinking for a while.
  if (hasRecentActivity(record, config, nowMs)) return false
  return timeoutElapsedMs(record, config, nowMs) >= config.agentsTimeoutMs
}

export function canManualRestart(
  record: AgentRecord,
  config: WatcherConfig,
  live: LiveStatus,
  nowMs: number,
  inFlight = false,
  blocked = false,
): boolean {
  if (!config.enabled) return false
  if (inFlight || record.recovering) return false
  if (record.phase !== "monitoring") return false
  if (live !== "busy" && live !== "retry") return false
  if (blocked) return false
  if (record.restart_count >= config.maxRestarts) return false
  return cooldownRemaining(record, config, nowMs) === 0
}

export function isRestartLimitReached(
  record: AgentRecord,
  config: WatcherConfig,
  live: LiveStatus,
  nowMs: number,
): boolean {
  if (!config.enabled) return false
  if (record.recovering || record.phase !== "monitoring") return false
  if (live !== "busy" && live !== "retry") return false
  if (record.restart_count < config.maxRestarts) return false
  return timeoutElapsedMs(record, config, nowMs) >= config.agentsTimeoutMs
}

function iso(ms: number) {
  return new Date(ms).toISOString()
}

function clampError(error: unknown) {
  return errorMessage(error).slice(0, MAX_ERROR_LENGTH)
}

function withTimeout<Value>(promise: Promise<Value>, ms: number, label: string): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function parseModel(value: string): { providerID: string; modelID: string } | undefined {
  const index = value.indexOf("/")
  if (index <= 0 || index >= value.length - 1) return undefined
  return { providerID: value.slice(0, index), modelID: value.slice(index + 1) }
}

function promptOptions(record: AgentRecord) {
  const model = parseModel(record.model)
  if (!record.agent && !model) return undefined
  return {
    agent: record.agent || undefined,
    model,
  }
}

type Supervisor = ReturnType<typeof createSupervisor>

export function createSupervisor(deps: SupervisorDeps) {
  const records = new Map<string, AgentRecord>()
  const watchedParents = new Set<string>()
  const loadedParents = new Set<string>()
  const loadingParents = new Map<string, Promise<void>>()
  const hydrated = new Set<string>()
  const inFlight = new Set<string>()
  const dirtyParents = new Set<string>()
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const cancellationGraceMs = deps.cancellationGraceMs ?? 5_000

  let snapshot = deps.config()
  let running = false
  let disposed = false

  function notify() {
    deps.notify?.()
  }

  function markDirty(parentID: string) {
    dirtyParents.add(parentID)
  }

  async function persist(parentID: string) {
    const agents = [...records.values()].filter((record) => record.parent_id === parentID)
    try {
      await deps.store.save(parentID, agents)
    } catch {
      // State persistence must never take down the TUI or interrupt recovery.
    }
  }

  async function persistDirty() {
    if (!snapshot.config.enabled) {
      dirtyParents.clear()
      return
    }
    const parents = [...dirtyParents]
    dirtyParents.clear()
    for (const parentID of parents) await persist(parentID)
  }

  async function loadParent(parentID: string) {
    if (loadedParents.has(parentID)) return
    const existing = loadingParents.get(parentID)
    if (existing) return existing

    const promise = (async () => {
      const persisted = await deps.store.load(parentID)
      for (const record of persisted) {
        if (record.phase === "recovering" || record.recovering) {
          record.phase = "failed"
          record.status = "failed"
          record.recovering = false
          record.error =
            record.error ?? "recovery was interrupted while the watcher was not running; left stopped"
        }

        const current = records.get(record.session_id)
        if (!current) {
          records.set(record.session_id, record)
          continue
        }
        // Counters and recovery context survive config reloads and TUI restarts.
        current.restart_count = Math.max(current.restart_count, record.restart_count)
        current.busy_ms = Math.max(current.busy_ms, record.busy_ms)
        if (
          current.busy_since === undefined &&
          record.busy_since !== undefined &&
          (current.live_status === "busy" || current.live_status === "retry")
        ) {
          current.busy_since = record.busy_since
        }
        if (!current.original_prompt && record.original_prompt) current.original_prompt = record.original_prompt
        if (!current.agent && record.agent) current.agent = record.agent
        if (!current.model && record.model) current.model = record.model
        if (record.last_restart_at && (!current.last_restart_at || record.last_restart_at > current.last_restart_at)) {
          current.last_restart_at = record.last_restart_at
        }
        if (record.timed_out_at && (!current.timed_out_at || record.timed_out_at > current.timed_out_at)) {
          current.timed_out_at = record.timed_out_at
        }
        if (record.error && !current.error) current.error = record.error
        if (record.phase === "failed" && current.phase === "monitoring") {
          current.phase = "failed"
          current.status = "failed"
        }
      }
      loadedParents.add(parentID)
      notify()
    })().finally(() => loadingParents.delete(parentID))

    loadingParents.set(parentID, promise)
    return promise
  }

  async function hydrate(record: AgentRecord) {
    if (hydrated.has(record.session_id) || !deps.loadDetails) return
    hydrated.add(record.session_id)
    try {
      const details = await deps.loadDetails(record.session_id)
      if (!details) return
      let changed = false
      if (details.prompt && !record.original_prompt) {
        record.original_prompt = details.prompt
        changed = true
      }
      if (details.agent && !record.agent) {
        record.agent = details.agent
        changed = true
      }
      if (details.model && !record.model) {
        record.model = details.model
        changed = true
      }
      if (changed) {
        markDirty(record.parent_id)
        notify()
      }
    } catch {
      // Details are optional; recovery will retry loading the prompt.
    }
  }

  function observe(session: ObservedSession) {
    if (!session.parentID || disposed) return
    const nowMs = now()
    let record = records.get(session.id)
    if (!record) {
      const live = deps.getStatus(session.id)
      record = {
        session_id: session.id,
        parent_id: session.parentID,
        agent: session.agent ?? "",
        model: session.model?.id ?? "",
        original_prompt: "",
        title: session.title,
        started_at: iso(session.time.created),
        last_activity_at: iso(Math.max(session.time.created, session.time.updated)),
        restart_count: 0,
        status: live === "busy" || live === "retry" ? live : "idle",
        phase: "monitoring",
        live_status: live,
        recovering: false,
        busy_ms: 0,
        busy_since: live === "busy" || live === "retry" ? nowMs : undefined,
      }
      records.set(session.id, record)
      markDirty(record.parent_id)
      notify()
      if (snapshot.config.enabled) void hydrate(record)
      return
    }

    const updated = Math.max(session.time.created, session.time.updated)
    if (updated > Date.parse(record.last_activity_at)) {
      record.last_activity_at = iso(updated)
    }
    if (session.title) record.title = session.title
    if (session.agent) record.agent = session.agent
    if (session.model?.id) record.model = session.model.id
  }

  function activity(sessionID: string) {
    const record = records.get(sessionID)
    if (!record) return
    record.last_activity_at = iso(now())
  }

  function remove(sessionID: string) {
    const record = records.get(sessionID)
    if (!record) return
    records.delete(sessionID)
    hydrated.delete(sessionID)
    markDirty(record.parent_id)
    notify()
  }

  function syncRecord(record: AgentRecord, live: LiveStatus, nowMs: number): boolean {
    let changed = false
    if (record.live_status !== live) {
      record.live_status = live
      changed = true
    }

    if (live === "busy" || live === "retry") {
      if (record.busy_since === undefined) {
        record.busy_since = nowMs
        changed = true
      }
      if (
        record.phase === "monitoring" &&
        record.status !== "recovering" &&
        record.status !== "timed_out" &&
        record.status !== live
      ) {
        record.status = live
        changed = true
      }
      return changed
    }

    if (record.busy_since !== undefined) {
      record.busy_ms += Math.max(0, nowMs - record.busy_since)
      record.busy_since = undefined
      changed = true
    }
    if (record.phase === "monitoring") {
      if (record.status === "recovering") {
        record.status = "restarted"
        changed = true
      } else if (record.status !== "idle" && record.status !== "timed_out" && record.status !== "restart_limit") {
        record.status = "idle"
        changed = true
      }
    }
    return changed
  }

  async function ensureDetails(record: AgentRecord) {
    if (record.original_prompt) return
    if (!deps.loadDetails) return
    try {
      const details = await deps.loadDetails(record.session_id)
      if (!details) return
      if (details.prompt) record.original_prompt = details.prompt
      if (details.agent && !record.agent) record.agent = details.agent
      if (details.model && !record.model) record.model = details.model
    } catch {
      // Recovery will report a clear failure if the prompt is required.
    }
  }

  async function waitForIdle(sessionID: string) {
    const attempts = Math.max(1, Math.ceil(cancellationGraceMs / 100))
    for (let index = 0; index < attempts; index++) {
      const live = deps.getStatus(sessionID)
      if (live === "idle" || live === "unknown") return
      await sleep(100)
    }
  }

  function finishResume(record: AgentRecord) {
    const nowMs = now()
    const live = deps.getStatus(record.session_id)
    record.restart_count += 1
    record.last_restart_at = iso(nowMs)
    record.last_activity_at = iso(nowMs)
    record.phase = "monitoring"
    record.recovering = false
    record.timed_out_at = undefined
    record.error = undefined
    record.status = "recovering"
    record.live_status = live
    record.busy_ms = 0
    record.busy_since = live === "busy" || live === "retry" ? nowMs : undefined
  }

  function finishNewSession(record: AgentRecord, replacementID: string) {
    const nowMs = now()
    const oldID = record.session_id
    record.restart_count += 1
    record.last_restart_at = iso(nowMs)
    record.last_activity_at = iso(nowMs)
    record.phase = "monitoring"
    record.recovering = false
    record.timed_out_at = undefined
    record.error = undefined
    record.status = "restarted"
    record.live_status = deps.getStatus(oldID)
    record.busy_ms = 0
    record.busy_since = undefined
    record.replacement_session_id = replacementID

    const replacement: AgentRecord = {
      ...record,
      session_id: replacementID,
      status: "recovering",
      phase: "monitoring",
      live_status: deps.getStatus(replacementID),
      started_at: iso(nowMs),
      last_activity_at: iso(nowMs),
      busy_ms: 0,
      busy_since: undefined,
      previous_session_id: oldID,
      replacement_session_id: undefined,
      timed_out_at: undefined,
      error: undefined,
    }
    records.set(replacementID, replacement)
    markDirty(record.parent_id)
  }

  async function recover(record: AgentRecord, manual: boolean): Promise<RestartResult> {
    const config = snapshot.config
    if (!config.enabled) return { ok: false, reason: "supervision disabled" }
    if (inFlight.has(record.session_id)) return { ok: false, reason: "recovery already running" }

    const live = deps.getStatus(record.session_id)
    const blocked = deps.isBlocked?.(record.session_id) ?? false
    const allowed = manual
      ? canManualRestart(record, config, live, now(), false, blocked)
      : isTimeoutEligible(record, config, live, now(), false, blocked)
    if (!allowed) {
      return {
        ok: false,
        reason: blocked ? "agent is waiting for a question or permission" : "agent is not eligible for restart",
      }
    }

    inFlight.add(record.session_id)
    const nowMs = now()
    record.recovering = true
    record.phase = "recovering"
    record.status = "timed_out"
    record.timed_out_at = iso(nowMs)
    record.error = undefined
    markDirty(record.parent_id)
    notify()

    // Persist the timed-out decision before any API call.
    await persist(record.parent_id)

    let replacementID: string | undefined
    try {
      if (live === "idle" || live === "unknown") {
        record.phase = "monitoring"
        record.recovering = false
        record.status = "idle"
        record.busy_since = undefined
        markDirty(record.parent_id)
        notify()
        return { ok: false, reason: "session is already idle" }
      }

      await withTimeout(deps.client.abortSession(record.session_id), ABORT_TIMEOUT_MS, "abort")
      await waitForIdle(record.session_id)

      if (config.restartMode === "new_session") {
        await ensureDetails(record)
        if (!record.original_prompt) {
          throw new Error("original prompt is unavailable; left stopped")
        }
        const created = await withTimeout(
          deps.client.createChildSession({
            parentID: record.parent_id,
            title: record.title || undefined,
            agent: record.agent || undefined,
            model: parseModel(record.model),
          }),
          CREATE_TIMEOUT_MS,
          "create replacement session",
        )
        replacementID = created.id
        const prompt = buildNewSessionPrompt(
          record.original_prompt,
          record.restart_count + 1,
          config.maxRestarts,
        )
        await withTimeout(
          deps.client.promptSession(created.id, prompt, promptOptions(record)),
          PROMPT_TIMEOUT_MS,
          "recovery prompt",
        )
        finishNewSession(record, created.id)
      } else {
        await withTimeout(
          deps.client.promptSession(record.session_id, RESUME_PROMPT, promptOptions(record)),
          PROMPT_TIMEOUT_MS,
          "recovery prompt",
        )
        finishResume(record)
      }

      markDirty(record.parent_id)
      await persist(record.parent_id)
      notify()
      return { ok: true }
    } catch (error) {
      record.recovering = false
      record.phase = "failed"
      record.status = "failed"
      record.error = clampError(error)
      if (replacementID) record.replacement_session_id = replacementID
      markDirty(record.parent_id)
      notify()
      await persist(record.parent_id)
      return { ok: false, reason: record.error }
    } finally {
      inFlight.delete(record.session_id)
      notify()
    }
  }

  async function tick() {
    if (disposed) return

    if (deps.reloadConfig) {
      try {
        const next = await deps.reloadConfig()
        const changed =
          next.config.enabled !== snapshot.config.enabled ||
          next.config.agentsTimeoutMs !== snapshot.config.agentsTimeoutMs ||
          next.config.pollIntervalMs !== snapshot.config.pollIntervalMs ||
          next.config.timeoutMode !== snapshot.config.timeoutMode ||
          next.config.restartMode !== snapshot.config.restartMode ||
          next.config.maxRestarts !== snapshot.config.maxRestarts ||
          next.config.autoRestart !== snapshot.config.autoRestart ||
          next.config.confirmFirstRestart !== snapshot.config.confirmFirstRestart ||
          next.warnings.join("\n") !== snapshot.warnings.join("\n")
        snapshot = next
        if (changed) notify()
      } catch (error) {
        snapshot = {
          ...snapshot,
          config: { ...snapshot.config, enabled: false },
          warnings: [`Could not reload monitor.json: ${clampError(error)}; supervision disabled`],
        }
        notify()
      }
    }

    const config = snapshot.config
    const nowMs = now()
    const candidates: AgentRecord[] = []

    for (const record of [...records.values()]) {
      const live = deps.getStatus(record.session_id)
      if (syncRecord(record, live, nowMs)) markDirty(record.parent_id)

      if (!config.enabled || !watchedParents.has(record.parent_id)) continue
      if (!record.original_prompt) void hydrate(record)

      if (record.phase === "limit" && record.restart_count < config.maxRestarts) {
        record.phase = "monitoring"
        record.status = live === "busy" || live === "retry" ? live : "idle"
        markDirty(record.parent_id)
      }

      if (
        isRestartLimitReached(record, config, live, nowMs) &&
        record.status !== "restart_limit"
      ) {
        record.status = "restart_limit"
        record.phase = "limit"
        markDirty(record.parent_id)
        notify()
        continue
      }

      if (
        isTimeoutEligible(
          record,
          config,
          live,
          nowMs,
          inFlight.has(record.session_id),
          deps.isBlocked?.(record.session_id) ?? false,
        )
      ) {
        candidates.push(record)
      }
    }

    await persistDirty()

    for (const record of candidates) {
      // Every candidate is re-checked inside recover(); two polling cycles can
      // observe the same timed-out agent without starting two operations.
      await recover(record, false)
    }
  }

  async function start() {
    if (running || disposed) return
    running = true
    while (running && !disposed) {
      try {
        await tick()
      } catch {
        // A failing poll must not stop the supervisor timer or crash the TUI.
      }
      await sleep(snapshot.config.pollIntervalMs)
    }
  }

  function stop() {
    running = false
  }

  function dispose() {
    disposed = true
    running = false
  }

  async function clear() {
    records.clear()
    watchedParents.clear()
    loadedParents.clear()
    loadingParents.clear()
    hydrated.clear()
    inFlight.clear()
    dirtyParents.clear()
    await deps.store.clear?.()
    notify()
  }

  function watchParent(parentID: string) {
    if (!parentID) return
    watchedParents.add(parentID)
    if (!loadedParents.has(parentID) && !loadingParents.has(parentID)) void loadParent(parentID)
  }

  function list(parentID: string) {
    return [...records.values()]
      .filter((record) => record.parent_id === parentID)
      .sort((left, right) => left.started_at.localeCompare(right.started_at))
  }

  function record(sessionID: string) {
    return records.get(sessionID)
  }

  function canRestart(sessionID: string): boolean {
    const record = records.get(sessionID)
    if (!record) return false
    return canManualRestart(
      record,
      snapshot.config,
      deps.getStatus(sessionID),
      now(),
      inFlight.has(sessionID),
      deps.isBlocked?.(sessionID) ?? false,
    )
  }

  async function restart(sessionID: string): Promise<RestartResult> {
    const record = records.get(sessionID)
    if (!record) return { ok: false, reason: "agent is not tracked" }
    return recover(record, true)
  }

  return {
    start,
    stop,
    dispose,
    clear,
    tick,
    watchParent,
    observe,
    activity,
    remove,
    list,
    record,
    canRestart,
    restart,
    snapshot: () => snapshot,
    isInFlight: (sessionID: string) => inFlight.has(sessionID),
  }
}

export type { Supervisor }
