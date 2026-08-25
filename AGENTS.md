# ORBITA — Agent 入口（AGENTS.md）

> 本文件是所有 agent / 协作者进入本分支的必读入口。
> **维护原则**：只放「每次开工都会用到的」；深度内容路由到 `docs/`。上限 120 行——每轮对话都在为超出部分付上下文税。
> **优先级**：用户当次明示指令 > 本文件。

## 30 秒定位

ORBITA 是一个本地优先的 Electron AI 桌面 Agent。本分支**从零重建单 agent**：一次加一个能跑通的功能，一个功能一个 PR。

- **代码是唯一真源。** 读代码必须能读出系统的真实行为——这是丢掉旧内核的全部理由：
  上一版 SDK 内核 49,879 行、对外导出 332 个符号，而应用只调用其中 **9 个**运行时符号。
  代码在陈述「这里有 332 种能力」，而这个陈述是假的。**不落在调用路径上的代码不进本分支。**
- **本分支不做**：多 agent 编排、飞书、桌宠、workflow 编辑器、终端 / 浏览器 / git 面板。
  它们的设计资产留在 `docs/architecture/orbita_v4.5.1/`，等单 agent 立住之后逐个立项。

## 必须遵守

- 包管理器是 **bun**：`bun install` / `bun run dev` / `bun run typecheck` / `bun run test`。bun 是唯一 lock writer。
- **仅使用 pi 作为 agent runtime**（`@earendil-works/pi-coding-agent`，精确锁版本，不带 `^`）。
  不得重新引入第二套内核、第二套 session 语义，也不自写 agent 循环。
  需要改 pi 的行为时走 **patch 文件**，不把 pi 源码 vendored 进仓。
- **消费者纪律**：新模块 / 新导出必须在**同一个 PR** 里有真实调用点（测试文件不算）。
  接不上就不落库，写进 `docs/plans/` 等它被需要。
- **避免过度抽象**：没有第二个消费者就不建包、不建抽象层、不建 barrel。
- 禁 `any`；禁 inline import（`await import()` / `import("pkg").Type`）——顶层 import only。
- **禁 TS 参数属性（`constructor(private x: T)`）、`enum`、`namespace`**：Node 原生只剥离类型、
  不做代码生成，这些会让 `node --test` 直接加载失败。相对 import 必须带 `.ts` 后缀（同因）。
- 先调研再新增依赖，明确版本与维护状态。
- 本地优先：持久化用可移植文件（JSON / JSONL），不引入本地数据库。
  配置与会话元数据走原子写（临时文件 + rename），禁裸 `writeFileSync`。
- 功能改动附最小可执行测试（正常路径 + 主要边界）。
- 注释与日志优先中文，保留技术术语。

## 架构边界

- **agent 跑在独立 utility 进程**，不在主进程内。主进程只负责窗口、IPC 与持久化。
  理由：工具结果的大字符串处理与 JSON 序列化会和 UI 抢事件循环；内核崩溃不该带走窗口与未落盘会话；
  且这是最难后补的一刀——一旦状态在主进程里长起来，拆分要改每一处跨边界读写。
- **内部消息协议是块数组**（收编 pi 的 `AgentMessage` / `ContentBlock`）。
  扁平列表态从块数组**派生**，不是相反。适配层吸收内核差异，换内核时 renderer 不动。
- **会话由我们自己存**（JSONL），pi 只当无状态循环——每轮把历史喂进去。
  规格见 `docs/architecture/orbita_v4.5.1/28-session-storage.md`。
- 多 agent 相关字段只保留 `visibility`（单 agent 自己就需要：撤回、内部消息）。
  归属 id、父子会话等真开编排时再加——协议加字段是加法，不需要提前占位。

### IPC 是四层契约

新增 / 修改 IPC 时必须同步检查四层，漏一层就是 bug：

1. `src/shared/` 的通道常量与请求 / 响应类型（契约真源）
2. `src/main/<域>/ipc.ts` 的 `ipcMain.handle()` handler
3. `src/preload/api/<域>.ts` 的 contextBridge 暴露
4. renderer 调用 + 错误处理 + 状态更新

**`src/shared/` 的改动单独成一个 PR**，不与实现混在一起。

## 命令

```bash
bun install          # 依赖变更
bun run dev          # 开发
bun run typecheck    # 类型检查
bun run test         # 测试
```

> **dev server 固定在 `http://127.0.0.1:5273`**（只绑 IPv4 回环 + `strictPort`，撞了当场失败）。
> 停服务按 PID 杀，**不要 `pkill -f "electron-vite dev"`**——同机别的 electron-vite 应用会陪葬（陷阱史 #2）。

> 骨架落地后在此补实测命令与打包命令，并注明实测平台与日期。

## 设计系统

UI 真源是 `Orbita Design System/readme.md`，**所有用户可见渲染面无豁免区**。动手前先读它；
token 规范与实现不一致时以设计系统为准。

- 禁裸 hex / 未定义 CSS 变量；accent 只给主操作（明主题蓝、暗主题黄）。
- **禁 emoji 与 Unicode 字符当图标**——只用 lucide。状态优先用图标与文字，颜色是第二信号。
- 重视空态、键盘操作、加载态、深浅主题。

## 分支 / PR / 版本

- **一个功能一个 PR**。commit 前缀：`feat(scope):` / `fix(scope):` / `chore(scope):` / `docs(scope):`。
- 大改动前先写 `docs/plans/YYYY-MM-DD-主题.md`（设计意图 + 被否决的方案 + 为什么）；小改动不写。
  本分支**不写 progress 笔记**——PR 的 diff 与描述就是异步同步机制。
- **版本号暂停使用**：本分支尚无发布通道，版本号没有消费者，`package.json` 的 version 冻结不动。
  发布通道落地当天恢复「每次改动至少 patch +1」。
- 用户可见变更写 `UPDATE_NOTES.md`，条目按主题起标题，不绑版本号。
- 提交前 `git diff` / `git status` 核对：不含无关文件、不覆盖他人未提交改动。

## 工程陷阱史（真实事故，新会话必读）

1. **`.gitignore` 的全局 `src/` 与 `*.d.ts` 规则会静默吞掉新文件**——已咬三次（吞 SDK 包源码两次、
   吞设计系统 20 份 `.d.ts` 一次）。**新增目录入库后必须核对「磁盘文件数 == `git add -An` 行数」**，不等就是有东西被吞了。
2. **`pkill -f "electron-vite dev"` 会打死同机其它 electron-vite 应用**——已咬一次（2026-08-25，
   打死了用户正在跑的 proma）。真正难查的后果是**双栈**：macOS 允许一个进程绑 `127.0.0.1:5173`、
   另一个绑 `[::1]:5173`，两个 bind **都成功**，`strictPort` 拦不住；而 `localhost` 解析到谁
   取决于客户端（curl 走 IPv4、Chrome 常偏好 IPv6），于是同一个 URL 在两个工具里指向两个不同的应用——
   截图验收对着别人的应用拍了整整一轮才被发现。
   对策：renderer 固定 `host: "127.0.0.1"` + `port: 5273` + `strictPort: true`（只绑一个地址族，
   撞了当场失败）；脚本里用 `127.0.0.1:5273` 而不是 `localhost`；
   **停服务只按自己记下的 PID 杀，不用 `pkill -f` 匹配进程名**。
3. **改根 `overrides` 里的构建工具版本会打死依赖它的 runner**——vite 7 的 override 曾让全仓 vitest
   在 transform 阶段整片失败且长期没被发现。改 overrides 必须回头核对依赖它的 runner 的版本区间。

## 深度路由（用到再读，不要背进上下文）

| 主题 | 位置 |
|---|---|
| **单 agent 的范围、架构决定与理由** | `docs/single-agent-guideline.md` |
| UI 设计语言真源 | `Orbita Design System/readme.md` |
| 品牌原始资产（字体 / lucide 图标 / logo） | `design/` |
| 会话存储规格 | `docs/architecture/orbita_v4.5.1/28-session-storage.md` |
| 多 agent 编排设计资产（**参考，未实现**） | `docs/architecture/orbita_v4.5.1/` |
| 明朝制度参考（编排文档的术语背景） | `docs/architecture/ming-dynasty-reference/` |
| 旧实现（冻结，只作参考） | `git show wip/home-view-zcode:<path>`、`origin/refactor/agent-phase-machine` |
| 旧决策记录 / progress 笔记（未随分支带入） | `git show wip/home-view-zcode:docs/architecture/orbita_v4.5.1/progress/` |
| pi 上游源码（不入仓） | `~/Documents/repo/pi` |
