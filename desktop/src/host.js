/**
 * Host lifecycle for the desktop shell: spawn `dsh web` on the loopback with
 * an OS-assigned port and resolve its readiness URL (the `dsh web: <url>`
 * line the web-app bundle prints once the Loader tree has settled). Electron-
 * free so the logic can be exercised under plain Node:
 *   node src/host.js
 * runs a window-less smoke (spawns the real host, prints the URL, stops it).
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** True when this module is packed inside app.asar (electron-builder): its
 * file:// URL is virtual, so repo paths resolve from the bundle instead. */
const PACKAGED = import.meta.url.includes('.asar/')

/** Anchor of this module: three URL pops cross src/host.js plus the app.asar
 * marker, landing on the bundle's Resources directory when packed. */
const MODULE_ANCHOR = fileURLToPath(new URL('../../', import.meta.url))

/** Directory containing the app bundle: the Resources dir above app.asar,
 * three dirname steps down from the enclosing .app. Undefined when the asar
 * marker is absent (non-standard layout; falls back to MODULE_ANCHOR). */
function bundleContainerDir() {
  const resources = MODULE_ANCHOR.replace(/\/+$/, '')
  if (!existsSync(join(resources, 'app.asar'))) return undefined
  let dir = resources
  for (let i = 0; i < 3; i++) dir = dirname(dir)
  return dir
}

/** True when the directory looks like the harness checkout root. */
function isRepoRoot(dir) {
  return existsSync(join(dir, 'apps', 'cli', 'src', 'bin.ts'))
    && existsSync(join(dir, 'package.json'))
}

/**
 * The harness checkout root. Source runs resolve it relative to this file; a
 * packaged shell walks up from the directory containing the .app.
 * @param start - ancestor walk start (the bundle's container directory).
 * @returns the checkout root or undefined.
 */
export function findRepoRoot(start) {
  let dir = start
  while (dir !== dirname(dir)) {
    if (isRepoRoot(dir)) return dir
    dir = dirname(dir)
  }
  return undefined
}

export const REPO_ROOT = PACKAGED
  ? findRepoRoot(bundleContainerDir()) ?? bundleContainerDir() ?? MODULE_ANCHOR
  : MODULE_ANCHOR
export const HOST_ENTRY_SOURCE = join(REPO_ROOT, 'apps', 'cli', 'src', 'bin.ts')
export const HOST_ENTRY_BUILT = join(REPO_ROOT, 'apps', 'cli', 'lib', 'bin.js')
export const HOST_TIMEOUT_MS = 90_000
export const KILL_GRACE_MS = 5_000
/** The host's readiness line (`dsh web: http://127.0.0.1:<port>`). */
export const URL_LINE = /^dsh web: (https?:\/\/\S+)$/

/** Engines of the harness: node ^22.19 || >=24 (root package.json). */
export function satisfiesEngines(version) {
  const m = /^v(\d+)\.(\d+)/.exec(version ?? '')
  if (!m) return false
  const major = Number(m[1])
  const minor = Number(m[2])
  return (major === 22 && minor >= 19) || major >= 24
}

/** Well-known node installs probed when PATH node is missing. GUI-launched
 * macOS apps inherit a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), which
 * hides homebrew and version-manager installs from the PATH probe. */
function nodeCandidates() {
  const home = homedir()
  return [
    '/opt/homebrew/bin/node', // homebrew, Apple Silicon
    '/usr/local/bin/node', // homebrew, Intel
    join(home, '.volta', 'bin', 'node'),
    join(home, '.asdf', 'shims', 'node'),
    join(home, '.local', 'share', 'mise', 'shims', 'node'),
    ...versionManagerNodes(join(home, '.nvm', 'versions', 'node')),
    ...versionManagerNodes(join(home, 'Library', 'Application Support', 'fnm', 'node-versions')),
  ]
}

/** bin/node under each version dir of a version-manager root (newest first). */
function versionManagerNodes(root) {
  let versions = []
  try { versions = readdirSync(root) } catch { return [] }
  versions.filter((v) => v.startsWith('v'))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  const out = []
  for (const v of versions) {
    out.push(join(root, v, 'bin', 'node'), join(root, v, 'installation', 'bin', 'node'))
  }
  return out
}

/**
 * The version line of a node binary when it runs and satisfies the harness
 * engines; undefined otherwise.
 * @param nodeBin - binary to probe.
 * @param env - optional probe env (embedded-node runs set ELECTRON_RUN_AS_NODE).
 */
export function usableNode(nodeBin, env) {
  const probe = spawnSync(nodeBin, ['--version'], { encoding: 'utf8', env })
  const version = probe.status === 0 ? probe.stdout.trim() : undefined
  return version !== undefined && satisfiesEngines(version) ? version : undefined
}

/**
 * The node binary that runs the host: DSH_DESKTOP_NODE override, else the
 * first candidate that runs and satisfies the engines — PATH node, known
 * install locations, then (packaged shells) Electron's embedded node via
 * ELECTRON_RUN_AS_NODE.
 */
export function resolveHostNode() {
  const override = process.env.DSH_DESKTOP_NODE
  if (override !== undefined) {
    if (!existsSync(override)) {
      throw new Error('DSH_DESKTOP_NODE names a missing binary: ' + override)
    }
    if (usableNode(override) !== undefined) return override
    throw new Error('DSH_DESKTOP_NODE binary not runnable or fails engines: ' + override)
  }
  const pathProbe = spawnSync('node', ['--version'], { encoding: 'utf8' })
  const pathVersion = pathProbe.status === 0 ? pathProbe.stdout.trim() : undefined
  if (pathVersion !== undefined && satisfiesEngines(pathVersion)) return 'node'
  for (const candidate of nodeCandidates()) {
    if (existsSync(candidate) && usableNode(candidate) !== undefined) return candidate
  }
  if (PACKAGED && usableNode(process.execPath, { ...process.env, ELECTRON_RUN_AS_NODE: '1' }) !== undefined) {
    return process.execPath
  }
  throw new Error(pathVersion !== undefined
    ? 'host node ' + pathVersion + ' does not satisfy the harness engines ^22.19 || >=24 (and no engines-satisfying node in the known locations)'
    : 'host node binary not runnable: PATH node missing and no known location runnable (' + nodeCandidates().join(', ') + '); start with node on PATH or set DSH_DESKTOP_NODE')
}

/** Host argv: source-launch (tsx, like `pnpm dsh`) or built lib/bin.js. */
export function hostCommand(nodeBin) {
  const built = process.env.DSH_DESKTOP_HOST_MODE === 'built'
  const entry = built ? HOST_ENTRY_BUILT : HOST_ENTRY_SOURCE
  if (!existsSync(entry)) {
    const hint = PACKAGED
      ? ' — packaged shell needs the checkout reachable from the bundle location (see README)'
      : ''
    throw new Error(built
      ? 'built host missing: ' + entry + ' — run `pnpm run build:lib:host` from the repo root'
      : 'source host missing: ' + entry + hint)
  }
  const prefix = built ? [] : ['--import', 'tsx/esm']
  return [nodeBin, ...prefix, entry, 'web', '--host', '127.0.0.1', '--port', '0']
}

/**
 * Start the host and resolve its loopback URL when the readiness line prints.
 * Resolves to { child, url }; rejects when the host exits early or stays
 * silent past HOST_TIMEOUT_MS.
 * @param nodeBin - node binary resolved by {@link resolveHostNode}.
 * @param onLine - optional observer for every line the host prints.
 */
export function startHost(nodeBin, onLine) {
  const args = hostCommand(nodeBin)
  const child = spawn(args[0], args.slice(1), {
    cwd: REPO_ROOT,
    env: (args[0] === process.execPath)
      ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      : { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let buffer = ''
  const lines = []
  const feed = (chunk) => {
    buffer += chunk
    if (buffer.includes('\n')) {
      const parts = buffer.split(/\r?\n/)
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        if (part !== '') {
          lines.push(part)
          if (onLine !== undefined) onLine(part)
        }
      }
    }
  }
  child.stdout.on('data', (c) => feed(String(c)))
  child.stderr.on('data', (c) => feed(String(c)))
  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('host did not print its URL within ' + HOST_TIMEOUT_MS + ' ms; last lines: ' + lines.slice(-5).join(' | ')))
    }, HOST_TIMEOUT_MS)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error('host exited before readiness (code=' + code + ' signal=' + signal + ')'))
    })
    // Readiness is decided on completed lines; a trailing chunk without a
    // newline cannot be the URL line (the host always ends it with \n).
    child.stdout.on('data', () => {
      for (const line of lines) {
        const m = URL_LINE.exec(line)
        if (m !== null) {
          clearTimeout(timer)
          resolve(m[1])
          return
        }
      }
    })
  })
  return { child, url }
}

/**
 * Stop the host: SIGTERM, then SIGKILL after the grace period.
 * @param child - the spawned host child.
 */
export async function stopHost(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  const exited = new Promise((resolve) => child.once('exit', resolve))
  const force = new Promise((resolve) => {
    const t = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
      resolve()
    }, KILL_GRACE_MS)
    t.unref()
  })
  await Promise.race([exited, force])
}

// Window-less smoke when run directly: node src/host.js
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let nodeBin
  try {
    nodeBin = resolveHostNode()
  } catch (error) {
    console.error('[host.js] ' + error.message)
    process.exit(1)
  }
  const { child, url } = startHost(nodeBin, (line) => console.log('[host] ' + line))
  try {
    const resolved = await url
    console.log('HOST_SMOKE_OK ' + resolved)
    await stopHost(child)
    console.log('HOST_SMOKE_STOPPED')
    process.exit(0)
  } catch (error) {
    console.error('[host.js] ' + error.message)
    child.kill('SIGKILL')
    process.exit(1)
  }
}
