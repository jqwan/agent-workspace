# π 工作台

本地单用户任务工作台。任务会话通过浏览器中的 xterm 运行 **pi 原生 TUI**；服务默认只监听 `127.0.0.1:7777`。

## 快速开始

```bash
cd /path/to/workspace
npm install
npm start
```

打开 <http://127.0.0.1:7777>。

## 主要功能

- 任务 CRUD、搜索、筛选、排序、截止时间、颜色标签和统计信息
- 状态为待办、处理中、已完成、已废弃；历史 `review` 数据对外显示为处理中
- 软删除任务，默认保留 15 天后自动清理
- 每个任务可有多个 pi 子会话，可切换、重命名和删除
- 浏览器中运行完整 pi 原生 TUI，支持 pi 内置快捷键、Slash Command、滚轮浏览和终端尺寸同步
- 原生 TUI 通过 PTY 启动；一个 TUI session 只有一个输入页面，避免多页同时写入
- 支持系统、浅色、深色主题。切换主题会停止并按 pi `light`/`dark` 主题重开当前 TUI
- 工作目录支持绝对路径、`~` 及旧的 `projects/` 相对路径，并提供三平台目录选择器

## 使用流程

1. 新建任务，填写标题、工作目录和任务描述。
2. 点击「打开 TUI」，系统创建子会话并在浏览器中打开 pi。
3. 在 pi 原生输入框中发送任务描述、使用 Slash Command 或继续已有会话。
4. 会话名会在首次用户消息写入 session 后更新；已运行的 pi Footer 会保留启动时名称，重新连接后显示更新后的名称。
5. 在任务卡片中终止、完成、重开或废弃任务。

## 目录结构

- `server.js`：Express API、WebSocket 与任务生命周期
- `lib/tui-executor.js`：pi PTY、输入所有权、尺寸、输出与关闭等待
- `lib/store.js`：任务持久化
- `lib/session.js`：session JSONL 解析和统计
- `public/`：原生 JavaScript、HTML、CSS 与 xterm 页面
- `docs/windows.md`：Windows 安装与使用说明

## 配置

首次启动后可编辑 `data/config.json`：

```json
{
  "port": 7777,
  "maxConcurrent": 0,
  "approvePi": true
}
```

`maxConcurrent` 为 `0` 时不限制并发；`approvePi` 控制 pi 是否自动信任项目文件。

## Windows

详见 [Windows 使用说明](docs/windows.md)。原生 TUI 使用 `node-pty`/ConPTY，并直接运行本项目安装的 pi CLI，避免 npm `pi.cmd` 的 PTY 引号问题。

## 开发检查

```bash
node --check server.js
node --check lib/tui-executor.js
node --check public/app.js
```

pi 可读取文件、执行命令和修改工作目录中的文件。仅对可信项目使用，且不要将服务暴露到公网。
