import { Plugin } from "@opencode/plugin"

// The package is TUI-only, but OpenCode resolves a package's server part first
// when it is listed in `opencode.json`. This no-op server part makes the package
// resolvable, gives it a stable plugin id, and lets one config entry load the
// TUI part from `./tui`.
export default Plugin.define({
  id: "opencode.agents-watcher",
  setup() {},
})
