#!/usr/bin/env node
/**
 * Bundle the harness runtime into desktop/stage/runtime/ for the packaged
 * shell: the built CLI (apps/cli/lib), the frontend dist (apps/web/dist),
 * workspace packages, the vendored cordis + native addons, and the pnpm
 * node_modules tree (symlinks and .pnpm store) - copied verbatim with rsync
 * from a checkout built via `pnpm run build`. The packaged host (host.js)
 * runs it in built mode.
 *
 * DSH_BUNDLE_PRUNE=1 additionally removes .pnpm store entries for packages
 * that are dev-infrastructure only (vite/vitest/eslint/playwright/...). The
 * prune list is curated; the host boot smoke validates the pruned runtime.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const RUNTIME = join(REPO_ROOT, 'desktop', 'stage', 'runtime')
const PRUNE = process.env.DSH_BUNDLE_PRUNE !== '0'

/** .pnpm store entries pruned as dev-infrastructure when DSH_BUNDLE_PRUNE=1. */
const DEV_ONLY_PREFIXES = [
  '@oxlint', '@rolldown', '@biomejs', '@dprint', '@eslint', '@testing-library',
  '@types/', '@vitest', '@vitejs', '@mermaid-js', '@openai+codex',
  '@anthropic-ai+claude-agent-sdk', '@playwright',
  'vite', 'vitest', 'eslint', 'oxlint', 'prettier', 'playwright', 'lefthook',
  'knip', 'publint', 'tsx', 'jsdom', 'happy-dom', 'rollup', 'typescript',
  'mermaid', 'tsdown', 'rolldown', 'js-yaml', 'lightningcss', 'sass',
  'postcss', '@stylistic', 'storybook', 'concurrently',
]

function sizeOf(dir) {
  let total = 0
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) total += sizeOf(p)
      else if (entry.isSymbolicLink()) total += 0
      else total += statSync(p).size
    }
  } catch { /* unreadable dirs count 0 */ }
  return total
}

function human(n) {
  return (n / 1024 / 1024).toFixed(0) + 'M'
}

function rsync(src, dest, extra = []) {
  mkdirSync(dirname(dest), { recursive: true })
  execFileSync('rsync', ['-a', ...extra, src, dest], { stdio: 'pipe' })
}

// Guard: when this runs from the CI temp-dir copy (no checkout above), keep
// the already-staged runtime instead of wiping it and rebuilding an empty tree.
if (!existsSync(join(REPO_ROOT, 'apps')) || !existsSync(join(REPO_ROOT, 'packages'))) {
  if (existsSync(join(RUNTIME, 'apps', 'cli', 'lib', 'bin.js'))) {
    console.log('no checkout at ' + REPO_ROOT + '; keeping staged runtime for packaging')
    process.exit(0)
  }
  throw new Error('no harness checkout at ' + REPO_ROOT + ' and no staged runtime — run `pnpm run build` at the repo root first')
}

rmSync(RUNTIME, { recursive: true, force: true })
mkdirSync(RUNTIME, { recursive: true })

// Workspace members carry their @deepseek-ai links inside their own
// node_modules (pnpm layout) — those dirs are nearly pure symlinks and MUST
// be copied for module resolution to work; only packages' own dist bundles
// are dropped (package.json exports point at lib).
const plans = [
  ['apps', []],
  ['packages', ['--exclude', '*/*/dist/', '--exclude', '*/dist/']],
  ['vendor', []],
  ['native', []],
]
for (const [item, extra] of plans) {
  const src = join(REPO_ROOT, item)
  if (existsSync(src)) rsync(src + '/', join(RUNTIME, item) + '/', extra)
}
rsync(join(REPO_ROOT, 'node_modules') + '/', join(RUNTIME, 'node_modules') + '/')

if (PRUNE) {
  const store = join(RUNTIME, 'node_modules', '.pnpm')
  if (existsSync(store)) {
    let removed = 0
    for (const entry of readdirSync(store, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (DEV_ONLY_PREFIXES.some((p) => entry.name.startsWith(p))) {
        rmSync(join(store, entry.name), { recursive: true, force: true })
        removed++
      }
    }
    console.log('pruned .pnpm entries:', removed)
  }
}

const top = []
const storeDir = join(RUNTIME, 'node_modules', '.pnpm')
for (const entry of readdirSync(storeDir, { withFileTypes: true })) {
  if (entry.isDirectory()) top.push([entry.name, sizeOf(join(storeDir, entry.name))])
}
top.sort((a, b) => b[1] - a[1])
console.log('runtime:', RUNTIME)
console.log('runtime size:', human(sizeOf(RUNTIME)))
console.log('top store entries:', top.slice(0, 8).map(([n, s]) => n + '=' + human(s)).join(', '))
