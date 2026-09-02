# ORBITA

本地优先的 Electron AI 桌面 Agent。

**本分支（`clean/single-agent`）从零重建单 agent**：一次加一个能跑通的功能，一个功能一个 PR。
agent runtime 使用 pi（`@earendil-works/pi-coding-agent`），不自写循环、不引入第二套内核。

- 工作规则：[AGENTS.md](./AGENTS.md)
- 范围与架构决定：[docs/single-agent-guideline.md](./docs/single-agent-guideline.md)
- UI 设计语言真源：[Orbita Design System/readme.md](./Orbita%20Design%20System/readme.md)
- 多 agent 编排设计资产（**参考，未实现**）：`docs/architecture/orbita_v4.5.1/`

上一代实现已冻结，只作参考：`git show wip/home-view-zcode:<path>`、`origin/refactor/agent-phase-machine`。

---

## 安装

- **包管理器**：`bun`（唯一 lock writer）。
- **前置**：安装 [Bun](https://bun.sh)（本仓 `packageManager` 锁定 `bun@1.3.6`）。
- **安装依赖**：
  ```bash
  bun install
  ```
- **启动开发**（固定 `127.0.0.1:5273`，撞了当场失败）：
  ```bash
  bun run dev
  ```
- **其他常用命令**：
  ```bash
  bun run typecheck   # 类型检查
  bun run build       # 构建
  bun run test        # 测试
  ```
