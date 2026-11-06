import { describe, expect, test } from "bun:test"
import { DEFAULT_CONFIG, type ConfigSnapshot, type WatcherConfig } from "../src/config"
import {
  activeElapsedMs,
  buildNewSessionPrompt,
  canManualRestart,
  createSupervisor,
  isRestartLimitReached,
  isTimeoutEligible,
  RESUME_PROMPT,
  timeoutElapsedMs,
  type AgentRecord,
  type LiveStatus,
  type SessionDetails,
} from "../src/supervisor"
import type { StateStore } from "../src/state"

const PARENT = "ses_parent"
const CHILD = "ses_child"
const START = 1_000_000

function config(overrides: Partial<WatcherConfig> = {}): WatcherConfig {
  return {
    ...DEFAULT_CONFIG,
    enabled: true,
    agentsTimeoutMs: 30 * 60_000,
    pollIntervalMs: 1_000,
    ...overrides,
  }
}

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    session_id: CHILD,
    parent_id: PARENT,
    agent: "test",
    model: "provider/model",
    original_prompt: "do the work",
    title: "Child (@test subagent)",
    started_at: new Date(START).toISOString(),
    last_activity_at: new Date(START).toISOString(),
    restart_count: 0,
    status: "busy",
    phase: "monitoring",
    live_status: "busy",
    recovering: false,
    busy_ms: 0,
    busy_since: START,
    ...overrides,
  }
}

function memoryStore(initial: AgentRecord[] = []) {
  const data = new Map<string, AgentRecord[]>([[PARENT, initial]])
  const saves: Array<{ parentID: string; agents: AgentRecord[] }> = []
  const store: StateStore = {
    async load(parentID) {
      return (data.get(parentID) ?? []).map((item) => ({ ...item }))
    },
    async save(parentID, agents) {
      const copy = agents.map((item) => ({ ...item }))
      data.set(parentID, copy)
      saves.push({ parentID, agents: copy })
    },
  }
  return { store, saves, data }
}

function harness(options: {
  overrides?: Partial<WatcherConfig>
  status?: LiveStatus
  details?: SessionDetails
  abortError?: unknown
  promptError?: unknown
  replacementID?: string
  blocked?: boolean
} = {}) {
  let nowMs = START
  let status: LiveStatus = options.status ?? "busy"
  const calls = { abort: 0, prompt: 0, create: 0 }
  const prompts: string[] = []
  const promptOptions: unknown[] = []
  const memory = memoryStore()
  const snapshot: ConfigSnapshot = {
    config: config(options.overrides),
    warnings: [],
    exists: true,
    path: "/project/monitor.json",
  }

  const supervisor = createSupervisor({
    config: () => snapshot,
    getStatus: () => status,
    isBlocked: () => options.blocked ?? false,
    store: memory.store,
    now: () => nowMs,
    sleep: async () => {},
    loadDetails: async () => options.details,
    client: {
      async abortSession() {
        calls.abort += 1
        if (options.abortError) throw options.abortError
        status = "idle"
      },
      async promptSession(_sessionID, text, opts) {
        calls.prompt += 1
        prompts.push(text)
        promptOptions.push(opts)
        if (options.promptError) throw options.promptError
      },
      async createChildSession() {
        calls.create += 1
        return { id: options.replacementID ?? "ses_replacement" }
      },
    },
  })

  supervisor.watchParent(PARENT)
  supervisor.observe({
    id: CHILD,
    parentID: PARENT,
    title: "Child (@test subagent)",
    agent: "test",
    model: { id: "provider/model" },
    time: { created: START, updated: START },
  })

  return {
    supervisor,
    calls,
    prompts,
    promptOptions,
    memory,
    snapshot,
    record: () => supervisor.record(CHILD)!,
    advance(ms: number) {
      nowMs += ms
    },
    setStatus(next: LiveStatus) {
      status = next
    },
    now: () => nowMs,
  }
}

describe("timeout accounting", () => {
  test("busy_only uses accumulated busy time", () => {
    const current = record({ busy_ms: 20 * 60_000, busy_since: START })
    expect(activeElapsedMs(current, START + 10 * 60_000)).toBe(30 * 60_000)
    expect(timeoutElapsedMs(current, config(), START + 10 * 60_000)).toBe(30 * 60_000)
  })

  test("wall_clock measures from session creation", () => {
    const current = record({ busy_ms: 0, busy_since: undefined })
    expect(timeoutElapsedMs(current, config({ timeoutMode: "wall_clock" }), START + 31 * 60_000)).toBe(
      31 * 60_000,
    )
    expect(timeoutElapsedMs(current, config({ timeoutMode: "busy_only" }), START + 31 * 60_000)).toBe(0)
  })

  test("eligibility requires busy or retry, monitoring, not recovering, under limit", () => {
    const now = START + 31 * 60_000
    const cfg = config()
    expect(isTimeoutEligible(record(), cfg, "busy", now)).toBe(true)
    expect(isTimeoutEligible(record(), cfg, "retry", now)).toBe(true)
    expect(isTimeoutEligible(record(), cfg, "idle", now)).toBe(false)
    expect(isTimeoutEligible(record(), cfg, "unknown", now)).toBe(false)
    expect(isTimeoutEligible(record({ recovering: true }), cfg, "busy", now)).toBe(false)
    expect(isTimeoutEligible(record({ phase: "failed" }), cfg, "busy", now)).toBe(false)
    expect(isTimeoutEligible(record({ restart_count: 2 }), cfg, "busy", now)).toBe(false)
    expect(isTimeoutEligible(record(), cfg, "busy", now, true)).toBe(false)
    expect(isTimeoutEligible(record(), { ...cfg, enabled: false }, "busy", now)).toBe(false)
    expect(isTimeoutEligible(record(), cfg, "busy", now, false, true)).toBe(false)
  })

  test("recent real activity prevents a thinking agent from being restarted", () => {
    const now = START + 31 * 60_000
    const active = record({ last_activity_at: new Date(now - 1_000).toISOString() })
    expect(isTimeoutEligible(active, config(), "busy", now)).toBe(false)
    expect(isTimeoutEligible(active, config(), "retry", now)).toBe(false)
  })

  test("cooldown prevents an immediate second automatic restart", () => {
    const now = START + 31 * 60_000
    const current = record({ restart_count: 1, last_restart_at: new Date(now - 1_000).toISOString() })
    expect(isTimeoutEligible(current, config(), "busy", now)).toBe(false)
    expect(isTimeoutEligible(current, config(), "busy", now + 10_000)).toBe(true)
  })

  test("manual restart does not require the timeout but is still guarded", () => {
    const cfg = config()
    expect(canManualRestart(record({ busy_ms: 0 }), cfg, "busy", START)).toBe(true)
    expect(canManualRestart(record({ restart_count: 2 }), cfg, "busy", START)).toBe(false)
    expect(canManualRestart(record(), cfg, "idle", START)).toBe(false)
  })

  test("reports restart limit reached only after the timeout elapses", () => {
    const cfg = config({ maxRestarts: 1 })
    expect(isRestartLimitReached(record({ restart_count: 1 }), cfg, "busy", START + 10_000)).toBe(false)
    expect(isRestartLimitReached(record({ restart_count: 1 }), cfg, "busy", START + 31 * 60_000)).toBe(true)
  })
})

describe("recovery prompts", () => {
  test("resume prompt matches the specification", () => {
    expect(RESUME_PROMPT).toContain("Resume the assigned task from the current workspace state.")
    expect(RESUME_PROMPT).toContain("Do not redo completed work.")
    expect(RESUME_PROMPT).toContain("Inspect the current diff and continue safely.")
  })

  test("new-session prompt keeps the original task and adds recovery context", () => {
    const prompt = buildNewSessionPrompt("implement the feature", 1, 2)
    expect(prompt.startsWith("implement the feature\n\n")).toBe(true)
    expect(prompt).toContain("This is recovery attempt 1 of 2.")
    expect(prompt).toContain("The previous session timed out.")
    expect(prompt).toContain("do not overwrite or duplicate it.")
  })
})

describe("supervisor recovery", () => {
  test("abort succeeds and resume succeeds", async () => {
    const h = harness()
    h.advance(31 * 60_000)
    await h.supervisor.tick()

    expect(h.calls).toEqual({ abort: 1, prompt: 1, create: 0 })
    expect(h.prompts[0]).toBe(RESUME_PROMPT)
    expect(h.promptOptions[0]).toEqual({ agent: "test", model: { providerID: "provider", modelID: "model" } })
    const current = h.record()
    expect(current.restart_count).toBe(1)
    expect(current.status).toBe("recovering")
    expect(current.error).toBeUndefined()
    expect(h.memory.saves.some((save) => save.agents.some((item) => item.status === "timed_out"))).toBe(true)
  })

  test("abort succeeds and resume fails", async () => {
    const h = harness({ promptError: new Error("prompt rejected") })
    h.advance(31 * 60_000)
    await h.supervisor.tick()

    expect(h.calls.abort).toBe(1)
    expect(h.calls.prompt).toBe(1)
    const current = h.record()
    expect(current.restart_count).toBe(0)
    expect(current.phase).toBe("failed")
    expect(current.status).toBe("failed")
    expect(current.error).toContain("prompt rejected")
  })

  test("API error during abort is recorded without crashing", async () => {
    const h = harness({ abortError: new Error("session not found") })
    h.advance(31 * 60_000)
    await h.supervisor.tick()

    expect(h.calls.prompt).toBe(0)
    expect(h.record().status).toBe("failed")
    expect(h.record().error).toContain("session not found")
  })

  test("an already idle session is not restarted", async () => {
    const h = harness({ status: "idle" })
    const result = await h.supervisor.restart(CHILD)
    expect(result.ok).toBe(false)
    expect(h.calls).toEqual({ abort: 0, prompt: 0, create: 0 })
  })

  test("a session waiting for a question or permission is not restarted", async () => {
    const h = harness({ blocked: true })
    h.advance(31 * 60_000)
    await h.supervisor.tick()
    expect(h.calls).toEqual({ abort: 0, prompt: 0, create: 0 })
    expect(h.record().status).not.toBe("timed_out")
  })

  test("session disappearing during recovery leaves the agent stopped", async () => {
    const h = harness({ abortError: new Error("NotFound") })
    h.advance(31 * 60_000)
    await h.supervisor.tick()
    expect(h.record().status).toBe("failed")
    expect(h.record().phase).toBe("failed")
    expect(h.calls.prompt).toBe(0)
  })

  test("two polling cycles cannot recover the same session twice", async () => {
    const h = harness()
    h.advance(31 * 60_000)
    await Promise.all([h.supervisor.tick(), h.supervisor.tick()])
    expect(h.calls.abort).toBe(1)
    expect(h.calls.prompt).toBe(1)
    expect(h.record().restart_count).toBe(1)
  })

  test("restart count is capped", async () => {
    const h = harness()
    h.advance(31 * 60_000)
    await h.supervisor.tick()
    expect(h.record().restart_count).toBe(1)

    h.setStatus("busy")
    await h.supervisor.tick()
    h.advance(31 * 60_000)
    await h.supervisor.tick()
    expect(h.record().restart_count).toBe(2)

    h.setStatus("busy")
    await h.supervisor.tick()
    h.advance(31 * 60_000)
    await h.supervisor.tick()
    expect(h.record().restart_count).toBe(2)
    expect(h.record().status).toBe("restart_limit")
    expect(h.calls.abort).toBe(2)
  })

  test("new_session mode creates a replacement with the original prompt plus context", async () => {
    const h = harness({
      overrides: { restartMode: "new_session" },
      details: { prompt: "do the work", agent: "test", model: "provider/model" },
    })
    h.advance(31 * 60_000)
    await h.supervisor.tick()

    expect(h.calls).toEqual({ abort: 1, prompt: 1, create: 1 })
    expect(h.prompts[0]).toContain("do the work")
    expect(h.prompts[0]).toContain("This is recovery attempt 1 of 2.")
    expect(h.record().status).toBe("restarted")
    expect(h.record().replacement_session_id).toBe("ses_replacement")

    const replacement = h.supervisor.record("ses_replacement")!
    expect(replacement.previous_session_id).toBe(CHILD)
    expect(replacement.restart_count).toBe(1)
  })

  test("restart counters survive loading persisted state", async () => {
    const persisted = record({ restart_count: 1, status: "restarted" })
    const memory = memoryStore([persisted])
    const snapshot: ConfigSnapshot = {
      config: config(),
      warnings: [],
      exists: true,
      path: "/project/monitor.json",
    }
    const supervisor = createSupervisor({
      config: () => snapshot,
      getStatus: () => "busy",
      store: memory.store,
      now: () => START + 31 * 60_000,
      sleep: async () => {},
      client: {
        async abortSession() {},
        async promptSession() {},
        async createChildSession() {
          return { id: "ses_new" }
        },
      },
    })
    supervisor.watchParent(PARENT)
    await supervisor.tick()
    expect(supervisor.record(CHILD)?.restart_count).toBe(1)
  })
})
