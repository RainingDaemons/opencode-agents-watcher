import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  DEFAULT_CONFIG,
  MIN_POLL_INTERVAL_MS,
  parseDuration,
  parseMonitorConfig,
  readMonitorConfig,
} from "../src/config"

describe("duration parsing", () => {
  test("parses the documented values", () => {
    expect(parseDuration("30s")).toBe(30_000)
    expect(parseDuration("5m")).toBe(5 * 60_000)
    expect(parseDuration("30m")).toBe(30 * 60_000)
    expect(parseDuration("2h")).toBe(2 * 60 * 60_000)
    expect(parseDuration(" 1.5m ")).toBe(90_000)
    expect(parseDuration("250ms")).toBe(250)
  })

  test("never turns invalid or zero durations into zero", () => {
    for (const value of ["", "30", "m", "-5m", "0s", "0m", "nope", 30, null, undefined, {}]) {
      expect(parseDuration(value)).toBeUndefined()
    }
  })
})

describe("monitor.json parsing", () => {
  test("uses safe defaults when fields are absent", () => {
    const { config, warnings } = parseMonitorConfig({})
    expect(warnings).toEqual([])
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(config.enabled).toBe(false)
    expect(config.pollIntervalMs).toBe(10_000)
    expect(config.maxRestarts).toBe(2)
    expect(config.confirmFirstRestart).toBe(true)
  })

  test("accepts the example configuration", () => {
    const { config, warnings } = parseMonitorConfig({
      enabled: true,
      agents_timeout: "30m",
      poll_interval: "10s",
      timeout_mode: "busy_only",
      restart_mode: "resume",
      max_restarts: 2,
      auto_restart: true,
      confirm_first_restart: false,
    })
    expect(warnings).toEqual([])
    expect(config.enabled).toBe(true)
    expect(config.agentsTimeoutMs).toBe(30 * 60_000)
    expect(config.autoRestart).toBe(true)
  })

  test("invalid values fall back to read-only monitoring", () => {
    const cases = [
      { enabled: true, agents_timeout: "soon" },
      { enabled: true, agents_timeout: "0s" },
      { enabled: true },
      { enabled: true, agents_timeout: "1m", timeout_mode: "sometimes" },
      { enabled: true, agents_timeout: "1m", restart_mode: "fork" },
      { enabled: true, agents_timeout: "1m", max_restarts: -1 },
      { enabled: true, agents_timeout: "1m", max_restarts: 1.5 },
      { enabled: true, agents_timeout: "1m", auto_restart: "yes" },
      { enabled: true, agents_timeout: "1m", confirm_first_restart: 1 },
      { enabled: "true", agents_timeout: "1m" },
    ]

    for (const value of cases) {
      const { config, warnings } = parseMonitorConfig(value)
      expect(warnings.length).toBeGreaterThan(0)
      expect(config.enabled).toBe(false)
    }
  })

  test("enforces the one second poll minimum", () => {
    const { config, warnings } = parseMonitorConfig({
      enabled: true,
      agents_timeout: "1m",
      poll_interval: "50ms",
    })
    expect(warnings).toEqual([])
    expect(config.pollIntervalMs).toBe(MIN_POLL_INTERVAL_MS)
  })

  test("confirm_first_restart defaults to true only when auto_restart is false", () => {
    expect(parseMonitorConfig({ auto_restart: false }).config.confirmFirstRestart).toBe(true)
    expect(parseMonitorConfig({ auto_restart: true }).config.confirmFirstRestart).toBe(false)
  })

  test("rejects non-object JSON", () => {
    expect(parseMonitorConfig(null).config.enabled).toBe(false)
    expect(parseMonitorConfig([]).config.enabled).toBe(false)
    expect(parseMonitorConfig("nope").config.enabled).toBe(false)
  })

  test("file loading is read-only when absent or malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agents-watcher-"))
    try {
      const missing = await readMonitorConfig(dir)
      expect(missing.exists).toBe(false)
      expect(missing.config.enabled).toBe(false)
      expect(missing.warnings).toEqual([])

      await writeFile(join(dir, "monitor.json"), "{ nope", "utf8")
      const malformed = await readMonitorConfig(dir)
      expect(malformed.exists).toBe(true)
      expect(malformed.config.enabled).toBe(false)
      expect(malformed.warnings.length).toBeGreaterThan(0)

      await writeFile(
        join(dir, "monitor.json"),
        JSON.stringify({ enabled: true, agents_timeout: "30m" }),
        "utf8",
      )
      const valid = await readMonitorConfig(dir)
      expect(valid.config.enabled).toBe(true)
      expect(valid.config.agentsTimeoutMs).toBe(30 * 60_000)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("monitor.json resolution order", () => {
  async function withProjectRoot(run: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "agents-watcher-"))
    try {
      await run(root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  async function writeConfig(root: string, relativePath: string, value: unknown): Promise<string> {
    const path = join(root, relativePath)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), "utf8")
    return path
  }

  test("loads .opencode/monitor.json when present", async () => {
    await withProjectRoot(async (root) => {
      const expectedPath = await writeConfig(root, join(".opencode", "monitor.json"), {
        enabled: true,
        agents_timeout: "5m",
        poll_interval: "2s",
        max_restarts: 4,
        auto_restart: true,
      })

      const snapshot = await readMonitorConfig(root)
      expect(snapshot.exists).toBe(true)
      expect(snapshot.path).toBe(expectedPath)
      expect(snapshot.warnings).toEqual([])
      expect(snapshot.config.enabled).toBe(true)
      expect(snapshot.config.agentsTimeoutMs).toBe(5 * 60_000)
      expect(snapshot.config.pollIntervalMs).toBe(2_000)
      expect(snapshot.config.maxRestarts).toBe(4)
      expect(snapshot.config.autoRestart).toBe(true)
    })
  })

  test("falls back to the legacy root monitor.json when .opencode/monitor.json is absent", async () => {
    await withProjectRoot(async (root) => {
      const expectedPath = await writeConfig(root, "monitor.json", {
        enabled: true,
        agents_timeout: "1h",
      })

      const snapshot = await readMonitorConfig(root)
      expect(snapshot.exists).toBe(true)
      expect(snapshot.path).toBe(expectedPath)
      expect(snapshot.warnings).toEqual([])
      expect(snapshot.config.enabled).toBe(true)
      expect(snapshot.config.agentsTimeoutMs).toBe(60 * 60_000)
    })
  })

  test(".opencode/monitor.json takes precedence over the legacy root file", async () => {
    await withProjectRoot(async (root) => {
      const preferredPath = await writeConfig(root, join(".opencode", "monitor.json"), {
        enabled: true,
        agents_timeout: "5m",
      })
      await writeConfig(root, "monitor.json", {
        enabled: true,
        agents_timeout: "2h",
        max_restarts: 9,
      })

      const snapshot = await readMonitorConfig(root)
      expect(snapshot.path).toBe(preferredPath)
      expect(snapshot.config.agentsTimeoutMs).toBe(5 * 60_000)
      expect(snapshot.config.maxRestarts).toBe(2)
    })
  })

  test("does not fall back to a valid legacy file when .opencode/monitor.json is malformed", async () => {
    await withProjectRoot(async (root) => {
      const preferredPath = await writeConfig(root, join(".opencode", "monitor.json"), "{ nope")
      await writeConfig(root, "monitor.json", { enabled: true, agents_timeout: "30m" })

      const snapshot = await readMonitorConfig(root)
      expect(snapshot.exists).toBe(true)
      expect(snapshot.path).toBe(preferredPath)
      expect(snapshot.config.enabled).toBe(false)
      expect(snapshot.warnings.length).toBeGreaterThan(0)
    })
  })

  test("does not fall back to a valid legacy file when .opencode/monitor.json has invalid values", async () => {
    await withProjectRoot(async (root) => {
      const preferredPath = await writeConfig(root, join(".opencode", "monitor.json"), {
        enabled: true,
        agents_timeout: "soon",
      })
      await writeConfig(root, "monitor.json", { enabled: true, agents_timeout: "30m" })

      const snapshot = await readMonitorConfig(root)
      expect(snapshot.exists).toBe(true)
      expect(snapshot.path).toBe(preferredPath)
      expect(snapshot.config.enabled).toBe(false)
      expect(snapshot.warnings.length).toBeGreaterThan(0)
    })
  })

  test("missing both files reports the .opencode path with no warnings", async () => {
    await withProjectRoot(async (root) => {
      const snapshot = await readMonitorConfig(root)
      expect(snapshot.exists).toBe(false)
      expect(snapshot.path).toBe(join(root, ".opencode", "monitor.json"))
      expect(snapshot.warnings).toEqual([])
      expect(snapshot.config.enabled).toBe(false)
      expect(snapshot.config).toEqual(DEFAULT_CONFIG)
    })
  })
})
