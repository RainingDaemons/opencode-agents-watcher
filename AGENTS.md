# AGENTS.md

OpenCode v2 TUI plugin that renders an Agents sidebar with optional subagent supervision. The UI entry point is `src/index.tsx` (Solid.js with the `@opentui/solid` renderer, loaded through `Plugin.define` from `@opencode/plugin/tui`); supervision logic lives in small supporting modules (`src/config.ts`, `src/supervisor.ts`, `src/state.ts`).

## Commands

- Install dependencies: `bun install` (bun is the package manager; no lockfile is committed, versions float within `^` ranges).
- Run focused tests: `bun test` (`test/config.test.ts`, `test/supervisor.test.ts` — pure logic and mocked recovery client).
- Typecheck: `bun run typecheck` (`tsc --noEmit`; the repo has a `tsconfig.json` for this).
- Build the published entry: `bun install` then `bun run build` (writes `dist/index.js` via `script/build.mjs` — the Solid JSX transform from `@opentui/solid/bun-plugin`, with `@opencode/plugin/tui` and runtime specifiers kept external).
- Regenerate logo assets after touching them: `node script/logo.mjs` (writes `assets/logo-dark.svg`, `assets/logo-light.svg`).

## Manual verification (the main test path)

1. Configure the plugin in `opencode.json` (`plugins`: package name or local directory object) or run `opencode plugin add opencode-agents-watcher@0.2.0`, then restart OpenCode (requires opencode >= 2.0.0, per `engines` in package.json). For local source development, v2 discovers directory plugins under `.opencode/plugins/` (for example `.opencode/plugins/agents-watcher/tui.tsx` re-exporting `src/index.tsx`); a configured local path must name a directory.
2. Open a session and press `ctrl+x` then `b` to show the sidebar; check the Agents widget renders and updates.
3. Supervision: copy `monitor.json.example` to `.opencode/monitor.json` (a project-root `monitor.json` is still read as a legacy fallback). Verify disabled/default mode first, then `enabled: true` with `auto_restart: true` or the manual `[restart]` action. State appears under `.opencode/agents-watcher/<parent-session-id>/agents.json`.

## Architecture notes

- Entrypoint is `package.json` `exports["./tui"]` → `src/index.tsx`, whose default export is `Plugin.define({ id: "agents-sidebar", setup(ctx) { ... } })`. Setup registers `ctx.ui.slot({ append: "sidebar.content", ... })` and returns the cleanup function.
- Widget state lives in a `createTracker()` created via `createRoot` *outside* the slot component tree (`src/index.tsx`) so slot re-renders don't reset it. Preserve this structure.
- Data flow: `ctx.data.session` plus `ctx.data.listen`; live status combines `ctx.data.session.status` (`idle`/`running`) with retry/execution events; messages come from `ctx.data.session.message` with lazy `sync()` for pre-TUI sessions.
- Supervision flow: `createSupervisor()` owns an independent timer, reads `.opencode/monitor.json` (legacy root fallback), records busy time from session/message events, persists state, and runs guarded interrupt/prompt recovery through `ctx.client.session.interrupt`, `prompt`, and `create`. Blocking checks use `ctx.data.session.permission` and `ctx.data.session.form`. The tracker feeds sessions into it and increments a signal for UI updates. Keep recovery paths idempotent and capped.
- Supported API line: OpenCode v2 / `@opencode/plugin` `2.x`. Do not add v1 `@opencode-ai/plugin` calls here.

## Gotchas

- Keep the `/** @jsxImportSource @opentui/solid */` pragma at line 1 — the JSX transform depends on it.
- Plugin id `agents-sidebar` intentionally differs from the npm package name `opencode-agents-watcher`; do not rename the id.
- Code uses ES2023 `Array.prototype.findLast` and bare `catch {}` (deliberate API-error swallowing). Keep a modern runtime; don't "clean up" the empty catches.
- npm publish shape: the `./tui` export is a compiled ESM file (`dist/index.js`, with `"type": "module"`). Build with `@opentui/solid >= 0.8.4` (the v2 host bundles a compatible runtime). Keep `@opencode/plugin/tui` bare — OpenCode resolves it at load time. Keep `@opentui/solid*` / `solid-js*` external; `script/build.mjs` bakes the runtime module ids (`opentui:runtime-module:<encoded-spec>`) into the output and leaves the bundle unminified, because the host's import-rewriting regex needs whitespace after `from`/`import` (minified imports are invisible to it and can resolve to solid-js's SSR build).
- When changing the published package, test the npm-load path by patching the cache copy at `~/.cache/opencode/packages/opencode-agents-watcher@latest/node_modules/opencode-agents-watcher` (the loader reuses it without revalidating), or reinstall with `opencode plugin add opencode-agents-watcher@0.2.0` after publishing.
