# 在 Windows 上使用 π 工作台

工作台默认仅监听 `http://127.0.0.1:7777`，会在浏览器的 xterm 中运行 pi 原生 TUI。

## 环境

1. 安装 Node.js 18 或更高版本（推荐 LTS）。
2. 在工作台目录执行 `npm install`。`node-pty` 会使用 Windows ConPTY；若没有匹配的预编译二进制，需要安装 Visual Studio C++ Build Tools 以供 node-gyp 编译。
3. 安装并登录 pi，或配置所用 provider 的 API Key。pi 执行 bash 工具通常还需要 Git for Windows 提供的 `bash.exe`。

```powershell
node --version
pi --version
npm install
npm start
```

## 原生 TUI

- 会话界面只有原生 TUI，不再提供 SDK/Web 会话模式。
- 终端由 `node-pty`/ConPTY 启动本项目安装的 pi CLI，不经过 `pi.cmd`，避免 ConPTY 中的引号问题。
- 鼠标滚轮会转换为 pi 的 SGR 鼠标滚轮事件；键盘 `PageUp`/`PageDown` 保持 pi 原有行为。
- 输入法候选框依赖 xterm 的可见硬件光标。建议使用 Edge、Chrome 或 Firefox 的最新版本。
- 切换网页主题会安全停止并按新的 `light`/`dark` pi 主题重开当前 TUI。请避免在模型生成的关键时刻切换主题。

## 目录与安全

目录选择器使用 PowerShell 的原生文件夹对话框。工作目录可使用绝对 Windows 路径，例如 `C:\Users\name\project`。pi 可读写文件并执行命令，仅应在可信工作目录中使用，且不要将本服务暴露到公网。
