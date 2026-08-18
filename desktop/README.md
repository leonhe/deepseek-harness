# dsh-desktop-poc — DeepSeek Harness macOS 客户端壳（POC）

把 `pnpm dsh web` 项目打包成 macOS 客户端的第一个可运行实验件（**路线 A**：桌面壳 + 子进程宿主，loopback HTTP 传输）。

## 为什么不能只打包静态文件

`apps/web` 的 Vite 构建只是壳（shell）：`window.__DSH_BOOT__`（插件入口图，`packages/client/modules` 组合并注入）只有完整宿主才能提供；`dsh web` 还在 loopback 上承担插件 bundle 动态服务、`/api` HTTP 桥、下行 WebSocket 与 HMR 流（见 `docs/subsystems/web-server.md`）。裸 Vite serve 被 `apps/web/vite.config.ts` 的 `rejectStandaloneServe` 明确拒绝，postmortem 0003 记录过「HTTP 200 不等于应用就绪」的教训。

因此客户端 = **Electron 壳 + 宿主子进程**，缺一不可。

## 架构

```
Electron 壳 (desktop/src/main.js)
  │  spawn: node --import tsx/esm apps/cli/src/bin.ts web --host 127.0.0.1 --port 0
  ▼                                            （与 `pnpm dsh web` 同一条启动路径）
dsh web 宿主进程（Cordis Loader 组合，注入 __DSH_BOOT__、/api、WS、插件 bundle）
  ▲
  │  wait "dsh web: http://127.0.0.1:<port>"  ← 官方就绪信号（web-app bundle 的 URL 行）
BrowserWindow 加载该 URL（默认 loopback，已在 /api browser-trust fence 白名单内）
```

- 端口用 `--port 0` 由 OS 分配，避免占用冲突；URL 行由 shell 解析。
- 窗口关闭 / 应用退出时 SIGTERM → SIGKILL 兜底杀掉宿主子进程。
- 渲染进程保持 `contextIsolation` + `sandbox`，导航与弹窗锁在宿主 origin 内。

## 快速开始

前置：仓库根已 `pnpm install`（宿主走 root 的 tsx 依赖）；系统 Node ≥ 22.19（root engines）。

```sh
cd desktop
npm install            # 独立安装（desktop/ 不是 pnpm workspace 成员，不影响仓库 lockfile）
npm start              # 打开窗口
npm run smoke          # 无窗口冒烟：拉起宿主 → 打印 DSH_DESKTOP_SMOKE_OK <url> → 退出
```

> 沙箱/CI 里 `~/.npm` 不可写时，把缓存指进工作区：
> `ELECTRON_CACHE=$PWD/.electron-cache npm install --cache $PWD/npm-cache`

## 可配置环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_DESKTOP_NODE` | 指定宿主 Node 二进制绝对路径（默认取 PATH 上的 `node`，并校验 engines ^22.19 || >=24） |
| `DSH_DESKTOP_HOST_MODE` | `built` 时改走 `apps/cli/lib/bin.js`（需先 `pnpm run build:lib:host`），默认 source-launch（tsx） |
| `DSH_DESKTOP_SMOKE=1` | 冒烟模式：不起窗口，就绪后打印并退出 |
| `DSH_HOME` | 宿主数据目录（会话、配置；默认 `~/.dsh` 一类用户主目录） |

## 打包 .app / .dmg

```sh
pnpm run build            # 先构建 harness（apps/cli/lib、packages lib、apps/web/dist）
cd desktop
npm run dist:mac          # 当前架构（predist 自动执行 scripts/bundle-host.mjs 打包运行时）
npm run dist:mac:arm64    # Apple Silicon
```

产物在 `desktop/dist/`（`DeepSeek Harness Desktop.app` + .dmg/.zip）。arm64 产物**内置宿主运行时**（`Contents/Resources/runtime`，磁盘约 620MB：构建产物 + pnpm node_modules，`afterPack` 钩子打入、`bundle-host.mjs` 用 `DSH_BUNDLE_PRUNE=0` 可跳过依赖修剪；分发产物 .dmg/.zip 自带压缩，运行时内容再压约 78%）——装到任何位置（含 /Applications）都能独立运行；首次启动会自动在 `$DSH_HOME/profiles/web` 初始化 web profile（app-boot 的 `PROFILE_TEMPLATES`）。宿主 Node 优先取 Electron 内嵌版本（`ELECTRON_RUN_AS_NODE`，42 系列为 v24、满足 engines），无需系统安装 Node。对外分发需要：

1. **签名 + 公证**（Gatekeeper）：Apple Developer ID 证书 `CSC_LINK`/`CSC_KEY_PASSWORD`，`notarize: true` + `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`（entitlements 已含 hardened runtime 所需 JIT 项）。
2. **x64 暂不含运行时**：运行时携带按架构编译的原生依赖（node-pty、sharp 的 darwin-arm64 绑定），而 x64 版是在 arm64 runner 上交叉编译的，无法附带正确架构的运行时——x64 .app 仍回退「从所在位置向上查找仓库 checkout」的旧行为，需把 .app 放在仓库根或 `desktop/dist/` 内使用。

## 自动打包（GitHub Actions）

`.github/workflows/desktop-build.yml` 负责 CI 自动打包，触发方式：

| 触发 | 行为 |
| --- | --- |
| push `master`（改动 `desktop/**`） | arm64 + x64 双架构打包，产物上传为 Actions artifacts |
| pull_request（改动 `desktop/**`） | 验证构建，不发布产物 |
| 手动 `workflow_dispatch` | 随时重打包 |
| push tag `desktop-v*` | 打包并挂载到对应 GitHub Release 页面 |

打一个正式版本并发布：

```sh
git tag desktop-v0.1.0 && git push origin desktop-v0.1.0
```

运行结束后 Release 页（`github.com/<owner>/deepseek-harness/releases/tag/desktop-v0.1.0`）包含 arm64 / x64 两个架构的 .dmg 与 .zip（命名形如 `DeepSeek Harness Desktop-0.1.0-arm64-mac.dmg`）。

说明：

- runner：两种架构都在 `macos-14`（Apple Silicon）上构建；x64 为交叉编译（electron-builder `--x64`）——`macos-13`（Intel）runner 产能枯竭会无限等待（Apple 停产 Intel Mac 后 GitHub 的 x64 macOS 机群长期排队）。
- CI 先 `pnpm install --frozen-lockfile` + `pnpm run build` 产出宿主构建物，再 `node desktop/scripts/bundle-host.mjs` 打包运行时（arm64 作业），随后在 workspace 外的临时副本里执行 `npm ci` + electron-builder：`desktop/` 虽是 npm 独立安装，electron-builder 仍会向上探测到仓库根的 pnpm workspace 而改用 pnpm 收集器；副本构建可避开（详见工作流文件头注释）。
- 产物未签名、未公证（`sign: false`/`notarize: false`），对外分发仍需上文「打包 .app / .dmg」的签名 + 公证步骤。
- 桌面端专属 push 与 `desktop-v*` tag push 都不会触发仓库的 e2e 真实 API 套件（`e2e.yml` 对 `desktop/**` 设了 `paths-ignore`，且 tag ref 不匹配其 branches 过滤器）。

## 图标
桌面端与 Web 版共用同一图标（鲸鱼图形）：`build/icon.svg` 是 `apps/web/public/favicon.svg` 的副本（同步源），`build/icon.png`（1024²，白底圆角 + 居中标，圆角 rx=229 为 macOS 图标标准比例、四角透明）由 `build/icon-master.svg` 渲染合成，`build/icon.icns` 供打包（`electron-builder.yml` 的 `mac.icon`）与开发模式 Dock 图标（`main.js` 的 `app.dock.setIcon`，仅未打包运行且存在 `build/icon.png` 时生效）使用。

favicon 更新后的再生成流程：把新 path 同步进 `build/icon.svg` 与 `build/icon-master.svg` → 用 sharp（仓库 pnpm store 自带 `sharp@0.35.3`）以 `density: 192` 渲染并用 lanczos3 降到 1024² 出 `icon.png` → `sips -z` 铺满 10 档 `icon.iconset`（16/32/64/128/256/512/1024）→ `iconutil -c icns icon.iconset -o build/icon.icns`。

## 已知限制与后续路线

- **这是路线 A（临时 HTTP 形态）**。仓库设计的第一等形态在 `packages/host/webserver/src/index.ts` 注释里：Electron 加载 dist over `file://`、fetch 走 IPC 桥——那需要 client connection 层加 IPC transport 与新的 origin 信任策略，目前仓库没有实现，属于正式产品改造（工作量大）。
- 宿主以「内置运行时（`Contents/Resources/runtime`，仅 arm64 产物）或仓库 checkout + Node 子进程」方式启动；node 解析顺序：`DSH_DESKTOP_NODE` → PATH `node` → 常见安装位置（homebrew/nvm/volta/mise/asdf/fnm）→ 打包壳的 Electron 内嵌 Node（`ELECTRON_RUN_AS_NODE`，42 系列为 v24、满足 engines）。Finder/Dock 启动的 .app PATH 不含 homebrew，靠后两项兜底。
- 单实例锁只做到「第二个实例退出」，未聚焦已有窗口。
- 若要把壳正式并入仓库（`apps/desktop`），需按 `scripts/check-workspace-constraints.ts` 的门禁补齐：release member 字段（public/publishConfig/repository/files 策略）并给 checker 注册 files 策略；写包 README 与 invariants。POC 阶段刻意放在 workspace 之外以避免这些改动。
