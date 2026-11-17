/** @jsxImportSource @opentui/solid */
import type { SessionInfo, SessionMessageAssistant, SessionMessageAssistantTool } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import type { Context as TuiContext } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createRoot, createSignal, For, onCleanup, Show } from "solid-js"
import { DEFAULT_CONFIG, errorMessage, readMonitorConfig } from "./config"
import { createFileStateStore } from "./state"
import {
  createSupervisor,
  type AgentRecord,
  type LiveStatus,
  type ObservedSession,
  type SessionDetails,
  type Supervisor,
} from "./supervisor"

const ARCHIVED_PAGE_SIZE = 10
const ACTIVITY_EVENT = /^session\.(step|text|reasoning|tool|compaction)\./

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

type Tracker = {
  active: (parentID: string) => SessionInfo[]
  archived: (parentID: string) => SessionInfo[]
  session: (sessionID: string) => SessionInfo | undefined
  now: () => number
  breathing: () => number
  revision: () => number
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
  dispose: () => void
}

type TrackerHooks = {
  onSession?: (session: SessionInfo) => void
  onDeleted?: (sessionID: string) => void
}

type Live = {
  get: (sessionID: string) => LiveStatus
  dispose: () => void
}

function agentName(session: SessionInfo) {
  const title = session.title ?? ""
  const hit = title.match(/\(@([^\s()]+)\s+subagent\)\s*$/)
  const name = hit?.[1] ?? session.agent ?? "agent"
  return name.length > 10 ? `${name.slice(0, 9)}~` : name
}

function agentDesc(session: SessionInfo) {
  const desc = (session.title ?? "").replace(/\s*\(@[^\s()]+\s+subagent\)\s*$/, "")
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

function tokenTotal(tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
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

function toolSummary(part: SessionMessageAssistantTool) {
  const input = part.state.input
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
  const detail =
    typeof input === "string"
      ? input
      : (record.command ??
        record.description ??
        record.filePath ??
        record.path ??
        record.pattern ??
        record.query ??
        record.url ??
        "")
  const text = detail ? `${part.name} ${String(detail)}` : part.name
  return text.length > 30 ? `${text.slice(0, 29)}~` : text
}

function createLive(ctx: TuiContext): Live {
  const retry = new Set<string>()
  const running = new Set<string>()
  let disposed = false

  void ctx.client.session
    .active()
    .then((active) => {
      if (disposed) return
      for (const sessionID of Object.keys(active)) running.add(sessionID)
    })
    .catch(() => {})

  const unsubs = [
    ctx.data.on("session.retry.scheduled", (event) => {
      retry.add(event.data.sessionID)
    }),
    ctx.data.on("session.status", (event) => {
      const sessionID = event.data.sessionID
      if (event.data.status.type === "idle") running.delete(sessionID)
      else running.add(sessionID)
      if (event.data.status.type !== "retry") retry.delete(sessionID)
    }),
    ctx.data.on("session.execution.started", (event) => {
      running.add(event.data.sessionID)
    }),
    ctx.data.on("session.execution.succeeded", (event) => {
      running.delete(event.data.sessionID)
      retry.delete(event.data.sessionID)
    }),
    ctx.data.on("session.execution.failed", (event) => {
      running.delete(event.data.sessionID)
      retry.delete(event.data.sessionID)
    }),
    ctx.data.on("session.execution.interrupted", (event) => {
      running.delete(event.data.sessionID)
      retry.delete(event.data.sessionID)
    }),
    ctx.data.on("session.step.started", (event) => {
      running.add(event.data.sessionID)
      retry.delete(event.data.sessionID)
    }),
    ctx.data.on("session.step.ended", (event) => {
      retry.delete(event.data.sessionID)
    }),
  ]

  return {
    get(sessionID) {
      const status = ctx.data.session.status(sessionID)
      if (status === "running" || running.has(sessionID)) return retry.has(sessionID) ? "retry" : "busy"
      return "idle"
    },
    dispose() {
      disposed = true
      for (const unsubscribe of unsubs) unsubscribe()
    },
  }
}

function createTracker(ctx: TuiContext, hooks: TrackerHooks, live: Live): Tracker {
  return createRoot((dispose) => {
    const [revision, setRevision] = createSignal(0)
    const touch = () => setRevision((value) => value + 1)
    const [now, setNow] = createSignal(Date.now())
    const [breathing, setBreathing] = createSignal(0)
    const [supervision, setSupervision] = createSignal(0)
    const [settings, updateSettings] = ctx.storage.store("sidebar", {
      initial: { collapsed: true, showArchived: false },
    })
    const [ui, updateUi] = ctx.storage.memory("ui", {
      initial: { expanded: {} as Record<string, boolean>, archivedPage: {} as Record<string, number> },
    })
    const [bootstrap, setBootstrap] = createSignal<SessionInfo[]>([])
    let disposed = false

    void ctx.client.session
      .list({})
      .then((response) => {
        if (!disposed) setBootstrap(response.data)
      })
      .catch(() => {})

    function sessions() {
      revision()
      const merged = new Map<string, SessionInfo>()
      for (const session of bootstrap()) merged.set(session.id, session)
      for (const session of ctx.data.session.list()) merged.set(session.id, session)
      return [...merged.values()]
    }

    function children(parentID: string) {
      return sessions().filter((session) => session.parentID === parentID)
    }

    function isDone(session: SessionInfo) {
      const status = live.get(session.id)
      if (status === "busy" || status === "retry") return false
      if (session.time.idle !== undefined || session.outcome !== undefined) return true
      return now() - session.time.created >= 30_000
    }

    function doneCount(parentID: string) {
      return children(parentID).filter(isDone).length
    }

    createEffect(() => {
      for (const session of sessions()) {
        if (session.parentID) hooks.onSession?.(session)
      }
    })

    const stopEvents = ctx.data.listen(({ details }) => {
      touch()
      if (details.type === "session.deleted") {
        setBootstrap((current) => current.filter((session) => session.id !== details.data.sessionID))
        hooks.onDeleted?.(details.data.sessionID)
      }
    })

    // Hydrate messages lazily so pre-existing child sessions show their latest
    // activity without syncing every session on every event.
    const synced = new Set<string>()
    createEffect(() => {
      for (const session of sessions()) {
        if (!session.parentID || synced.has(session.id)) continue
        synced.add(session.id)
        void ctx.data.session.message
          .sync(session.id)
          .then(touch)
          .catch(() => {})
      }
    })

    const timer = setInterval(() => setNow(Date.now()), 1000)
    const breathingTimer = setInterval(() => setBreathing((value) => value + 1), 400)

    onCleanup(() => {
      disposed = true
      clearInterval(timer)
      clearInterval(breathingTimer)
      stopEvents()
    })

    return {
      active(parentID) {
        return children(parentID)
          .filter((session) => !isDone(session))
          .sort((left, right) => left.time.created - right.time.created)
      },
      archived(parentID) {
        return children(parentID)
          .filter(isDone)
          .sort((left, right) => (right.time.idle ?? right.time.updated) - (left.time.idle ?? left.time.updated))
      },
      session(sessionID) {
        return sessions().find((session) => session.id === sessionID)
      },
      now,
      breathing,
      revision,
      collapsed() {
        return settings.collapsed
      },
      toggleCollapsed() {
        const next = !settings.collapsed
        void updateSettings((draft) => {
          draft.collapsed = next
        })
      },
      showArchived() {
        return settings.showArchived
      },
      toggleArchived() {
        const next = !settings.showArchived
        void updateSettings((draft) => {
          draft.showArchived = next
        })
      },
      expanded(sessionID, fallback) {
        return ui.expanded[sessionID] ?? fallback
      },
      toggleExpanded(sessionID, fallback) {
        updateUi((draft) => {
          draft.expanded[sessionID] = !(draft.expanded[sessionID] ?? fallback)
        })
      },
      archivedPage(sessionID) {
        const pages = Math.max(1, Math.ceil(doneCount(sessionID) / ARCHIVED_PAGE_SIZE))
        return Math.min(ui.archivedPage[sessionID] ?? 0, pages - 1)
      },
      setArchivedPage(sessionID, page) {
        const pages = Math.max(1, Math.ceil(doneCount(sessionID) / ARCHIVED_PAGE_SIZE))
        const clamped = Math.max(0, Math.min(page, pages - 1))
        updateUi((draft) => {
          draft.archivedPage[sessionID] = clamped
        })
      },
      supervision,
      bumpSupervision() {
        setSupervision((value) => value + 1)
      },
      dispose,
    }
  })
}

function Agent(props: {
  ctx: TuiContext
  tracker: Tracker
  supervisor: Supervisor
  live: Live
  session: SessionInfo
}) {
  const ctx = props.ctx
  const theme = () => ctx.theme
  const session = createMemo(() => {
    props.tracker.revision()
    return props.tracker.session(props.session.id) ?? props.session
  })
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
    if (status === "failed" || status === "restart_limit") return theme().text.feedback.error.base
    if (status === "timed_out") return theme().text.feedback.warning.base
    if (status === "recovering") return theme().text.feedback.info.base
    if (status === "restarted") return theme().text.feedback.success.base
    return theme().text.muted
  })
  const canRestart = createMemo(() => {
    props.tracker.now()
    props.tracker.supervision()
    return props.supervisor.canRestart(props.session.id)
  })
  const status = createMemo(() => {
    props.tracker.revision()
    return props.live.get(props.session.id)
  })
  const messages = createMemo(() => {
    props.tracker.revision()
    return ctx.data.session.message.list(props.session.id)
  })
  const lastAssistant = createMemo(() =>
    messages().findLast((item): item is SessionMessageAssistant => item.type === "assistant"),
  )
  const parts = createMemo(() => lastAssistant()?.content ?? [])
  const running = createMemo(() =>
    parts().some(
      (item) =>
        item.type === "tool" && (item.state.status === "running" || item.state.status === "streaming"),
    ),
  )
  const tool = createMemo(() =>
    parts().findLast((item): item is SessionMessageAssistantTool => item.type === "tool"),
  )
  const state = createMemo(() => {
    const current = status()
    if (current === "retry") return { label: "retry", color: theme().text.feedback.error.base }
    if (current === "busy") {
      if (running()) return { label: "tool", color: theme().text.feedback.warning.base }
      return { label: "thinking", color: theme().text.feedback.info.base }
    }
    if (lastAssistant()?.finish) return { label: "done", color: theme().text.muted }
    return { label: "idle", color: theme().text.muted }
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
  const model = createMemo(() => lastAssistant()?.model.id ?? session().model?.id ?? "?")
  const tokens = createMemo(() => {
    const item = messages().findLast(
      (message): message is SessionMessageAssistant =>
        message.type === "assistant" && (message.tokens?.output ?? 0) > 0,
    )
    return item?.tokens ? tokenTotal(item.tokens) : session().tokens ? tokenTotal(session().tokens) : 0
  })
  const elapsedMs = createMemo(() => {
    const current = session()
    const start = current.time.busy
    if (status() === "busy" || status() === "retry") {
      return props.tracker.now() - (start ?? current.time.created)
    }
    if (start !== undefined && current.time.idle !== undefined && current.time.idle >= start) {
      return current.time.idle - start
    }
    if (current.time.idle !== undefined) return Math.max(0, current.time.idle - current.time.created)
    return undefined
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

  async function requestRestart() {
    const record = watch()
    if (!record || !props.supervisor.canRestart(record.session_id)) return

    if (props.supervisor.snapshot().config.confirmFirstRestart) {
      const confirmed = await ctx.ui.dialog.confirm({
        title: "Restart agent",
        message: `Restart ${agentName(session())} now? The current run will be interrupted and resumed from the workspace state.`,
        label: { confirm: "Restart", cancel: "Cancel" },
      })
      if (!confirmed) return
    }

    const result = await props.supervisor.restart(record.session_id)
    if (!result.ok) {
      ctx.ui.toast.show({
        variant: "warning",
        title: "Agents Watcher",
        message: `Restart skipped: ${result.reason ?? "not eligible"}`,
      })
    }
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
          <text fg={theme().text.base}>
            <b>{stateAbbr()} [{agentName(session())}]</b>
          </text>
        </box>
        <box flexDirection="row" gap={1}>
          <Show when={canRestart()}>
            <box onMouseUp={() => void requestRestart()}>
              <text fg={theme().text.feedback.warning.base}>[restart]</text>
            </box>
          </Show>
          <box onMouseDown={() => ctx.ui.router.navigate({ type: "session", sessionID: props.session.id })}>
            <text fg={theme().text.action.primary.base}>[view]</text>
          </box>
        </box>
      </box>
      <text fg={theme().text.muted}>
        {`  ${agentDesc(session())} ${formatTokens(tokens())} ${
          elapsedMs() !== undefined ? formatElapsed(elapsedMs()!) : "-"
        }`}
      </text>
      <Show when={watchLabel()}>
        <text fg={watchColor()}>  {watchLabel()}</text>
      </Show>
      <Show when={watch()?.error}>
        <text fg={theme().text.feedback.error.base}>  {truncate(watch()!.error!, 64)}</text>
      </Show>
      <Show when={open()}>
        <text fg={theme().text.muted}>  model: {model()}</text>
        <text fg={theme().text.muted}>  tool: {tool() ? toolSummary(tool()!) : "-"}</text>
        <text fg={theme().text.muted}>  cost: {money.format(session().cost ?? 0)}</text>
      </Show>
    </box>
  )
}

function View(props: {
  ctx: TuiContext
  tracker: Tracker
  supervisor: Supervisor
  live: Live
  session_id: string
}) {
  const theme = () => props.ctx.theme
  createEffect(() => {
    props.supervisor.watchParent(props.session_id)
  })
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
        <text fg={theme().text.base}>{props.tracker.collapsed() ? "▶" : "▼"}</text>
        <text fg={theme().text.base}>
          <b>Agents</b>
        </text>
        <text fg={theme().text.muted}>
          {active().length} active {archived().length} done
        </text>
      </box>
      <Show when={watchHeader()}>
        <text fg={theme().text.muted} marginBottom={1}>  {watchHeader()}</text>
      </Show>
      <Show when={watch().warnings.length > 0}>
        <For each={watch().warnings.slice(0, 2)}>
          {(warning) => <text fg={theme().text.feedback.warning.base}>  ! {truncate(warning, 64)}</text>}
        </For>
      </Show>
      <Show when={!props.tracker.collapsed()}>
        <Show when={total() > 0} fallback={<text fg={theme().text.muted}>No subagents yet</text>}>
          <For each={active()}>
            {(child) => (
              <Agent
                ctx={props.ctx}
                tracker={props.tracker}
                supervisor={props.supervisor}
                live={props.live}
                session={child}
              />
            )}
          </For>
          <Show when={archived().length > 0}>
            <box flexDirection="row" gap={1} onMouseDown={() => props.tracker.toggleArchived()}>
              <text fg={theme().text.muted}>{props.tracker.showArchived() ? "▼" : "▶"}</text>
              <text fg={theme().text.muted}>Archived ({archived().length})</text>
            </box>
            <Show when={props.tracker.showArchived()}>
              <For each={archivedItems()}>
                {(child) => (
                  <Agent
                    ctx={props.ctx}
                    tracker={props.tracker}
                    supervisor={props.supervisor}
                    live={props.live}
                    session={child}
                  />
                )}
              </For>
              <Show when={archivedTotalPages() > 1}>
                <box flexDirection="row" gap={1}>
                  <text
                    fg={
                      archivedPage() > 0
                        ? theme().text.action.primary.base
                        : theme().text.muted
                    }
                    onMouseDown={() => props.tracker.setArchivedPage(props.session_id, archivedPage() - 1)}
                  >
                    [&lt;]
                  </text>
                  <text fg={theme().text.muted}>
                    {archivedPage() + 1}/{archivedTotalPages()}
                  </text>
                  <text
                    fg={
                      archivedPage() < archivedTotalPages() - 1
                        ? theme().text.action.primary.base
                        : theme().text.muted
                    }
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

function observed(session: SessionInfo): ObservedSession {
  return {
    id: session.id,
    parentID: session.parentID,
    title: session.title ?? "",
    agent: session.agent,
    time: { created: session.time.created, updated: session.time.updated },
    model: session.model,
  }
}

export default Plugin.define({
  id: "agents-sidebar",
  setup(ctx) {
    const projectRoot =
      ctx.location?.directory ?? ctx.data.location.default().directory ?? process.cwd()
    const live = createLive(ctx)
    let supervisor: Supervisor | undefined

    const tracker = createTracker(
      ctx,
      {
        onSession: (session) => supervisor?.observe(observed(session)),
        onDeleted: (sessionID) => supervisor?.remove(sessionID),
      },
      live,
    )

    const store = createFileStateStore(projectRoot)

    async function loadDetails(sessionID: string): Promise<SessionDetails | undefined> {
      try {
        await ctx.data.session.message.sync(sessionID)
        let list = ctx.data.session.message.list(sessionID)
        if (list.length === 0) {
          const response = await ctx.client.message.list({ sessionID })
          list = response.data
        }
        const user = list.find((item) => item.type === "user")
        const assistant = list.findLast((item) => item.type === "assistant")
        const prompt =
          user && user.type === "user"
            ? user.text.trim()
            : ""
        const model =
          assistant && assistant.type === "assistant"
            ? `${assistant.model.providerID}/${assistant.model.id}`
            : undefined
        const agent =
          assistant && assistant.type === "assistant"
            ? assistant.agent
            : ctx.data.session.get(sessionID)?.agent
        return {
          prompt: prompt ? prompt.slice(0, 8_000) : undefined,
          agent,
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
      getStatus: (sessionID) => live.get(sessionID),
      isBlocked: (sessionID) => {
        const permissions = ctx.data.session.permission.list(sessionID)
        if (permissions && permissions.length > 0) return true
        const forms = ctx.data.session.form.list(sessionID, ctx.location)
        return !!forms && forms.length > 0
      },
      store,
      loadDetails,
      notify: () => tracker.bumpSupervision(),
      client: {
        async abortSession(sessionID) {
          await ctx.client.session.interrupt({ sessionID })
        },
        async promptSession(sessionID, text) {
          await ctx.client.session.prompt({ sessionID, text })
        },
        async createChildSession(input) {
          const session = await ctx.client.session.create({
            parentID: input.parentID,
            title: input.title,
            agent: input.agent,
            model: input.model
              ? { id: input.model.modelID, providerID: input.model.providerID }
              : undefined,
          })
          return { id: session.id }
        },
      },
    })

    for (const session of ctx.data.session.list()) {
      if (session.parentID) supervisor.observe(observed(session))
    }
    void supervisor.start()

    const stopActivity = ctx.data.listen(({ details }) => {
      if (!ACTIVITY_EVENT.test(details.type)) return
      const sessionID = (details.data as { sessionID?: unknown } | undefined)?.sessionID
      if (typeof sessionID === "string") supervisor?.activity(sessionID)
    })

    ctx.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "agents-watcher.cleanup",
          title: "Clean Agents Watcher session data",
          description: "Delete persisted Agents Watcher data for this project",
          group: "Agents Watcher",
          palette: true,
          slash: { name: "aw-cleanup" },
          run: async () => {
            const confirmed = await ctx.ui.dialog.confirm({
              title: "Clean Agents Watcher data",
              message: "Delete all persisted session data from .opencode/agents-watcher?",
              label: { confirm: "Delete", cancel: "Cancel" },
            })
            if (!confirmed) return
            try {
              await supervisor?.clear()
              ctx.ui.toast.show({
                variant: "success",
                title: "Agents Watcher",
                message: "Persisted session data cleaned.",
              })
            } catch (error) {
              ctx.ui.toast.show({
                variant: "error",
                title: "Agents Watcher",
                message: `Cleanup failed: ${errorMessage(error, "could not remove session data")}`,
              })
            }
          },
        },
      ],
    }))

    const unregisterSlot = ctx.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => (
        <View ctx={ctx} tracker={tracker} supervisor={supervisor!} live={live} session_id={sessionID} />
      ),
    })

    return () => {
      unregisterSlot()
      stopActivity()
      supervisor?.dispose()
      tracker.dispose()
      live.dispose()
    }
  },
})
