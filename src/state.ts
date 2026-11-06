import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { AgentRecord } from "./supervisor"

export type SupervisorStateFile = {
  version: 1
  parent_id: string
  updated_at: string
  agents: AgentRecord[]
}

export type StateStore = {
  load(parentID: string): Promise<AgentRecord[]>
  save(parentID: string, agents: AgentRecord[]): Promise<void>
  clear?: () => Promise<void>
}

const MAX_ERROR_LENGTH = 240

function safeSegment(value: string) {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120)
  return cleaned || "session"
}

function normalizeRecord(value: unknown): AgentRecord | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.session_id !== "string" || !raw.session_id) return undefined
  if (typeof raw.parent_id !== "string" || !raw.parent_id) return undefined
  const started = typeof raw.started_at === "string" ? raw.started_at : new Date().toISOString()
  const last = typeof raw.last_activity_at === "string" ? raw.last_activity_at : started
  const status = typeof raw.status === "string" ? raw.status : "idle"
  const phase = typeof raw.phase === "string" ? raw.phase : "monitoring"
  const live = typeof raw.live_status === "string" ? raw.live_status : "unknown"
  return {
    session_id: raw.session_id,
    parent_id: raw.parent_id,
    agent: typeof raw.agent === "string" ? raw.agent : "",
    model: typeof raw.model === "string" ? raw.model : "",
    original_prompt: typeof raw.original_prompt === "string" ? raw.original_prompt : "",
    title: typeof raw.title === "string" ? raw.title : "",
    started_at: started,
    last_activity_at: last,
    restart_count:
      typeof raw.restart_count === "number" && Number.isInteger(raw.restart_count) && raw.restart_count >= 0
        ? raw.restart_count
        : 0,
    status: status as AgentRecord["status"],
    phase: phase as AgentRecord["phase"],
    live_status: live as AgentRecord["live_status"],
    recovering: raw.recovering === true,
    busy_ms:
      typeof raw.busy_ms === "number" && Number.isFinite(raw.busy_ms) && raw.busy_ms >= 0 ? raw.busy_ms : 0,
    busy_since:
      typeof raw.busy_since === "number" && Number.isFinite(raw.busy_since) ? raw.busy_since : undefined,
    last_restart_at: typeof raw.last_restart_at === "string" ? raw.last_restart_at : undefined,
    timed_out_at: typeof raw.timed_out_at === "string" ? raw.timed_out_at : undefined,
    error: typeof raw.error === "string" ? raw.error.slice(0, MAX_ERROR_LENGTH) : undefined,
    previous_session_id:
      typeof raw.previous_session_id === "string" ? raw.previous_session_id : undefined,
    replacement_session_id:
      typeof raw.replacement_session_id === "string" ? raw.replacement_session_id : undefined,
  }
}

/**
 * Project-local state store at
 * `.opencode/agents-watcher/<parent-session-id>/agents.json`.
 * The directory (and its .gitignore) is created lazily on the first save.
 */
export function createFileStateStore(projectRoot: string): StateStore {
  const base = join(projectRoot, ".opencode", "agents-watcher")

  function paths(parentID: string) {
    const dir = join(base, safeSegment(parentID))
    return { dir, file: join(dir, "agents.json") }
  }

  return {
    async load(parentID) {
      const { file } = paths(parentID)
      try {
        const text = await readFile(file, "utf8")
        const parsed = JSON.parse(text) as Partial<SupervisorStateFile>
        if (!parsed || !Array.isArray(parsed.agents)) return []
        return parsed.agents.map(normalizeRecord).filter((item): item is AgentRecord => !!item)
      } catch {
        return []
      }
    },

    async save(parentID, agents) {
      const { dir, file } = paths(parentID)
      await mkdir(dir, { recursive: true })
      await writeFile(join(base, ".gitignore"), "*\n", { flag: "wx" }).catch(() => {})

      const payload: SupervisorStateFile = {
        version: 1,
        parent_id: parentID,
        updated_at: new Date().toISOString(),
        agents,
      }
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
      try {
        await rename(temp, file)
      } catch {
        // Windows can refuse to replace an existing file with rename().
        await rm(file, { force: true })
        await rename(temp, file)
      }
    },

    async clear() {
      await rm(base, { recursive: true, force: true })
    },
  }
}
