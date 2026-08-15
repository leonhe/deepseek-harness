/**
 * dsh desktop shell — POC, route A (loopback HTTP).
 *
 * The Web GUI is not a standalone site: only the `dsh web` host injects
 * window.__DSH_BOOT__ and serves plugin bundles, /api, and the WebSocket
 * downlink (see apps/web/vite.config.ts and the web-app bundle). This shell
 * therefore spawns the host as a child process on 127.0.0.1 with an
 * OS-assigned port, waits for the host's readiness line (see
 * ./host.js:URL_LINE), then opens a BrowserWindow on that URL. The loopback
 * authority sits inside the /api browser-trust fence by default, so no
 * --trusted-host is needed.
 *
 * All host lifecycle logic lives in ./host.js (Electron-free, unit-testable
 * with `node src/host.js`); this file is the thin window/process glue.
 *
 * The webserver package documents the first-class desktop shape as Electron
 * loading dist over file:// with fetch over an IPC bridge; this POC does not
 * implement that bridge and is explicitly the interim HTTP route.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { hostCommand, resolveHostNode, startHost, stopHost } from './host.js'

const SMOKE = process.env.DSH_DESKTOP_SMOKE === '1'
/** The served frontend origin: loopback with an OS-assigned port. */
const HOST_ORIGIN = /^https?:\/\/127\.0\.0\.1:\d+/

let child = undefined
let quitting = false
let windowClosed = false

function fail(message) {
  console.error('[shell] ' + message)
  if (!SMOKE) dialog.showErrorBox('DeepSeek Harness', message)
  app.exit(1)
}

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    title: 'DeepSeek Harness',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  win.once('ready-to-show', () => win.show())
  win.loadURL(url)
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (HOST_ORIGIN.test(target)) return { action: 'allow' } // same-host popups (e.g. pin-browse)
    if (/^https?:/.test(target)) void shell.openExternal(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, target) => {
    if (!HOST_ORIGIN.test(target)) event.preventDefault()
  })
  win.on('closed', () => { windowClosed = true })
  return win
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => app.quit())

  app.whenReady().then(async () => {
    // Unpackaged runs show the web favicon mark in the Dock; packaged builds
    // take it from build/icon.icns via electron-builder (mac.icon).
    const dockIcon = fileURLToPath(new URL('../build/icon.png', import.meta.url))
    if (process.platform === 'darwin' && !SMOKE && existsSync(dockIcon)) {
      app.dock.setIcon(dockIcon)
    }
    try {
      const nodeBin = resolveHostNode()
      // hostCommand validates the host entry and throws (e.g. source host
      // missing for a packaged shell whose bundle cannot reach the checkout)
      // — everything below must surface through fail(), never as an uncaught
      // async rejection that leaves a windowless app in the Dock.
      console.log('[shell] spawning host: ' + hostCommand(nodeBin).join(' '))
      const started = startHost(nodeBin, (line) => console.log('[host] ' + line))
      child = started.child
      child.on('exit', (code, signal) => {
        if (quitting || windowClosed) return
        console.error('[shell] host exited unexpectedly (code=' + code + ' signal=' + signal + ')')
        fail('host exited unexpectedly (code=' + code + ' signal=' + signal + '); the app will close')
      })
      const url = await started.url
      console.log('[shell] host ready at ' + url)
      if (SMOKE) {
        console.log('DSH_DESKTOP_SMOKE_OK ' + url)
        await stopHost(child)
        app.exit(0)
        return
      }
      createWindow(url)
    } catch (error) {
      fail('host startup failed: ' + error.message)
    }
  })

  app.on('window-all-closed', () => {
    // Unlike the browser habit, closing the window quits the shell: it owns
    // the child host process, which dies with it.
    app.quit()
  })

  app.on('before-quit', () => {
    if (child !== undefined && !quitting) {
      quitting = true
      void stopHost(child)
    }
  })
}
