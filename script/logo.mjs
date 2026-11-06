// Generates the "Agents Watcher" pixel wordmark in OpenCode's ornate art style.
// Keep the lettering on a regular cell grid so both light and dark variants
// remain crisp at README and package sizes.
import { writeFileSync } from "fs"

const CELL = 6
const GAP = 6
const TOP = 6
const SPACE_WIDTH = 2

const GLYPHS = {
  a: ["####", "#..#", "####", "#dd#", "#dd#"],
  c: ["####", "#...", "#...", "#ddd", "####"],
  e: ["####", "#...", "####", "#ddd", "####"],
  g: ["####", "#..#", "#dd#", "#dd#", "####", "...#", "####"],
  h: ["#..#", "#..#", "####", "#dd#", "#dd#"],
  n: ["####", "#..#", "#dd#", "#dd#", "#dd#"],
  r: ["###.", "#..#", "#dd.", "#...", "#..."],
  s: ["####", "#...", "####", "ddd#", "####"],
  t: [".#..", "####", ".#dd", ".#dd", ".###"],
  w: ["#...#", "#...#", "#.#.#", "#d#d#", ".#d#."],
}

const WORD = "agents watcher"

function glyphWidth(char) {
  if (char === " ") return SPACE_WIDTH
  return GLYPHS[char][0].length
}

function render(main, accent) {
  const parts = []
  let x = 0
  for (const char of WORD) {
    if (char === " ") {
      x += SPACE_WIDTH * CELL + GAP
      continue
    }

    const rows = GLYPHS[char]
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        const cell = rows[r][c]
        if (cell === ".") continue
        parts.push(
          `<rect x="${x + c * CELL}" y="${TOP + r * CELL}" width="${CELL}" height="${CELL}" fill="${cell === "d" ? accent : main}"/>`,
        )
      }
    }
    x += glyphWidth(char) * CELL + GAP
  }

  const width = x - GAP
  const height = TOP + Math.max(...Object.values(GLYPHS).map((glyph) => glyph.length)) * CELL
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">\n${parts.join("\n")}\n</svg>\n`
}

writeFileSync(new URL("../assets/logo-dark.svg", import.meta.url), render("#F1ECEC", "#4B4646"))
writeFileSync(new URL("../assets/logo-light.svg", import.meta.url), render("#211E1E", "#CFCECD"))
console.log("written")
