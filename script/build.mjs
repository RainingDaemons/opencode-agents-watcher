#!/usr/bin/env bun
// Compiles the package parts for the OpenCode v2 plugin loader:
//   src/server.ts  -> dist/server.js (package export "." — no-op server part)
//   src/index.tsx  -> dist/index.js  (package export "./tui" — sidebar UI)
// Runtime module ids are baked in at build time using the host's scheme
// (`opentui:runtime-module:${encodeURIComponent(spec)}`) — the same ids the
// host itself produces when it transforms a file plugin at load. The baked ids
// must also be listed as `external` so the bundler doesn't try to resolve them.
//
// Keep the output unminified. The host's load-time import-rewriting regex needs
// whitespace after `from`/`import` (`/(from\s+["'])/` in @opentui/core
// runtime-plugin.js), and the bare `@opencode/plugin/tui` specifier is resolved
// by the host at load time rather than baked into a runtime module id.
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const runtimeId = (spec) => `opentui:runtime-module:${encodeURIComponent(spec)}`

const RUNTIME_SPECIFIERS = new Set([
  "@opentui/solid",
  "@opentui/solid/components",
  "@opentui/solid/jsx-runtime",
  "@opentui/solid/jsx-dev-runtime",
  "@opentui/core",
  "@opentui/core/testing",
  "solid-js",
  "solid-js/store",
])

// OpenCode resolves its plugin runtime at load time, so keep these specifiers
// bare instead of bundling (or baking a runtime module id for) them.
const HOST_SPECIFIERS = new Set(["@opencode/plugin", "@opencode/plugin/tui"])

const result = await Bun.build({
  entrypoints: ["./src/index.tsx", "./src/server.ts"],
  outdir: "./dist",
  format: "esm",
  target: "bun",
  minify: false,
  plugins: [
    createSolidTransformPlugin({
      moduleName: runtimeId("@opentui/solid"),
      resolvePath(spec) {
        return RUNTIME_SPECIFIERS.has(spec) ? runtimeId(spec) : null
      },
    }),
  ],
  external: [...RUNTIME_SPECIFIERS, ...HOST_SPECIFIERS, ...[...RUNTIME_SPECIFIERS].map(runtimeId)],
})

if (!result.success) {
  console.error(result.logs)
  process.exit(1)
}
console.log("built:", result.outputs.map((o) => o.path))
