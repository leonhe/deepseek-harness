import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Arch } from 'builder-util'

/**
 * electron-builder afterPack hook: copy the bundled harness runtime into
 * Contents/Resources/runtime with plain rsync. electron-builder's own
 * extraResources copy filter drops a root-level node_modules of the copied
 * tree, and the runtime's layout is built on exactly that (its root child
 * node_modules); skipping the copy produced dangling links that leaked
 * dependency resolution up into the shell's own npm tree.
 *
 * arm64 only: the runtime carries per-arch native deps (node-pty, sharp);
 * x64 cross-builds ship shell-only (no staged runtime dir).
 */
export default async function afterPack({ appOutDir, electronPlatformName, arch }) {
  if (electronPlatformName !== 'darwin' || arch !== Arch.arm64) return
  const here = dirname(fileURLToPath(import.meta.url))
  const stage = resolve(here, '..', 'stage', 'runtime-' + Arch[arch])
  if (!existsSync(stage)) return
  const target = join(appOutDir, 'Contents', 'Resources', 'runtime')
  execFileSync('rsync', ['-a', stage + '/', target + '/'], { stdio: 'inherit' })
}
