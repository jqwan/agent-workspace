# 在 Windows 上使用 π 工作台

本文说明如何在 Windows 10 / 11 上安装、配置并运行本工作台（默认地址 `http://127.0.0.1:7777`）。

## 一、环境准备

### 1. Node.js

需要 Node.js 18 或更高版本（建议 LTS）。从 [nodejs.org](https://nodejs.org) 下载安装后，在 PowerShell 中验证：

```powershell
node --version
```

### 2. pi

工作台依赖 pi 提供模型列表和 agent 能力：

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version
```

注意事项：

- 如果提示「不是内部或外部命令」，说明 npm 全局安装目录不在 `PATH` 中。可用 `npm config get prefix` 查看全局目录，把其中的 `bin`（Windows 上通常就是该目录本身）加入 `PATH`，然后重开终端。
- Windows 下 npm 会把 `pi` 安装为 `pi.cmd`，工作台的模型列表刷新会走 shell 执行，通常无需额外处理。

### 3. bash shell（重要）

pi 在 Windows 上执行 bash 工具命令时需要一个 bash shell，按以下顺序查找：

1. `~/.pi/agent/settings.json` 中自定义的 `shellPath`
2. Git Bash：`C:\Program Files\Git\bin\bash.exe`
3. `PATH` 上的 `bash.exe`（Cygwin / MSYS2 / WSL）

对多数用户，安装 [Git for Windows](https://git-scm.com/download/win) 即可，装完后第 2 条即满足。Web 会话以 SDK 进程内运行，但任务中模型执行 bash 命令时仍会用到该 shell；如果任务里的命令无法执行，优先检查这里。

也可以自定义 shell 路径，编辑 `C:\Users\<你的用户名>\.pi\agent\settings.json`：

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

### 4. PowerShell

Windows 10 自带 PowerShell 5.x，工作台用它做两件事：

- 弹出原生目录选择对话框（选择工作目录）
- 查找并终止任务的 pi 进程（「终止执行」功能）

无需额外安装。

## 二、配置模型凭据

pi 需要至少一个可用的 provider 凭据。在工作台的终端里先运行一次 `pi`，通过 `/login` 登录订阅（Anthropic / OpenAI / GitHub Copilot 等），或 export API key（如 `ANTHROPIC_API_KEY`）。凭据保存在 pi agent 目录（默认 `C:\Users\<你的用户名>\.pi\agent\`），工作台的进程内会话使用同一目录，配置一次即可。

服务启动的环境也可以直接带 API key 环境变量，例如：

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
npm start
```

## 三、安装与启动

```powershell
cd C:\path\to\workspace
npm install
npm start
```

看到 `http://127.0.0.1:7777` 输出后，用浏览器打开该地址。

- 首次启动会生成 `data/config.json`、`data/tasks.json` 等运行时文件（不在 Git 内）。
- 端口被占用时，修改 `data/config.json` 中的 `port` 后重启。

## 四、Windows 下的行为说明

- **Web 会话**：基于 pi SDK 在 Node 进程内运行，不打开外部终端，全部功能（发送、排队、终止、Slash Command、实时事件）在 Windows 下正常可用。配置项 `terminalApp`（Terminal / iTerm2）只影响旧的 macOS 终端流程，Windows 下保持默认即可。
- **目录选择**：点击目录选择按钮会弹出 Windows 原生文件夹对话框（PowerShell Windows Forms）；点「取消」则保持原路径。
- **工作目录**：推荐填绝对路径（如 `C:\Users\name\project`）或通过目录选择器选择。以 `~` 开头的路径依赖 `HOME` 环境变量，而 PowerShell 默认不设置 `HOME`，此时 `~/xxx` 会被当作 `projects/` 下的相对路径解析，Windows 上建议直接用绝对路径。
- **终止执行**：通过 PowerShell（Get-CimInstance）按 session 文件查找 pi 进程并结束，需要 PowerShell 3.0+（Windows 8 以上自带）。
- **安全**：pi agent 可以读写文件、执行命令，请只在可信工作目录中执行任务；服务只监听 `127.0.0.1`，不要把端口转发或暴露到公网。

## 五、常见问题

| 现象 | 处理 |
|---|---|
| `pi --version` 不识别 | npm 全局目录未加入 `PATH`（见「环境准备 2」），重开终端 |
| 模型列表为空 | 先在终端运行 `pi` 完成 `/login` 或配置 API key；然后页面上点「刷新模型列表」 |
| 目录选择无反应 / 报错 | 确认 `powershell.exe` 可执行；确认杀毒软件没有拦截 PowerShell 弹出窗口 |
| 任务中命令执行失败 | 安装 Git for Windows，或在 `~/.pi/agent/settings.json` 配置 `shellPath` |
| 端口被占用 | 修改 `data/config.json` 的 `port` 后重启 |
| 杀不掉任务进程 | 确认 PowerShell 可用；必要时在任务管理器中手动结束 `node.exe` / `bash.exe` 相关进程 |
