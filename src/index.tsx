/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { AssistantMessage, Session } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, createRoot, createSignal, For, Show } from "solid-js"
import { DEFAULT_CONFIG, errorMessage, readMonitorConfig } from "./config"
import { createFileStateStore } from "./state"
import {
  createSupervisor,
  type AgentRecord,
  type LiveStatus,
  type SessionDetails,
  type Supervisor,
} from "./supervisor"

type Run = { start: number; end?: number }

const KV_COLLAPSED = "agents_sidebar.collapsed"
const KV_ARCHIVED = "agents_sidebar.show_archived"
const ARCHIVED_PAGE_SIZE = 10

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

type Tracker = {
  active: (parentID: string) => Session[]
  archived: (parentID: string) => Session[]
  run: (sessionID: string) => Run | undefined
  history: (sessionID: string) => History | undefined
  now: () => number
  breathing: () => number
  collapsed: () => boolean
  toggleCollapsed: () => void
  showArchived: () => boolean
  toggleArchived: () => void
  expanded: (sessionID: string, fallback: boolean) => boolean
  toggleExpanded: (sessionID: string, fallback: boolean) => void
  archivedPage: (sessionID: string) => number
  setArchivedPage: (sessionID: string, page: number) => void
  supervision: () => number
  bumpSupervision: () => void
}

type TrackerHooks = {
  onSession?: (session: Session) => void
  onDeleted?: (sessionID: string) => void
}

type History = { ctx?: number; elapsed?: number }

function agentName(session: Session) {
  const hit = session.title.match(/\(@([^\s()]+)\s+subagent\)\s*$/)
  const name = hit?.[1] ?? session.agent ?? "agent"
  return name.length > 10 ? `${name.slice(0, 9)}~` : name
}

function agentDesc(session: Session) {
  const desc = session.title.replace(/\s*\(@[^\s()]+\s+subagent\)\s*$/, "")
  // Keep the metadata row on one line in the narrow sidebar.
  return desc.length > 24 ? `${desc.slice(0, 21)}...` : desc
}

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}m`
  if (value >= 1000) return `${Math.round(value / 1000)}k`
  return `${value}`
}

function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

function formatDurationShort(ms: number) {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms % 1000 === 0) return `${ms / 1000}s`
  return `${Math.round(ms / 1000)}s`
}

function truncate(value: string, length: number) {
  return value.length > length ? `${value.slice(0, length - 1)}~` : value
}

function watchSummary(record: AgentRecord | undefined, config: { maxRestarts: number }) {
  if (!record) return undefined
  const count = `restart ${record.restart_count}/${config.maxRestarts}`
  if (record.status === "timed_out") return `timed out · ${count}`
  if (record.status === "recovering") return `recovering · ${count}`
  if (record.status === "restarted") return `restarted · ${count}`
  if (record.status === "restart_limit") return `restart limit reached · ${count}`
  if (record.status === "failed") return `recovery failed · ${count}`
  if (record.restart_count > 0) return count
  return undefined
}

function toolSummary(part: { tool: string; state: { input: Record<string, unknown> } }) {
  const input = part.state.input ?? {}
  const detail =
    input.command ??
    input.description ??
    input.filePath ??
    input.path ??
    input.pattern ??
    input.query ??
    input.url ??
    ""
  const text = detail ? `${part.tool} ${String(detail)}` : part.tool
  return text.length > 30 ? `${text.slice(0, 29)}~` : text
}

function createTracker(api: TuiPluginApi, hooks: TrackerHooks = {}): Tracker {
  return createRoot((dispose) => {
    const [sessions, setSessions] = createSignal<Record<string, Session>>({})
    const [runs, setRuns] = createSignal<Record<string, Run>>({})
    const [history, setHistory] = createSignal<Record<string, History>>({})
    const hydrated = new Set<string>()
    const [now, setNow] = createSignal(Date.now())
    const [breathing, setBreathing] = createSignal(0)
    const [collapsed, setCollapsed] = createSignal(!!api.kv.get(KV_COLLAPSED, true))
    const [showArchived, setShowArchived] = createSignal(!!api.kv.get(KV_ARCHIVED, false))
    const [expandedMap, setExpandedMap] = createSignal<Record<string, boolean>>({})
    const [archivedPageMap, setArchivedPageMap] = createSignal<Record<string, number>>({})
    const [supervision, setSupervision] = createSignal(0)

    function track(session: Session) {
      if (!session.parentID) return
      setSessions((current) => {
        const prev = current[session.id]
        if (prev && prev.title === session.title && prev.time.updated === session.time.updated) return current
        return { ...current, [session.id]: session }
      })
      hooks.onSession?.(session)
    }

    function isDone(session: Session) {
      const status = api.state.session.status(session.id)
      if (status) return status.type === "idle"
      return now() - session.time.created >= 30_000
    }

    async function hydrate(session: Session) {
      if (hydrated.has(session.id)) return
      hydrated.add(session.id)
      try {
        const res = await api.client.session.messages({ sessionID: session.id, limit: 10 })
        const list = (res.data ?? []) as Array<{ info: AssistantMessage }>
        const assistants = list.map((item) => item.info).filter((item) => item.role === "assistant")
        const withTokens = assistants.findLast((item) => item.tokens && item.tokens.output > 0)
        const ctx = withTokens
          ? withTokens.tokens.input +
            withTokens.tokens.output +
            withTokens.tokens.reasoning +
            withTokens.tokens.cache.read +
            withTokens.tokens.cache.write
          : undefined
        const last = assistants[assistants.length - 1]
        const end = last?.time.completed ?? last?.time.created ?? session.time.updated
        const elapsed = end > session.time.created ? end - session.time.created : undefined
        setHistory((current) => ({ ...current, [session.id]: { ctx, elapsed } }))
      } catch {}
    }

    api.event.on("session.created", (event) => track(event.properties.info))
    api.event.on("session.updated", (event) => track(event.properties.info))
    api.event.on("session.deleted", (event) =>
      setSessions((current) => {
        if (!(event.properties.info.id in current)) return current
        const next = { ...current }
        delete next[event.properties.info.id]
        return next
      }),
    )
    api.event.on("session.deleted", (event) => hooks.onDeleted?.(event.properties.info.id))

    void api.client.session
      .list({})
      .then((res) => {
        for (const session of res.data ?? []) track(session)
      })
      .catch(() => {})

    const timer = setInterval(() => setNow(Date.now()), 1000)
    const breathingTimer = setInterval(() => setBreathing((value) => value + 1), 400)

    createEffect(() => {
      for (const child of Object.values(sessions())) {
        const status = api.state.session.status(child.id)
        const busy = status?.type === "busy" || status?.type === "retry"
        setRuns((current) => {
          const run = current[child.id]
          if (busy && (!run || run.end !== undefined)) return { ...current, [child.id]: { start: Date.now() } }
          if (status?.type === "idle" && run && run.end === undefined)
            return { ...current, [child.id]: { ...run, end: Date.now() } }
          return current
        })
        const settled = status?.type === "idle" || (!status && Date.now() - child.time.created >= 30_000)
        if (settled && api.state.session.messages(child.id).length === 0) void hydrate(child)
      }
    })

    api.lifecycle.onDispose(dispose)

    return {
      active(parentID) {
        return Object.values(sessions())
          .filter((session) => session.parentID === parentID && !isDone(session))
          .sort((a, b) => a.time.created - b.time.created)
      },
      archived(parentID) {
        return Object.values(sessions())
          .filter((session) => session.parentID === parentID && isDone(session))
          .sort((a, b) => (runs()[b.id]?.end ?? b.time.updated) - (runs()[a.id]?.end ?? a.time.updated))
      },
      run(sessionID) {
        return runs()[sessionID]
      },
      history(sessionID) {
        return history()[sessionID]
      },
      now,
      breathing,
      collapsed,
      toggleCollapsed() {
        const next = !collapsed()
        setCollapsed(next)
        api.kv.set(KV_COLLAPSED, next)
      },
      showArchived,
      toggleArchived() {
        const next = !showArchived()
        setShowArchived(next)
        api.kv.set(KV_ARCHIVED, next)
      },
      expanded(sessionID, fallback) {
        return expandedMap()[sessionID] ?? fallback
      },
      toggleExpanded(sessionID, fallback) {
        const next = !(expandedMap()[sessionID] ?? fallback)
        setExpandedMap((current) => ({ ...current, [sessionID]: next }))
      },
      archivedPage(sessionID) {
        const total = Object.values(sessions()).filter(
          (session) => session.parentID === sessionID && isDone(session),
        ).length
        const pages = Math.max(1, Math.ceil(total / ARCHIVED_PAGE_SIZE))
        return Math.min(archivedPageMap()[sessionID] ?? 0, pages - 1)
      },
      setArchivedPage(sessionID, page) {
        const total = Object.values(sessions()).filter(
          (session) => session.parentID === sessionID && isDone(session),
        ).length
        const pages = Math.max(1, Math.ceil(total / ARCHIVED_PAGE_SIZE))
        const clamped = Math.max(0, Math.min(page, pages - 1))
        setArchivedPageMap((current) => ({ ...current, [sessionID]: clamped }))
      },
      supervision,
      bumpSupervision() {
        setSupervision((value) => value + 1)
      },
    }
  })
}

function Agent(props: { api: TuiPluginApi; tracker: Tracker; supervisor: Supervisor; session: Session }) {
  const api = props.api
  const theme = () => api.theme.current
  const watch = createMemo(() => {
    props.tracker.supervision()
    return props.supervisor.record(props.session.id)
  })
  const watchConfig = createMemo(() => {
    props.tracker.supervision()
    return props.supervisor.snapshot().config
  })
  const watchLabel = createMemo(() => watchSummary(watch(), watchConfig()))
  const watchColor = createMemo(() => {
    const status = watch()?.status
    if (status === "failed" || status === "restart_limit") return theme().error
    if (status === "timed_out") return theme().warning
    if (status === "recovering") return theme().accent
    if (status === "restarted") return theme().success
    return theme().textMuted
  })
  const canRestart = createMemo(() => {
    props.tracker.now()
    props.tracker.supervision()
    return props.supervisor.canRestart(props.session.id)
  })
  const status = createMemo(() => api.state.session.status(props.session.id))
  const messages = createMemo(() => api.state.session.messages(props.session.id))
  const lastAssistant = createMemo(() =>
    messages().findLast((item): item is AssistantMessage => item.role === "assistant"),
  )
  const parts = createMemo(() => {
    const last = messages()[messages().length - 1]
    return last ? api.state.part(last.id) : []
  })
  const running = createMemo(() =>
    parts().some(
      (item) => item.type === "tool" && (item.state.status === "running" || item.state.status === "pending"),
    ),
  )
  const tool = createMemo(() => {
    const part = parts().findLast((item) => item.type === "tool")
    return part as { tool: string; state: { status: string; input: Record<string, unknown> } } | undefined
  })
  const state = createMemo(() => {
    const current = status()
    if (current?.type === "retry") return { label: "retry", color: theme().error }
    if (current?.type === "busy") {
      if (running()) return { label: "tool", color: theme().warning }
      return { label: "thinking", color: theme().accent }
    }
    if (lastAssistant()?.finish) return { label: "done", color: theme().textMuted }
    return { label: "idle", color: theme().textMuted }
  })
  const stateAbbr = createMemo(() => {
    const table: Record<string, string> = {
      thinking: "think",
      tool: "tool",
      done: "done",
      idle: "idle",
      retry: "retry",
    }
    return table[state().label] ?? state().label
  })
  const model = createMemo(() => lastAssistant()?.modelID ?? props.session.model?.id ?? "?")
  const ctx = createMemo(() => {
    const item = messages().findLast(
      (x): x is AssistantMessage => x.role === "assistant" && x.tokens.output > 0,
    )
    if (item) {
      return (
        item.tokens.input +
        item.tokens.output +
        item.tokens.reasoning +
        item.tokens.cache.read +
        item.tokens.cache.write
      )
    }
    return props.tracker.history(props.session.id)?.ctx
  })
  const elapsedMs = createMemo(() => {
    const run = props.tracker.run(props.session.id)
    if (run) return (run.end ?? props.tracker.now()) - run.start
    return props.tracker.history(props.session.id)?.elapsed
  })
  const open = createMemo(() => props.tracker.expanded(props.session.id, false))

  // Breathing indicator (ASCII only), driven by the tracker's 1s `now` tick.
  const phase = createMemo(() => props.tracker.breathing() % 4)
  const indicator = createMemo(() => {
    const label = state().label
    if (label === "retry") return phase() % 2 === 0 ? "!" : "."
    if (label === "thinking" || label === "tool") return [".", "o", "O", "o"][phase()]
    return "-"
  })

  function requestRestart() {
    const record = watch()
    if (!record || !props.supervisor.canRestart(record.session_id)) return
    const run = () => {
      void props.supervisor.restart(record.session_id).then((result) => {
        if (!result.ok) {
          api.ui.toast({
            variant: "warning",
            title: "Agents Watcher",
            message: `Restart skipped: ${result.reason ?? "not eligible"}`,
          })
        }
      })
    }

    if (!props.supervisor.snapshot().config.confirmFirstRestart) {
      run()
      return
    }

    const DialogConfirm = api.ui.DialogConfirm
    api.ui.dialog.replace(
      () => (
        <DialogConfirm
          title="Restart agent"
          message={`Restart ${agentName(props.session)} now? The current run will be aborted and resumed from the workspace state.`}
          onConfirm={() => {
            api.ui.dialog.clear()
            run()
          }}
          onCancel={() => api.ui.dialog.clear()}
        />
      ),
      () => {},
    )
  }

  return (
    <box marginBottom={1}>
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <box
          flexDirection="row"
          gap={1}
          onMouseDown={() => props.tracker.toggleExpanded(props.session.id, false)}
        >
          <text fg={state().color}>{indicator()}</text>
          <text fg={theme().text}>
            <b>{stateAbbr()} [{agentName(props.session)}]</b>
          </text>
        </box>
        <box flexDirection="row" gap={1}>
          <Show when={canRestart()}>
            <box onMouseUp={requestRestart}>
              <text fg={theme().warning}>[restart]</text>
            </box>
          </Show>
          <box onMouseDown={() => api.route.navigate("session", { sessionID: props.session.id })}>
            <text fg={theme().primary}>[view]</text>
          </box>
        </box>
      </box>
      <text fg={theme().textMuted}>
        {`  ${agentDesc(props.session)} ${ctx() !== undefined ? formatTokens(ctx()!) : "-"} ${
          elapsedMs() !== undefined ? formatElapsed(elapsedMs()!) : "-"
        }`}
      </text>
      <Show when={watchLabel()}>
        <text fg={watchColor()}>  {watchLabel()}</text>
      </Show>
      <Show when={watch()?.error}>
        <text fg={theme().error}>  {truncate(watch()!.error!, 64)}</text>
      </Show>
      <Show when={open()}>
        <text fg={theme().textMuted}>  model: {model()}</text>
        <text fg={theme().textMuted}>  tool: {tool() ? toolSummary(tool()!) : "-"}</text>
        <text fg={theme().textMuted}>  cost: {money.format(props.session.cost ?? 0)}</text>
      </Show>
    </box>
  )
}

function View(props: { api: TuiPluginApi; tracker: Tracker; supervisor: Supervisor; session_id: string }) {
  const theme = () => props.api.theme.current
  props.supervisor.watchParent(props.session_id)
  const watch = createMemo(() => {
    props.tracker.supervision()
    return props.supervisor.snapshot()
  })
  const watchHeader = createMemo(() => {
    const current = watch()
    if (current.config.enabled) {
      return `watch ${formatDurationShort(current.config.agentsTimeoutMs)} ${current.config.timeoutMode.replace("_", "-")}`
    }
    return undefined
  })
  const active = createMemo(() => props.tracker.active(props.session_id))
  const archived = createMemo(() => props.tracker.archived(props.session_id))
  const total = () => active().length + archived().length
  const archivedTotalPages = createMemo(() => Math.max(1, Math.ceil(archived().length / ARCHIVED_PAGE_SIZE)))
  const archivedPage = createMemo(() => props.tracker.archivedPage(props.session_id))
  const archivedItems = createMemo(() => {
    const start = archivedPage() * ARCHIVED_PAGE_SIZE
    return archived().slice(start, start + ARCHIVED_PAGE_SIZE)
  })

  return (
    <box marginBottom={1}>
      <box flexDirection="row" gap={1} onMouseDown={() => props.tracker.toggleCollapsed()}>
        <text fg={theme().text}>{props.tracker.collapsed() ? "▶" : "▼"}</text>
        <text fg={theme().text}>
          <b>Agents</b>
        </text>
        <text fg={theme().textMuted}>
          {active().length} active {archived().length} done
        </text>
      </box>
      <Show when={watchHeader()}>
        <text fg={theme().textMuted} marginBottom={1}>  {watchHeader()}</text>
      </Show>
      <Show when={watch().warnings.length > 0}>
        <For each={watch().warnings.slice(0, 2)}>
          {(warning) => <text fg={theme().warning}>  ! {truncate(warning, 64)}</text>}
        </For>
      </Show>
      <Show when={!props.tracker.collapsed()}>
        <Show when={total() > 0} fallback={<text fg={theme().textMuted}>No subagents yet</text>}>
          <For each={active()}>
            {(child) => <Agent api={props.api} tracker={props.tracker} supervisor={props.supervisor} session={child} />}
          </For>
          <Show when={archived().length > 0}>
            <box flexDirection="row" gap={1} onMouseDown={() => props.tracker.toggleArchived()}>
              <text fg={theme().textMuted}>{props.tracker.showArchived() ? "▼" : "▶"}</text>
              <text fg={theme().textMuted}>Archived ({archived().length})</text>
            </box>
            <Show when={props.tracker.showArchived()}>
              <For each={archivedItems()}>
                {(child) => <Agent api={props.api} tracker={props.tracker} supervisor={props.supervisor} session={child} />}
              </For>
              <Show when={archivedTotalPages() > 1}>
                <box flexDirection="row" gap={1}>
                  <text
                    fg={archivedPage() > 0 ? theme().primary : theme().textMuted}
                    onMouseDown={() => props.tracker.setArchivedPage(props.session_id, archivedPage() - 1)}
                  >
                    [&lt;]
                  </text>
                  <text fg={theme().textMuted}>
                    {archivedPage() + 1}/{archivedTotalPages()}
                  </text>
                  <text
                    fg={archivedPage() < archivedTotalPages() - 1 ? theme().primary : theme().textMuted}
                    onMouseDown={() => props.tracker.setArchivedPage(props.session_id, archivedPage() + 1)}
                  >
                    [&gt;]
                  </text>
                </box>
              </Show>
            </Show>
          </Show>
        </Show>
      </Show>
    </box>
  )
}

function liveStatus(value: { type: string } | undefined): LiveStatus {
  if (value?.type === "busy" || value?.type === "retry" || value?.type === "idle") return value.type
  return "unknown"
}

const tui: TuiPlugin = async (api) => {
  const projectRoot = api.state.path.worktree || api.state.path.directory || process.cwd()
  let supervisor: Supervisor | undefined

  const tracker = createTracker(api, {
    onSession: (session) => supervisor?.observe(session),
    onDeleted: (sessionID) => supervisor?.remove(sessionID),
  })

  const store = createFileStateStore(projectRoot)

  async function loadDetails(sessionID: string): Promise<SessionDetails | undefined> {
    try {
      const res = await api.client.session.messages({ sessionID })
      const list = (res.data ?? []) as Array<{
        info:
          | { role: "user"; agent: string; model: { providerID: string; modelID: string } }
          | { role: "assistant"; providerID: string; modelID: string; agent?: string }
        parts: Array<{ type: string; text?: string }>
      }>
      const user = list.find((item) => item.info.role === "user")
      const assistant = list.find((item) => item.info.role === "assistant")
      const prompt = user
        ? user.parts
            .filter((part) => part.type === "text" && part.text)
            .map((part) => part.text!)
            .join("\n")
            .trim()
        : ""
      const model =
        user && user.info.role === "user"
          ? `${user.info.model.providerID}/${user.info.model.modelID}`
          : assistant && assistant.info.role === "assistant"
            ? `${assistant.info.providerID}/${assistant.info.modelID}`
            : undefined
      return {
        prompt: prompt ? prompt.slice(0, 8_000) : undefined,
        agent: user?.info.role === "user" ? user.info.agent : undefined,
        model,
      }
    } catch {
      return undefined
    }
  }

  supervisor = createSupervisor({
    config: () => ({
      config: { ...DEFAULT_CONFIG, enabled: false },
      warnings: [],
      exists: false,
      path: `${projectRoot}/.opencode/monitor.json`,
    }),
    reloadConfig: () => readMonitorConfig(projectRoot),
    getStatus: (sessionID) => liveStatus(api.state.session.status(sessionID)),
    isBlocked: (sessionID) =>
      api.state.session.question(sessionID).length > 0 || api.state.session.permission(sessionID).length > 0,
    store,
    loadDetails,
    notify: () => tracker.bumpSupervision(),
    client: {
      async abortSession(sessionID) {
        const res = await api.client.session.abort({ sessionID })
        if (res.error) throw new Error(errorMessage(res.error, "abort failed"))
      },
      async promptSession(sessionID, text, options) {
        const res = await api.client.session.promptAsync({
          sessionID,
          parts: [{ type: "text", text }],
          agent: options?.agent,
          model: options?.model,
        })
        if (res.error) throw new Error(errorMessage(res.error, "recovery prompt failed"))
      },
      async createChildSession(input) {
        const res = await api.client.session.create({
          parentID: input.parentID,
          title: input.title,
          agent: input.agent,
          model: input.model
            ? { id: input.model.modelID, providerID: input.model.providerID }
            : undefined,
        })
        if (res.error) throw new Error(errorMessage(res.error, "could not create replacement session"))
        if (!res.data?.id) throw new Error("could not create replacement session")
        return { id: res.data.id }
      },
    },
  })

  api.event.on("message.part.updated", (event) => supervisor?.activity(event.properties.part.sessionID))
  api.event.on("message.updated", (event) => supervisor?.activity(event.properties.info.sessionID))

  void supervisor.start()

  const unregisterCleanup = api.command?.register(() => [
    {
      title: "Clean Agents Watcher session data",
      value: "aw-cleanup",
      description: "Delete persisted Agents Watcher data for this project",
      category: "Agents Watcher",
      slash: { name: "aw-cleanup" },
      onSelect: () => {
        const DialogConfirm = api.ui.DialogConfirm
        api.ui.dialog.replace(
          () => (
            <DialogConfirm
              title="Clean Agents Watcher data"
              message="Delete all persisted session data from .opencode/agents-watcher?"
              onConfirm={() => {
                api.ui.dialog.clear()
                void supervisor
                  ?.clear()
                  .then(() => {
                    api.ui.toast({
                      variant: "success",
                      title: "Agents Watcher",
                      message: "Persisted session data cleaned.",
                    })
                  })
                  .catch((error) => {
                    api.ui.toast({
                      variant: "error",
                      title: "Agents Watcher",
                      message: `Cleanup failed: ${errorMessage(error, "could not remove session data")}`,
                    })
                  })
              }}
              onCancel={() => api.ui.dialog.clear()}
            />
          ),
          () => {},
        )
      },
    },
  ])

  api.lifecycle.onDispose(() => {
    unregisterCleanup?.()
    supervisor?.dispose()
  })

  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} tracker={tracker} supervisor={supervisor!} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "agents-sidebar",
  tui,
}

export default plugin
