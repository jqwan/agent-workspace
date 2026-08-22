# AGENTS.md

## 项目概览

这是一个本地单用户 π 工作台：Express 提供 REST API，WebSocket 转发浏览器 xterm 与 pi 原生 TUI 的 PTY 数据。

## 开发约定

- 使用原生 ES modules；项目 `package.json` 设置了 `"type": "module"`。
- 默认服务地址为 `http://127.0.0.1:7777`。
- 前端位于 `public/`，当前使用原生 JavaScript、HTML 和 CSS，不要无必要地引入构建工具。
- 公共格式化逻辑放在 `public/ui/format.js`。
- 任务持久化通过 `lib/store.js` 完成；不要直接修改 `data/tasks.json` 来实现业务逻辑。
- 原生 TUI 会话逻辑集中在 `lib/tui-executor.js`；保持 PTY、浏览器终端和 session JSONL 的单写入者约束。
- 修改前端静态资源后，更新 `public/index.html` 中对应的 `style.css?v=...` 或 `app.js?v=...` 版本号，避免浏览器缓存旧资源。
- 用户可见文字以中文为主；保持已有的中文界面风格。

## 领域规则

- 对外任务状态为 `todo`、`running`、`done`、`archived`，界面显示为待办、处理中、已完成、已废弃。
- 历史数据中的 `review` 仍需兼容，并通过 `publicTask()` 对外映射为 `running`。
- 删除任务是软删除：设置 `archived`、`archivedAt` 和 `purgeAt`，15 天后才清理 session 文件和任务记录。
- 已废弃任务不应出现在全部任务看板中；恢复后回到待办状态。
- 任务分类字段是 `color`，有效值为 `red`、`orange`、`yellow`、`green`、`cyan`、`blue`、`purple`、`gray`。不要重新引入 priority/重要程度概念。
- 新建任务不预建任何会话（`sessions` 为空数组、`sessionFile` 为 null）；点击执行时才创建首个会话（标题「新会话」，随后按首条消息重命名），并把任务级 `sessionFile` 锚定到该会话。
- 「主会话」只存在于历史数据（由旧 `task.sessionFile` 回填）；没有消息内容的主会话不显示。
- 工作目录可为绝对路径、`~` 路径或兼容旧数据的 `projects/` 相对路径。使用 `resolveWorkingDir()`，不要重新限制为固定项目子目录；Windows 路径如 `C:\\Users\\name\\project` 必须保持可用。
- Windows 目录选择器通过 PowerShell，macOS 使用 AppleScript，Linux 使用 `zenity`；修改目录选择逻辑时要保留三平台分支。
- 主题有系统、浅色、深色三种模式，用户选择保存在 `localStorage`；新增主题样式时必须同时检查系统主题和手动主题覆盖规则。
- `lib/executor.js` 中的 pi 查找、外部脚本、终端打开和进程查找需要兼容 Windows；不要无条件调用 `which`、`pgrep` 或 `osascript`。

## 修改流程

1. 先阅读相关模块和现有 CSS 主题覆盖规则，再进行最小范围修改。
2. 服务端变更后运行 `node --check server.js`。
3. 前端 JavaScript 变更后运行 `node --check public/app.js`。
4. CSS 修改后检查大括号数量，并在浅色、深色及系统主题下检查页面。
5. 涉及任务、会话或删除行为时，同时检查持久化和已有 session 数据兼容性。
6. 不要提交运行时数据、session 日志、模型缓存、认证 token 或 `node_modules`。

## 重要文件

- `server.js`：HTTP/WebSocket 路由和任务生命周期
- `lib/store.js`：任务存储
- `lib/session.js`：session 解析
- `lib/tui-executor.js`：pi 原生 TUI PTY、输入、尺寸和实时输出
- `public/app.js`：前端交互
- `public/style.css`：页面样式和主题
- `public/index.html`：资源入口及缓存版本

## 安全注意

应用仅面向本机单用户使用，但 pi agent 具有读文件、执行命令和写文件能力。不要把服务暴露到公共网络，也不要在不可信工作目录中自动执行任务。
