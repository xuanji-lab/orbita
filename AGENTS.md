# ORBITA — Agent 入口（AGENTS.md）

> 本文件是所有 agent / 协作者进入本分支的必读入口。
> **维护原则**：只放「每次开工都会用到的」；深度内容路由到 `docs/`。上限 120 行——每轮对话都在为超出部分付上下文税。
> **优先级**：用户当次明示指令 > 本文件。

## 30 秒定位

ORBITA 是一个本地优先的 Electron AI 桌面 Agent。本分支**从零重建单 agent**：一次加一个能跑通的功能，一个功能一个 PR。

- **代码是唯一真源。** 读代码必须能读出系统的真实行为——这是丢掉旧内核的全部理由：
  上一版 SDK 内核 49,879 行、对外导出 332 个符号，而应用只调用其中 **9 个**运行时符号。
  代码在陈述「这里有 332 种能力」，而这个陈述是假的。**不落在调用路径上的代码不进本分支。**
- **本分支不做**：多 agent 编排、飞书、桌宠、workflow 编辑器。终端与 git 面板在做（2026-09-30 用户裁决）。
  它们的设计资产留在 `docs/architecture/orbita_v4.5.1/`，等单 agent 立住之后逐个立项。

## 必须遵守

- 包管理器是 **bun**：`bun install` / `bun run dev` / `bun run typecheck` / `bun run test`。bun 是唯一 lock writer。
- **仅使用 pi 作为 agent runtime**（`@earendil-works/pi-coding-agent`，精确锁版本，不带 `^`）。
  不得重新引入第二套内核、第二套 session 语义，也不自写 agent 循环。
  需要改 pi 的行为时走 **patch 文件**，不把 pi 源码 vendored 进仓。
- **消费者纪律**：新模块 / 新导出必须在**同一个 PR** 里有真实调用点（测试文件不算）。
  接不上就不落库，留在会话工作台等它被需要。
- **避免过度抽象**：没有第二个消费者就不建包、不建抽象层、不建 barrel。
- 禁 `any`；禁 inline import（`await import()` / `import("pkg").Type`）——顶层 import only。
- **禁 TS 参数属性（`constructor(private x: T)`）、`enum`、`namespace`**：Node 原生只剥离类型、
  不做代码生成，这些会让 `node --test` 直接加载失败。相对 import 必须带 `.ts` 后缀（同因）。
- 先调研再新增依赖，明确版本与维护状态。
- 本地优先：持久化用可移植文件（JSON / JSONL），不引入本地数据库。
  配置与会话元数据走原子写（临时文件 + rename），禁裸 `writeFileSync`。
- 功能改动附最小可执行测试（正常路径 + 主要边界）。
- 注释与日志优先中文，保留技术术语。
- **词撞了就落表**：同一词在两处指不同东西并造成过误解 / bug 时，加一行到 `docs/ubiquitous-language.md`（**该表优先于冻结的架构文档**）。

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

**契约与实现同一个 PR**：`src/shared/` 的改动放在 PR 的第一个 commit，审的人能先单看契约；只有契约、没有功能落地的改动不单独成 PR——它过不了上面的消费者纪律，也还没有被用来约束任何东西。

## 命令

```bash
bun install          # 依赖变更
bun run dev          # 开发
bun run typecheck    # 类型检查
bun run test         # 测试
```

> **dev server 固定在 `http://127.0.0.1:5273`**（只绑 IPv4 回环 + `strictPort`，撞了当场失败）。
> 停服务按 PID 杀，**不要 `pkill -f "electron-vite dev"`**——同机别的 electron-vite 应用会陪葬（陷阱史 #2）。

> **实测命令与打包**（2026-09-30，Windows 10.0.26200 实测；macOS 打包未实测）：
>
> ```bash
> bun run build        # 编译到 out/（**不能直接双击**，用 node_modules/electron/dist/electron.exe . 跑）
> bun run dist:win     # Windows x64 NSIS 安装器 → dist/orbita-<version>-win-x64-setup.exe
> bun run dist         # macOS arm64 的 dmg / zip（需 Apple Silicon，本机未实测）
> ```
>
> Windows 安装器实测跑通「出包 → 安装 → 启动 → 卸载」全链（仅为当前用户、可改安装位置、未签名会被 SmartScreen 拦一次）。
> 构建机连不上 GitHub 时（Electron / NSIS 产物下载 `ETIMEDOUT`）要加镜像环境变量，见 README 的「打包」。

## 设计系统

UI 真源是 `Orbita Design System/readme.md`，**所有用户可见渲染面无豁免区**。动手前先读它；
token 规范与实现不一致时以设计系统为准。

- 禁裸 hex / 未定义 CSS 变量；accent 只给主操作（明主题蓝、暗主题黄）。
- **禁 emoji 与 Unicode 字符当图标**——只用 lucide。状态优先用图标与文字，颜色是第二信号。
- 重视空态、键盘操作、加载态、深浅主题。

## 分支 / PR / 版本

- **一个功能一个 PR**。commit 前缀：`feat(scope):` / `fix(scope):` / `perf(scope):` / `chore(scope):` / `docs(scope):`。`perf` 只给以性能为目的、用户可见行为不变的改动，正文必须附改动前后的实测数字。
- **分支名 = `<type>/<scope>-<短描述>`；归 xiaozf99 的那条尾缀加 `-X`**。本 agent 代 xiaozf99 开的分支一律带 `-X`（如 `fix/menu-scroll-overflow-X`），别人提的分支不带——尾缀只标归属，不替代名字要说的那件事。scope 落在真实模块上，不挂计划编号。
- **commit 与 PR 标题只说功能与 bug，不说计划编号**。「A 线」「B-1」「M0/M1」是计划文档的坐标，
  计划文档最终会被删，编号随之失去所指——半年后读 `git log` 的人看到「B-1 补强二」不知道那是什么。
  标题写开发了什么 / 解决了什么（`feat(agent): read_task 给模型一份会话索引`，不是 `feat(agent): B-1 修复`）；
  非要挂编号，只能放描述正文，且要同时写出编号指代的内容。
- **不往仓里写 markdown**（硬规则）。唯一真相是**代码 + commit 历史 + commit 描述**：
  设计意图、被否决的方案与理由写进 commit message——它跟着 diff 走，不会和代码分家。
  计划、调研、progress 笔记一律留在 agent 自己的会话工作台，**不进仓**。
  `docs/plans/`、`UPDATE_NOTES.md` 及任何新增 `.md`，只在**用户当次明确点名**时才写。
  理由：多出来的文字要么过期后误导后来者，要么每轮吃上下文，而它描述的事实代码里都有。
- **版本号**：2026-09-30 起恢复使用（内测包落地，版本号进了安装包名、安装程序页与卸载项的 DisplayVersion）：
  内测期走 `0.x.y`（首个内测包 `0.1.0`），每次改动至少 patch +1；对外首发时抬 `1.0.0`。
  **必须是合法 semver**——四段号（`0.0.0.0`）electron-builder 直接拒（`Invalid version`）。
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
4. **electron-vite 的 HMR 可能静默不生效**（2026-08-31，自动滚动一刀）：改完 renderer 代码，磁盘与
   dev server 侧都是新的（`curl http://127.0.0.1:5273/src/...` 可验证），但改动前启动的 Electron 窗口
   还在跑旧模块——表现为「功能没实现」，对着不存在的 bug 排查了一整轮。
   对策：renderer 行为与代码不符时，先在窗口里 **Ctrl+R 硬刷新**再排查；刷新即从 vite 重新拉全量模块。

## 深度路由（用到再读，不要背进上下文）

| 主题 | 位置 |
|---|---|
| **单 agent 的范围、架构决定与理由** | `docs/single-agent-guideline.md` |
| **通用语言**（同一个词在两处指不同东西时，以本表为准） | `docs/ubiquitous-language.md` |
| UI 设计语言真源 | `Orbita Design System/readme.md` |
| 品牌原始资产（字体 / lucide 图标 / logo） | `design/` |
| 会话存储规格 | `docs/architecture/orbita_v4.5.1/28-session-storage.md` |
| 多 agent 编排设计资产（**参考，未实现**） | `docs/architecture/orbita_v4.5.1/` |
| 明朝制度参考（编排文档的术语背景） | `docs/architecture/ming-dynasty-reference/` |
| 旧实现（冻结，只作参考） | `git show wip/home-view-zcode:<path>`、`origin/refactor/agent-phase-machine` |
| 旧决策记录 / progress 笔记（未随分支带入） | `git show wip/home-view-zcode:docs/architecture/orbita_v4.5.1/progress/` |
| pi 上游源码（不入仓） | `~/Documents/repo/pi` |
