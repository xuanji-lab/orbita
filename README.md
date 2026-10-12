# ORBITA

本地优先的 AI 桌面 Agent。一个 agent、一个窗口，会话与配置都以普通文件存在你自己的电脑上。

![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)

## ORBITA 是什么

ORBITA 是一个开源的桌面端 AI Agent（Electron，macOS / Windows）。agent 内核使用
[pi](https://github.com/earendil-works/pi)（`@earendil-works/pi-coding-agent`，精确锁版本），不自写 agent 循环。

- **本地优先**：会话是 JSONL，配置是 JSON，API key 经系统钥匙串加密。没有账号、没有云端同步，数据只在你的电脑上。
- **一个 agent、一个窗口**：一个功能一个功能地长出来，每个功能都能跑通。
- **代码即真源**：读到什么就是什么，没有「声明了但没接上」的能力。

## 功能

**对话与 Agent**

- agent 跑在独立的进程里：工具输出再大也不卡界面，内核崩溃不带走窗口和没存下的会话
- 工具调用按三档权限：**规划**（只读，先出方案）／**手动**（逐条确认）／**放行**（放开跑）
- **子会话**：把独立的子任务派给子会话并行处理；子会话有问题、完成或失败时回报给你
- **会话回退**：回退到某一问，对话和这期间的文件改动一起退回
- **改动审查**：每轮结束有文件卡片，可以看 diff、逐文件撤销
- 上下文超长时自动压缩，也可以手动 `/compact`

**会话与工作区**

- 工作区就是一个项目文件夹；不属于任何项目的会话放在「任务」里
- 每个会话有自己的工作台目录，agent 的草稿、截图都放在那里
- 后台会话跑完会响一声，侧栏亮起状态条，右下角铃铛汇总所有未读
- 左下角是近 7 天的 token 用量

**右栏工具**

- **文件**：浏览工作区，文本、图片、PDF 直接预览，多标签
- **终端**：真正的终端，agent 也能开终端跑命令，你看得见、随时接手
- **内置浏览器**：agent 能打开网页、阅读、点按、截图；与你共享登录状态
- **Skills 与 MCP**：在右栏和设置里管理，按工作区启用
- **辅助对话**：在旁边开另一个会话，主对话不动

**输入框**

- 拖入或粘贴截图、文件、文件夹；图片太大时提示放进文件夹再附加
- 引用对话里的任何一段，作为编号引用发出去
- 大段粘贴自动收成胶囊；`/ ` 加空格选用 skill / MCP
- 语音听写（StepFun、豆包）

**模型接入**

- 内置 DeepSeek、智谱、Z.AI、Kimi、StepFun、OpenCode Go 等厂商目录，也能填任意 Anthropic / OpenAI 兼容端点
- API key 经系统钥匙串加密保存，不明文落盘

**迁移（设置 › 迁移）**：把其他 agent 的会话、skills 和 MCP 配置搬过来。

| 来源 | 会话 | Skills | MCP |
|---|---|---|---|
| Proma | 有（含子会话，再次导入会追加新消息） | 有 | 有 |
| Claude Code | 有 | 有 | 有 |
| Kimi Code | 有 | —（用共用目录） | 有 |
| opencode | 有 | — | 有 |
| Codex | 有 | — | 有 |
| 共用 skills 目录 `~/.agents/skills` | — | 有 | — |

只读：勾选来源并点扫描之前什么都不读；页面会列出要读的全部路径；其他应用的文件一律不改。
找不到的数据目录可以手动添加。导进来的 MCP server 默认停用。

**界面**：中英双语；主题有跟随系统、浅色、黛、玄四种。

## 实验功能

还在打磨、可能会变的功能放在 **设置 › 实验功能**，每个功能单独开关，**默认全部关闭**，每个都附更新日志。

| 功能 | 是什么 |
|---|---|
| 纸面皮肤 | 「小学作业」（中文稿纸）与「打字稿」（英文打字机）两套主题 |
| 会话生命周期 | 给会话加星标、标记完成；完成时扫描遗留事项 |
| 输入框黑洞 | 拖进来的文件被吸进输入框，从舷窗掉进上方的盒子里堆起来 |
| 俄罗斯方块 | 拖进来的文件从上方随机落下、堆起来；与输入框黑洞互斥 |
| PDF 引用 | agent 引用 PDF 原文前先核验；点正文里的编号，右栏打开 PDF 跳到原文并高亮 |

## 截图

（待补）

## 快速开始

### 下载安装包

到 [Releases](../../releases) 下载对应平台的安装包。

**macOS**（只有 Apple Silicon）：安装包是 ad-hoc 签名、未公证。第一次打开被系统拦下时，到「系统设置 › 隐私与安全性」点「仍要打开」，
或者执行：

```bash
xattr -dr com.apple.quarantine /Applications/orbita.app
```

**Windows**（只有 x64）：NSIS 安装器，可以选「仅为我安装」（不需要管理员）或「为所有用户安装」。安装器没有代码签名，
第一次运行会被 SmartScreen 拦一次，点「更多信息 › 仍要运行」。

### 从源码运行

前置：[Bun](https://bun.sh)（仓库锁定 `bun@1.3.6`）。

```bash
git clone https://github.com/xuanji-lab/orbita.git && cd orbita
bun install          # 安装依赖，同时应用 patches/ 里对 pi 的补丁
bun run dev          # 开发模式
```

启动后到 **设置 › 模型服务** 填一家模型厂商的 API key，就可以开始了。

## 数据放在哪

全部在系统的应用数据目录：macOS 是 `~/Library/Application Support/orbita/`，Windows 是 `%APPDATA%\orbita\`。

| 路径 | 内容 |
|---|---|
| `sessions/` | 会话元数据、对话记录（JSONL）与附件副本 |
| `pi-sessions/` | pi 的会话记录（续聊时模型读到的上下文） |
| `workbenches/` | 每个会话的工作台目录 |
| `settings.json`、`workspaces.json`、`providers.json` | 设置、工作区、模型厂商 |
| `secrets.json` | API key（经系统钥匙串加密） |
| `skills/`、`mcp.json` | skills 目录与 MCP 配置 |
| `usage-daily.json` | 每天的 token 用量 |

开发版用隔壁的 `orbita-dev/`，和安装版互不干扰，可以同时开。

ORBITA 不上传任何数据。你的对话只发给你自己配置的模型厂商。

## 架构速览

```
src/main/       主进程：窗口、IPC、持久化（agent 不在这里跑）
src/agent/      agent 进程：pi 跑在独立的 utility 进程里
src/renderer/   React 界面
src/shared/     跨进程契约：IPC 通道、请求与响应类型、设置 schema
patches/        对 pi 的补丁（bun patchedDependencies，安装时自动应用）
design-system/  设计 token、字体、图标
```

- 会话由 ORBITA 自己存（JSONL），pi 只当无状态循环，每轮把历史喂进去
- 内部消息协议是块数组，界面状态从块数组派生
- 持久化全部是可移植文件，原子写（临时文件 + rename），不用数据库

## 开发

```bash
bun run dev          # 开发（界面固定在 127.0.0.1:5273，端口被占当场失败）
bun run typecheck    # 类型检查
bun run test         # 测试（node --test）
bun run build        # 编译到 out/
bun run dist         # 打包 macOS arm64：dist/ 下出 dmg 与 zip
bun run dist:win     # 打包 Windows x64：dist/orbita-<version>-win-x64-setup.exe
```

构建机连 GitHub 慢、Electron 下载超时（`ETIMEDOUT`）时换镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
bun run dist:win
```

开发规范见 [AGENTS.md](./AGENTS.md)，界面设计规范见 [design-system/readme.md](./design-system/readme.md)。

## 贡献

欢迎提 Issue：bug 请写复现步骤和期望的行为，功能建议请先说场景再说诉求。

提 Pull Request 前请先读 [AGENTS.md](./AGENTS.md)：一个功能一个 PR，附最小可执行测试，`bun run typecheck` 与 `bun run test` 全过。
提交 Pull Request 即表示你同意将贡献按 AGPL-3.0 及未来的商业授权条款授权给维护者。

## License

ORBITA 采用 [GNU Affero General Public License v3.0（AGPL-3.0）](./LICENSE) 开源。

**商用授权**：如果你想把 ORBITA 集成进闭源产品、以不开源衍生代码的方式提供网络服务，或有其他无法满足 AGPL-3.0
要求的商业用途，请联系我们获取商用授权：[wafo210715@gmail.com](mailto:wafo210715@gmail.com)、[x1254211587@gmail.com](mailto:x1254211587@gmail.com)。
