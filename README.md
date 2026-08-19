# π 工作台

本地单用户 Web 工作台，用于管理任务，并在 Web 会话中运行 pi agent。服务默认监听 `127.0.0.1:7777`，适合个人本机使用。

## 快速开始

```bash
cd /path/to/workspace
npm install
npm start
```

打开 <http://127.0.0.1:7777>。

## 主要功能

- 任务 CRUD、搜索、筛选、排序、截止时间和统计信息
- 任务状态：待办、处理中、已完成；旧的 `review` 数据对外显示为处理中
- 全部任务以三列看板展示，已废弃任务不进入全部任务看板
- 删除任务采用软删除，进入已废弃；默认保留 15 天后自动清理
- 任务支持红、橙、黄、绿、青、蓝、紫、灰八种颜色标签
- 每个任务支持多个 Web 子会话，可切换、重命名和删除
- 基于 pi SDK 的进程内 Web 会话，不依赖 `pi --mode rpc/json`
- WebSocket 实时推送 snapshot 和事件，包括文本、思考过程、工具调用和工具输出
- 支持 `/model`、`/thinking`、`/compact`、`/abort`、`/session`、`/models` 等 Slash Command
- 支持 Enter 发送、Shift+Enter 换行、排队发送和终止执行
- 工作目录支持绝对路径、`~` 路径及旧的 `projects/` 相对路径，并提供 macOS、Linux、Windows 原生目录选择器
- 支持跟随系统、浅色和深色主题，选择保存于浏览器本地存储

## 使用流程

1. 点击「新建任务」，填写标题、描述、颜色标签和可选 deadline。
2. 点击「执行」，选择工作目录、模型、thinking 等执行参数。
3. 在会话窗口查看实时回复、思考过程、read/write/bash 等工具消息。
4. 任务执行结束后可继续发送消息、使用 Slash Command、标记完成或终止执行。
5. 已完成任务可重开；已废弃任务可恢复或永久删除。

## 目录结构

- `server.js`：Express 服务、REST API、WebSocket 升级和任务路由
- `lib/store.js`：任务持久化、任务字段和运行时目录
- `lib/session.js`：session JSONL 解析和统计
- `lib/web-executor.js`：pi SDK 会话、事件广播和实时状态
- `lib/executor.js`：进程查找、终止和 pi 可执行文件解析
- `public/index.html`：页面入口
- `public/app.js`：前端状态、API、WebSocket 和交互逻辑
- `public/style.css`：布局、看板、会话消息和主题样式
- `public/ui/format.js`：公共格式化函数
- `data/`：运行时配置、任务数据、模型缓存和脚本
- `sessions/`：session JSONL 文件
- `projects/`：兼容旧相对路径的默认项目目录

`data/`、`sessions/` 和 `projects/` 下的运行时内容默认不纳入 Git。

## 配置

首次启动后可编辑 `data/config.json`：

```json
{
  "port": 7777,
  "maxConcurrent": 0,
  "terminalApp": "auto",
  "approvePi": true
}
```

- `port`：HTTP 端口，默认 `7777`
- `maxConcurrent`：最大并发任务数，`0` 表示不限制
- `terminalApp`：外部终端选择，`auto` 时自动选择 Terminal 或 iTerm2
- `approvePi`：是否自动信任项目文件

## 常用接口

- `GET/POST/PUT/DELETE /api/tasks`：任务 CRUD
- `POST /api/tasks/:id/execute`：启动任务
- `POST /api/tasks/:id/reply`：继续会话
- `POST /api/tasks/:id/command`：执行 Slash Command
- `POST /api/tasks/:id/terminate`：终止执行
- `GET/POST/PATCH/DELETE /api/tasks/:id/sessions...`：子会话管理
- `POST /api/tasks/:id/restore`：恢复已废弃任务
- `DELETE /api/tasks/:id/permanent`：永久删除任务
- `POST /api/select-directory`：打开本机目录选择器
- `GET /api/models`、`POST /api/models/refresh`：模型列表
- `/ws`：WebSocket 实时会话通道

## Windows 支持

Windows 需要安装 Node.js 和 pi，并确保以下命令可以在 PowerShell 中执行：

```powershell
node --version
pi --version
```

Web SDK 会话、任务管理和实时通信均支持 Windows。Windows 下会使用 PowerShell 目录选择器；旧的外部终端执行路径使用 `.cmd` 脚本和 `cmd.exe`。如果 `pi` 是 npm 安装的 `.cmd` 命令，请确保其目录已加入 `PATH`。

## 开发检查

项目没有独立测试套件，修改后至少运行：

```bash
node --check server.js
node --check public/app.js
```

服务只监听本机地址。pi agent 可能读取文件、执行命令和修改工作目录中的文件，请仅对可信项目使用执行功能。
