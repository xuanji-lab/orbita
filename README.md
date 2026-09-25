# ORBITA

本地优先的 AI 桌面 Agent（Electron，macOS 优先）。一个 agent、一个窗口，会话与配置都以普通文件存在你自己的电脑上。

agent runtime 使用 pi（`@earendil-works/pi-coding-agent`，精确锁版本），不自写循环、不引入第二套内核。
本分支从零重建单 agent：一次加一个能跑通的功能，一个功能一个 PR。

## 现在能做什么

- **对话与工具**：agent 在独立的 utility 进程里跑（内核崩溃不带走窗口），读写文件、跑命令等工具调用按三档权限（plan / manual / skip）审批；可以派子会话并行处理子任务。
- **会话与工作区**：工作区就是一个项目文件夹；不属于任何项目的会话放在 Tasks。会话以 JSONL 存在本地，orbita 自己保存，pi 只当无状态的循环。
- **文件面板**：浏览当前工作区的文件，文本与图片直接预览。
- **Skills 与 MCP**：在设置里管理 skills（复制或链接进中心目录，按工作区启用）与 MCP servers（stdio / streamable HTTP）。
- **Providers**：接多家模型厂商（目录里有 DeepSeek、智谱、Z.AI、StepFun、OpenCode Go 等，也能填任意 Anthropic / OpenAI 兼容端点），API key 经系统钥匙串加密保存。
- **迁移（设置 › Migration）**：把其他 agent 的聊天记录、skills 和 MCP 配置搬过来。

  | 来源 | 会话 | Skills | MCP |
  |---|---|---|---|
  | Proma | 有（含子会话、再次导入追加新消息） | 有 | 有 |
  | Claude Code | 有 | 有 | 有 |
  | Kimi Code | 有 | —（用共用目录） | 有 |
  | opencode | 有 | — | 有 |
  | 共用 skills 目录 `~/.agents/skills` | — | 有 | — |

  只读：勾选来源并点 Scan 之前什么都不读，页面列出扫描会读的全部路径，其他应用的文件一律不改。
  会话按项目文件夹分组，每组选一个去向；导进来的 MCP server 默认停用。

## 安装与开发

前置：[Bun](https://bun.sh)（本仓 `packageManager` 锁定 `bun@1.3.6`，bun 是唯一的 lock writer）。

```bash
bun install          # 安装依赖
bun run dev          # 开发（renderer 固定 127.0.0.1:5273，端口被占当场失败）
bun run typecheck    # 类型检查
bun run test         # 测试
bun run build        # 构建到 out/
```

## 打包

```bash
bun run dist         # macOS arm64：dist/mac-arm64/orbita.app，另出 dmg 与 zip
bun run icon         # 重新生成 build/icon.icns（需要 macOS 的 swift / sips / iconutil）
```

打出来的包是 ad-hoc 签名、未公证，只打包不发布。本机打的包直接双击即可；从别处拷来的包被 Gatekeeper 拦下时，
执行 `xattr -dr com.apple.quarantine /Applications/orbita.app`，或到「系统设置 › 隐私与安全性」点「仍要打开」。

## 数据放在哪

全部在 `~/Library/Application Support/orbita/`：

| 路径 | 内容 |
|---|---|
| `sessions/` | 会话元数据与对话记录（JSONL） |
| `pi-sessions/` | pi 的会话本子（续聊时模型读到的上下文） |
| `workspaces.json`、`settings.json`、`providers.json` | 工作区、设置、模型厂商 |
| `secrets.json` | API key（经系统钥匙串加密） |
| `skills/`、`mcp.json` | skills 中心目录与 MCP 配置 |
| `imports.jsonl` | 迁移的导入清单 |

开发版与打包版用的是同一个数据目录，不要两个同时开。

## 文档

- 工作规则：[AGENTS.md](./AGENTS.md)
- 范围与架构决定：[docs/single-agent-guideline.md](./docs/single-agent-guideline.md)
- 通用语言：[docs/ubiquitous-language.md](./docs/ubiquitous-language.md)
- UI 设计语言真源：[Orbita Design System/readme.md](./Orbita%20Design%20System/readme.md)
- 会话存储规格：[docs/architecture/orbita_v4.5.1/28-session-storage.md](./docs/architecture/orbita_v4.5.1/28-session-storage.md)
- 多 agent 编排设计资产（参考，未实现）：`docs/architecture/orbita_v4.5.1/`
