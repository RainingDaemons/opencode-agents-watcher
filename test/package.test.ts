import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import server from "../src/server"

const root = join(import.meta.dir, "..")
const manifest = (await Bun.file(join(root, "package.json")).json()) as {
  version: string
  exports: Record<string, string>
}

describe("package parts", () => {
  test("exports a server part so opencode.json can resolve the package", () => {
    expect(manifest.exports["."]).toBe("./dist/server.js")
    expect(manifest.exports["./tui"]).toBe("./dist/index.js")
  })

  test("build sources exist for every compiled export", () => {
    expect(existsSync(join(root, "src/server.ts"))).toBe(true)
    expect(existsSync(join(root, "src/index.tsx"))).toBe(true)
  })

  test("server part defines the plugin id and a no-op setup", () => {
    expect(server.id).toBe("opencode.agents-watcher")
    expect(typeof server.setup).toBe("function")
  })
})
