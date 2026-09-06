# AGENTS.md

## 项目定位与结构

这是一个仅面向本机单用户的 π 工作台。Node/Express 提供 REST API、SSE 和 WebSocket；浏览器内的 xterm 通过 PTY 运行项目自带的 pi 原生 TUI。服务固定监听 `127.0.0.1`，默认端口为 `7777`。

- `server.js`：HTTP 路由、`/api/events` SSE、`/ws` TUI WebSocket、配置、任务/会话生命周期和跨平台目录选择。
- `lib/store.js`：任务和便签的加载、迁移、原子持久化与变更事件。运行时数据存入 `data/tasks.json`。
- `lib/session.js`、`lib/unread.js`：pi session JSONL 的容错解析、缓存、统计和未读状态。
- `lib/tui-executor.js`：PTY 启停、终端回放、尺寸同步及浏览器输入所有权；`lib/executor.js` 负责按 session 文件查找和终止遗留 pi 进程。
- `public/`：无构建步骤的原生 HTML/CSS/JavaScript 前端；`public/ui/` 存放 API、状态和格式化共享逻辑。
- `test/`：Node 内建测试，当前覆盖存储迁移、JSONL 解析和未读计算。

## 环境与命令

项目使用原生 ES modules（`"type": "module"`），没有构建、lint 或端到端测试脚本。锁文件版本为 npm lockfile v3；pi 依赖要求 Node.js `>=22.19.0`。

```bash
npm install
npm start
npm test
node --check server.js
node --check public/app.js
```

配置首次写入 `data/config.json`，包括 `port`、`maxConcurrent` 和 `approvePi`。不要提交 `data/`、`sessions/`、`node_modules/`、日志或本机凭据。

## 编码约定

- 保持原生 ESM 和原生浏览器模块；除非任务确有必要，不引入框架或构建工具。
- 用户可见文案保持中文，并延续现有紧凑的函数式 JavaScript 风格。
- 将前端 API、共享状态和格式化分别放在 `public/ui/api.js`、`state.js`、`format.js`；不要在 `app.js` 复制这些逻辑。
- 修改 `public/app.js` 或 `public/style.css` 后，同步更新 `public/index.html` 中对应的 `?v=` 缓存版本。保留首帧主题恢复脚本，避免主题闪烁。
- `style.css` 使用 CSS 变量和主题覆盖。显示设置包含默认、极客、极光、报刊四种风格，以及跟随系统、亮色、暗色三种模式；样式改动须同时考虑三种模式和窄屏断点（`760px`）。

## 数据与生命周期约束

- 任务状态仅为 `unfinished`、`done`、`archived`；运行中的 pi TUI 是独立运行状态，不能用任务状态表示。加载旧数据时将 `todo`、`running` 和未知状态迁移为 `unfinished`。
- 任务删除是软删除：保存原状态到 `archivedFromStatus`，并将可恢复的子会话归档；恢复时还原原状态和这些会话。永久删除或清空回收站才会删除相应 session 文件。
- 任务初始 `sessions` 为空、`sessionFile` 为 `null`。子会话使用 `新会话` 作为初始标题，并在首次用户消息后按其内容命名。保留 `task.sessionFile` 作为兼容锚点；删掉全部活动会话后设为 `null`。
- 空子会话可直接永久删除；有消息的子会话先归档，可在所属任务未归档时恢复。不要直接写 session JSONL：所有 PTY 输入和 JSONL 单写入者约束都通过 `lib/tui-executor.js` 保持。
- 任务颜色为八个内置值（`red`、`orange`、`yellow`、`green`、`cyan`、`blue`、`purple`、`gray`）或 `custom-*`；自定义颜色目录保存在浏览器 `localStorage`。不要重新引入 priority。
- `workingDirs` 是工作目录数组，`workingDir` 始终是其第一个兼容字段。仅接受绝对路径或 `~` 路径，并通过 `resolveWorkingDir()` / `resolveWorkingDirs()` 处理；Windows 绝对路径必须保持可用。编辑任务目录只影响新会话，已有会话以 JSONL header 的 `cwd` 为准。
- 数据更改必须经由 `lib/store.js`；不要直接编辑 `data/tasks.json`。改动迁移、归档或会话行为时，兼顾旧数据兼容性和持久化事件。

## 平台与安全

- 目录选择须保留 Windows PowerShell、macOS AppleScript、Linux `zenity` 三条路径。
- 进程查找与终止须保留 Windows PowerShell 与非 Windows `pgrep` 的分支；不要假设 `osascript`、`which` 或 `pgrep` 在所有平台存在。
- pi 会得到任务描述及所有工作目录中的 `AGENTS.md` 作为上下文，并能在非只读模式下读取、执行和写入文件。只使用可信工作目录，且不要把本服务暴露到公网。

## 修改与验证

1. 先阅读受影响模块及其调用方，做最小范围修改；服务端 API 与前端调用必须同步。
2. 修改服务端后运行 `node --check server.js`；修改前端脚本后运行 `node --check public/app.js`；完成任何行为改动后运行 `npm test`。
3. 修改 CSS 后检查语法/大括号，并在桌面和窄屏下检查四种主题风格及系统、亮色、暗色模式。
4. 涉及任务、会话、回收站或工作目录时，手动走一遍相关创建、归档/恢复、删除或 TUI 启动流程，并确认运行时数据未被纳入改动。

## Git 约定

当前主分支为 `main`，跟踪 `origin/main`。近期提交以中文说明为主，并常用 `feat`、`fix`、`refactor`、`style` 前缀；沿用这一风格，提交仅包含源代码、测试和文档等可复现的改动。
