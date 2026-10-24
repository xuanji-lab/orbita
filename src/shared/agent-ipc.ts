/**
 * agent 域契约 —— IPC 四层的第 1 层。
 *
 * 两条边界共用这一份定义：
 *   主进程 ↔ agent utility 进程（parentPort 信封）
 *   主进程 ↔ renderer（ipcMain / contextBridge）
 * 两边搬运的载荷都是 **pi-protocol 的类型**，我们只定义信封（guideline §三）。
 *
 * sessionId 从第一天就贯穿所有消息：一个 agent runtime 进程要托管 N 个 session，
 * 事后再补这个参数意味着每一处状态读写都要回头改。
 */
import type { SessionPhase, ThinkingLevel as PiThinkingLevel, TranscriptProgress } from "@earendil-works/pi-protocol";
import type { PermissionAnswer, PermissionMode } from "./permission.ts";
import type { ThinkingLevel } from "./thinking.ts";
import type { McpServer, McpStatus, McpStatusSnapshot } from "./mcp.ts";
import type { ModelDecl } from "./provider.ts";
import type { CompactedRecord } from "./session.ts";
import type { FileChangePayload, FileChangeView } from "./revert.ts";
import type { PromptImage, SentImage } from "./prompt-images.ts";
import type { PromptFileRef, SentFileRef } from "./prompt-attachments.ts";
import type { CompactionSetting, Language } from "./settings.ts";
import type { BrowserToolOutcome, BrowserToolRequest } from "./browser.ts";
import type { ComputerUseToolOutcome, ComputerUseToolRequest } from "./computer-use.ts";
import type { TerminalToolOutcome, TerminalToolRequest } from "./terminal.ts";
import type {
  ChannelDelivery,
  ChannelKey,
  ChannelMessage,
  ChannelMessageKind,
  ChannelStatus,
} from "./channel.ts";
import type { IntentRecallModels } from "./intent-lab.ts";
import type { IntentAskView, IntentRecallStreamEvent } from "./intent-recall.ts";
import type { IntentConfirmDecision } from "./intent-confirm.ts";
import type { IntentRecallRecord } from "./session.ts";

export const ipcChannels = {
  providerList: "provider:list",
  providerUpsert: "provider:upsert",
  providerRemove: "provider:remove",
  /** 拖拽排序的落盘：载荷是全量 id 的新顺序 */
  providerReorder: "provider:reorder",
  agentSubmit: "agent:submit",
  agentAbort: "agent:abort",
  /** 把排队中的某一条**立即**发出：打断当前轮（含正在跑的工具调用），它成为新一轮 */
  agentInterrupt: "agent:interrupt",
  /** 手动压缩上下文（输入框 `/compact`）。结果走 agent:event 的 compaction 链 */
  agentCompact: "agent:compact",
  agentSetMode: "agent:set-mode",
  /** 会话内改思考档：下一轮生效（同 setModel 的语义）。只落 meta，不经 agent 进程 */
  agentSetThinkingLevel: "agent:set-thinking-level",
  /** 会话内换模型（C-4）：下一轮生效。结果走 agent:event 的 model / failed 事件 */
  agentSetModel: "agent:set-model",
  agentAnswerPermission: "agent:answer-permission",
  /** 意图确认卡的应答（实验功能 intent-system）：载荷 requestId + IntentConfirmDecision，回 void */
  agentAnswerIntentConfirm: "agent:answer-intent-confirm",
  /**
   * 意图系统（实验）的三条主进程 HTTP 通道：
   * - intent:health —— 探活 intent-lab（GET /health），回 IntentHealth | null
   * - intent:edges —— 某一问的图数据（GET /edges?sessionId=&turnId=），回 IntentEdges | null
   * renderer 不直连 intent-lab（沙盒里的 fetch 也该有四层契约的边界）。
   */
  intentHealth: "intent:health",
  intentEdges: "intent:edges",
  agentEvent: "agent:event",
  workspaceList: "workspace:list",
  /** 打开原生目录选择器并加为工作区 */
  workspaceAdd: "workspace:add",
  workspaceRename: "workspace:rename",
  workspaceRemove: "workspace:remove",
  /** 没有选定工作区时 agent 落在哪儿。渲染层要如实告诉用户这个兜底，不能让它是个隐形默认 */
  workspaceDefault: "workspace:default",
  /**
   * 命名新建：在 `~/Orbita/<name>/` 建文件夹并加为工作区。建完就是普通工作区，
   * 与「选已有文件夹」无差别——只有一种工作区，没有 Proma 那种「托管空白工作区」。
   * 同名文件夹已存在就直接加它（不覆盖、不报错）。
   */
  workspaceCreate: "workspace:create",
  /** 打开原生目录选择器，把选中目录加进工作区的 attachedDirs；重复加不报错、不重复 */
  workspaceAttachDir: "workspace:attach-dir",
  /** 从 attachedDirs 移除一条；不在列表里不报错 */
  workspaceDetachDir: "workspace:detach-dir",
  providerBuiltins: "provider:builtins",
  providerDiscover: "provider:discover",
  providerTest: "provider:test",
  providerReveal: "provider:reveal",
  /**
   * Claude 订阅账号的 OAuth 登录：主进程起回调服务器 + 开系统浏览器，成功后直接
   * 落盘 provider 与凭据，返回 UpsertResult。凭据（access / refresh token）全程
   * 不进 renderer——登录本身就是保存。
   */
  providerOauthLogin: "provider:oauth-login",
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  /**
   * 数据目录的绝对路径（`app.getPath("userData")`），无参，回 `string`。
   * 会话、工作区、skills、mcp.json 都以明文文件住在这里——本地优先的应用，数据住哪要能一行说清。
   * 消费者是设置 General 页的 Data directory 行。
   */
  settingsDataDir: "settings:data-dir",
  /**
   * 在 Finder 里打开数据目录本身（`shell.openPath`，同 Skills 面板 footer 的 Reveal），无参，回 `void`。
   * 不复用 `fs:reveal`（白名单只放会话的三类根）也不复用 `provider:reveal`（那条取的是 API key）。
   */
  settingsRevealDataDir: "settings:reveal-data-dir",
  sessionList: "session:list",
  /**
   * 打开一条会话：只回**尾窗**（SESSION_PAGE_RECORDS 条，起点对齐到轮边界）+ 窗口信息。
   * 主进程仍全量读盘 + 折叠，切的是 IPC 传输量与 renderer 渲染量（瓶颈所在）。
   */
  sessionLoad: "session:load",
  /** 拉更早的一页（滚动触顶）：载荷 (id, before 记录 id, limit)，回 SessionOlderPage */
  sessionLoadOlder: "session:load-older",
  sessionRename: "session:rename",
  sessionPin: "session:pin",
  /** 星标：价值标记，不参与排序（排序只认 pinned）；消费者是侧栏标识与筛选 chip */
  sessionStar: "session:star",
  /** 完成状态：open → done/done_with_todos 记关闭时刻，reopen 清空；消费者是侧栏菜单/标识、会话头部按钮与筛选 chip */
  sessionSetCompletion: "session:set-completion",
  /**
   * 意图召回的会话级开关（实验功能 intent-system）：载荷 (sessionId, boolean)，回 void。
   * 只落 meta（intentEnabled），下一轮开轮时主进程现读现装配；输入框旁的小开关用。
   */
  sessionSetIntentEnabled: "session:set-intent-enabled",
  /**
   * 未读标记（后台跑完还没看）：载荷 `{ at, failed } | null`，null / 缺席即已读。
   * 消费者是侧栏行首竖条与右下角铃铛清单——两处读同一份 meta，重启后仍在。
   * 是否标未读由 renderer 判（没在看才标，planNotice）。
   */
  sessionUnread: "session:unread",
  sessionArchive: "session:archive",
  /** 换归属工作区；null = 移出所有工作区，回到 TASKS */
  sessionMove: "session:move",
  /**
   * 从某条 agent 回答另起一支（C-2）：保留该回答及之前的全部，开出一条新会话。
   * 返回新会话 id；对不上账（罕见落账漂移）时以错误拒绝——宁可不分支，不切错位置。
   */
  sessionBranch: "session:branch",
  /**
   * 读一张附图的原图（看大图时用）。载荷是转录图块上的 `original` 引用（`SentImage`），
   * 回 `PromptImage`；引用不合格或文件不在（源会话已删）回 null，调用方退回缩放图。
   */
  sessionAttachment: "session:attachment",
  /** 导出成 Markdown，走原生保存对话框；取消返回 null */
  sessionExport: "session:export",
  sessionDelete: "session:delete",
  /**
   * 给导入的会话分配模型（设置 › 服务商的「分配模型」）：还挂着占位 provider 的会话
   * 按原模型名分组统计（回 ModelAssignGroups）。只读，提示行与预览都吃它。
   * 契约与匹配纯函数在 `model-assign.ts`
   */
  modelAssignGroups: "model-assign:groups",
  /**
   * 执行分配（入参 ModelAssignEntry[]，回 ModelAssignRunResult）：主进程写入前再校验
   * 目标仍存在、会话仍是占位——期间被用户改过的跳过，绝不覆盖手选的模型
   */
  modelAssignRun: "model-assign:run",
  /**
   * 会话工作台的现状（文件系统 2026-09-22）：路径、存不存在、里面有几个文件。
   * 消费者是删除确认（「提示后删」：删会话连带删工作台，确认项要把文件数说出来）与文件面板的 Session 根。
   * 按需现算，不进 meta——工作台存不存在是磁盘上的事实，不是会话的状态。
   */
  sessionWorkbenchStat: "session:workbench-stat",
  /** 父会话的通道列表：载荷父 id，回 `ChannelSummary[]`（只含 hasExchange 或 running 的，主进程按账本现算——通道列与右栏 Sub-sessions 面板列表层共用它） */
  channelList: "channel:list",
  /** 读一份通道账本：载荷 `ChannelKey`，回时间正序的 `ChannelMessage[]`（打开通道看全文时拉取） */
  channelLoad: "channel:load",
  /** 用户在通道里代父发言（Speak as parent）：载荷 `ChannelSpeakInput`，回主进程铸好的 `ChannelMessage` */
  channelSpeak: "channel:speak",
  /**
   * 用户终止一个子会话：载荷 `ChannelStopInput`，回 void。三步：在跑就中止这一轮
   * （agent:abort）、挂着的浏览器交接按取消结掉（BrowserSandbox.cancelSessionHandoff）、
   * 通道里落一条 parent 侧的 stop（状态翻 stopped）。stopped 后父模型的发信被拒
   * （applyChannelSend），只有用户代父发言（channel:speak 的 author user reply）能重开
   */
  channelStop: "channel:stop",
  /** 主进程 → renderer 推送（`ChannelEvent`）：新消息落账或通道状态变化 */
  channelEvent: "channel:event",
  /** 文件面板（契约在 `files.ts`）：这条会话的根清单（工作台 / 工作区 / 附加目录），主进程算 */
  fsRoots: "fs:roots",
  /** 列一层目录。root 必须是 fs:roots 回过的，dir 必须在 root 之内，否则拒绝——renderer 不是通用文件浏览器 */
  fsList: "fs:list",
  /** 在 Finder 里显示一个路径（同 root/dir 白名单） */
  fsReveal: "fs:reveal",
  /**
   * 读一个文件给面板预览（同 root/dir 白名单，`dir` 就是文件路径，同 fs:reveal）。
   * 回 `FilePreview`（files.ts）：文本截断到 PREVIEW_TEXT_LIMIT、图片过大不读，由主进程判——
   * renderer 在 sandbox 里没有文件系统访问权，也不该自己决定读多少。
   */
  fsRead: "fs:read",
  /**
   * 读一个 PDF 的字节给预览面板渲染（同 root/dir 白名单，回 `PdfFile`，files.ts）。
   * 与 fs:read 分开：fs:read 对二进制只回 kind，不读内容；PDF 要整份字节
   */
  fsReadPdf: "fs:read-pdf",
  /** 用系统默认应用打开一个文件（同 root/dir 白名单）；预览不了或想编辑时的出口 */
  fsOpen: "fs:open",
  /**
   * 在内置浏览器「你的」tab 里打开一个网页文件（同 root/dir 白名单，且须 isWebPageFile）。
   * 网页文件的默认打开方式——系统默认应用（fs:open）退为次要按钮
   */
  fsOpenInBrowser: "fs:open-in-browser",
  /**
   * 把一批绝对路径 stat 成盘上事实（回 `FsEntryFact[]`，与路径等长同序：kind 是
   * file / dir 还是 null、size 多大）。消费者是输入框的附件分拣与文件面板的已发送
   * 附件列表：拖入 / 粘贴的 `File` 对象在 renderer 里分不清是文件还是目录，主进程
   * 发送时的 lstat 纠正来得太晚——图标与名字当场就该是对的；面板那侧还要靠它
   * 如实标出已不在盘上的附件。不走面板的根白名单——拖入条目本来就在三根之外
   * （发送时复制或原位置引用），问类型不构成通用文件浏览器：不读内容、不列目录。
   */
  fsStatKind: "fs:stat-kind",
  /**
   * 开系统目录选择器（openDirectory + multiSelections），回选中目录的绝对路径数组，
   * 取消返回 null。给输入框回形针的「添加文件夹」用——Windows 不允许同一个对话框
   * 同时 openFile + openDirectory，文件与文件夹只能分两个入口（文件仍走隐藏 input）。
   */
  fsPickFolders: "fs:pick-folders",
  /** 遗留事项（收尾仪式收割）：全部清单。侧栏面板、角标与「Has todos」筛选都吃它，按 sourceSessionId 现算 */
  carryoverList: "carryover:list",
  /** 每日 token 用量：最近 7 天（含今天，旧的在前；载荷形状在 shared/usage.ts）。回 `UsageDayTotal[]`，回填还在跑时可能是全 0——跑完会经 usage:event 推一份真值 */
  usageWeek: "usage:week",
  /** 主进程 → renderer 推送：用量账本每次变化（模型调用落账 / 回填完成）推一份新的 7 天快照（`UsageWeekEvent`） */
  usageEvent: "usage:event",
  /** 自动更新：拉当前快照（`UpdaterSnapshot`，载荷形状在 shared/updater.ts）。之后的状态变化走 updaterState 推送 */
  updaterGet: "updater:get",
  /** 自动更新：手动检查（启动首查与 4h 定时在 main/updater/service.ts） */
  updaterCheck: "updater:check",
  /** 自动更新：用户确认后开始下载（autoDownload=false，库不自己下） */
  updaterDownload: "updater:download",
  /** 自动更新：取消正在进行的下载，退回 available */
  updaterCancel: "updater:cancel",
  /** 自动更新：退出并安装已下载的更新（quitAndInstall，安装前先收掉 agent utility 进程） */
  updaterInstall: "updater:install",
  /** 主进程 → renderer 推送：更新状态每次变化推一份完整快照（`UpdaterSnapshot`） */
  updaterState: "updater:state",
  /** 自动更新：最近几个版本的 Release 列表（`RecentReleasesResult`，主进程打 GitHub API 并缓存 10 分钟） */
  updaterRecentReleases: "updater:recentReleases",
  /** 批量落盘（收尾仪式确认的那一拨）；id/status/时间戳由主进程铸，返回完整记录 */
  carryoverCreate: "carryover:create",
  /** 翻转一条的状态：done 记 doneAt，回 open 清掉 */
  carryoverSetStatus: "carryover:set-status",
  /** 会话回退：算计划（确认框列清单用），不执行 */
  sessionRevertPlan: "session:revert-plan",
  /** 会话回退：撤回目标消息及之后全部（对话 + pi 本子 + 文件快照） */
  sessionRevert: "session:revert",
  /** 单轮撤销：算计划（确认框列清单用），不执行 */
  sessionUndoPlan: "session:undo-plan",
  /** 单轮撤销：只还原这一轮改过的文件，pi 本子追加一条告知模型 */
  sessionUndo: "session:undo",
  /** 轮尾产物打开方式一：在内置浏览器「你的」tab 打开网页文件（仅会话文件账里的 .html/.htm/.svg） */
  sessionOpenArtifactInBrowser: "session:open-artifact-in-browser",
  /** 轮尾产物打开方式二：在系统文件管理器里定位它（仅会话文件账里记过的文件） */
  sessionRevealArtifact: "session:reveal-artifact",
  /** 审查面板：列一个来源的全部改动（task / unstaged / staged / branch） */
  reviewList: "review:list",
  /** 审查面板：拉一个文件的 diff 正文（unified diff，按需） */
  reviewDiff: "review:diff",
  /** 专注模式：一个工作区此刻的 U / M 改动（含增删行数与当前分支名，载荷形状在 shared/focus.ts）。git 只读，与审查面板同一套 git-source */
  focusChanges: "focus:changes",
  /** 专注模式：时间到的系统通知（Electron Notification，点按聚焦窗口；载荷 FocusNotifyRequest） */
  focusNotifyDone: "focus:notify-done",
  /**
   * 专注模式：剩 5 分钟起跑的收工小结（载荷 FocusSummaryRequest / FocusSummaryResult）。
   * 主进程归拢素材（时段内有活动的所有会话 + 所选工作区 U/M），家务活模型在 agent
   * 进程里独立调用（不开会话、不落盘，同 classifyGreetings 的通道）。
   */
  focusSummarize: "focus:summarize",
  /** 探测迁移来源：只 stat 固定清单里的路径，不读内容（返回 ImportDetectResult） */
  importDetect: "import:detect",
  /** 扫描勾选的来源（dry-run，入参 ImportScanInput）：产出可导入计划与跳过明细 */
  importScan: "import:scan",
  /** 执行导入（入参 ImportRunInput）：主进程重新扫描，按用户的选择与去向落盘（不接收计划，理由见 shared/import.ts） */
  importRun: "import:run",
  /**
   * 迁移的可选检查（入参 ImportGreetingCheckInput）：用子会话模型判断哪些新会话只是随手发的一句
   * hi / test（返回 ImportGreetingCheckResult）。只判断、不落盘
   */
  importCheckGreetings: "import:check-greetings",
  /**
   * 自定义来源路径：添加（入参 ImportCustomRootInput）——目录经该来源 validate 过才落盘，
   * 失败抛稳定错误码 IMPORT_CUSTOM_ROOT_INVALID:*；成功返回更新后的清单（ImportCustomRoot[]）
   */
  importCustomRootsAdd: "import:custom-roots:add",
  /** 自定义来源路径：移除一条（入参 ImportCustomRootInput），返回更新后的清单 */
  importCustomRootsRemove: "import:custom-roots:remove",
  /** 目录选择框（renderer 无文件系统权，主进程开）：选中返回绝对路径，取消返回 null */
  importPickDirectory: "import:pick-directory",
  /** 中心存储里的全部 skill（含没链进任何集合的） */
  skillList: "skill:list",
  /** 把 skill 链进一个集合（global 或某个 workspace）；互斥规则见 SkillScope */
  skillLink: "skill:link",
  /** 把 skill 从一个集合里移出（只删链接，永不碰中心存储） */
  skillUnlink: "skill:unlink",
  /** 清掉一条 skill 的全部断链引用（missing 后的收尾动作） */
  skillClean: "skill:clean",
  /** 导入用户已有目录：主进程开目录选择框，store 条目做成指向真身的 symlink（4-1）。返回 slug，取消返回 null */
  skillImport: "skill:import",
  /** 读详情（已拆成 name / description / 正文）；不存在返回 null */
  skillRead: "skill:read",
  /** 改详情。缺席的字段不动，frontmatter 其它字段原样保留 */
  skillWrite: "skill:write",
  /** 在系统文件管理器里揭示该 skill 目录（新建 / 删除走这里，不自建 UI） */
  skillReveal: "skill:reveal",
  /** MCP server 列表与它们此刻的连接状态 */
  mcpList: "mcp:list",
  /** 用系统默认编辑器打开 mcp.json（加减 server 走文件，不做表单） */
  mcpOpenConfig: "mcp:open-config",
  /** 重读 mcp.json 并拆掉全部 MCP 连接（下一轮开机按新配置重建；已开任务的工具集不变） */
  mcpReload: "mcp:reload",
  /** 加一台 server（4-2）：写 mcp.json 后自动重连 */
  mcpAdd: "mcp:add",
  /** 删一台 server（4-2）：写盘后自动重连 */
  mcpRemove: "mcp:remove",
  /** 启停一台 server（4-2）：改 disabled 字段后自动重连 */
  mcpSetDisabled: "mcp:set-disabled",
} as const;

export type IpcChannel = (typeof ipcChannels)[keyof typeof ipcChannels];

/**
 * pi 内建 provider 目录里的一条。目录由 pi 维护、每 4 小时从 pi.dev 刷新覆盖层，
 * 我们零维护——用户选中名字就拿到官方 baseUrl / 协议 / 模型清单。
 */
export interface BuiltinProvider {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  models: BuiltinModel[];
}

/**
 * 目录模型自带的官方参数（费率单位 $ 每百万 token；pi 的分段计价 tiers 剥掉——无消费者）。
 * 只服务设置面的展示与占位：真正建会话时 runtime 直接从 pi 注册表取活值。
 */
export interface BuiltinModel {
  id: string;
  contextWindow: number;
  maxTokens: number;
  /**
   * 目录声明的输入模态。**要过 IPC 到 renderer**：模型行的图片徽标与弹窗的
   * 「Inherit」档位都得知道这个 id 到底能不能吃图，否则用户只能靠手动开关猜。
   */
  input: ("text" | "image")[];
  /** 能不能思考（目录 / 白名单口径）。可选：不认识就缺席，消费方兑 false——「不确定就不发」 */
  reasoning?: boolean;
  /**
   * 这个模型真实支持的思考档（pi 的 getSupportedThinkingLevels 在 agent 进程算好，
   * 只以数据过 IPC——派生结论不建第二份真源）。缺席 = 未知：菜单按全量显示，
   * 开轮后由 thinking 事件纠真。
   */
  supportedThinkingLevels?: ThinkingLevel[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/**
 * 一次自动重试的等待态。对话主链路（auto_retry）与压缩/摘要的 LLM 调用
 * （summarization_retry）共用同一份形状。startedAt 由 agent 进程盖时间戳——
 * renderer 据此算活倒数，切走再切回不重启；事件不落盘，旧会话没有历史重试。
 */
export interface RetryStatus {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  /** 等待开始的时刻（epoch ms，agent 进程时钟） */
  startedAt: number;
  errorMessage: string;
}

/**
 * 一条会话到此刻的用量。**pi 的 `SessionStats` 只搬界面要显示的那几项**（D1，2026-09-03）。
 *
 * 为什么不直接透传 pi 的类型：
 * 1. 透传会把 `@earendil-works/pi-coding-agent` 漏进 shared 契约，而 AGENTS.md 的架构边界
 *    写的是「适配层吸收内核差异，换内核时 renderer 不动」。
 * 2. 它要**落盘**（`SessionMeta.stats`）。落盘的形状必须是我们自己拥有、能逐字段校验的，
 *    不能是 pi 随时可能加字段的结构。
 * 3. pi 的 `SessionStats` 里我们只用 3/10 个字段（sessionFile / sessionId / 四个计数都无消费者）。
 *
 * 口径随 pi：跨整条 session 累计，**包含已经被压缩掉的那些历史**——那些 token 是真花了钱的。
 */
export interface AgentStats {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  /** 累计花费（美元）。provider 没有价目表时是 0——**0 不是免费，是不知道** */
  cost: number;
  /**
   * 上下文占用。**压缩刚做完、下一次模型响应之前 pi 自己也不知道**，那时 `tokens` 是 null，
   * 界面要如实留白而不是显示 0（显示 0 会让人以为上下文被清空了）。
   * `null` 本体 = 连窗口都不知道（pi 的 `contextUsage` 缺席）。
   */
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | null;
}

/**
 * create / setModel 共用的 provider 装配载荷。**明文密钥只在主进程 → agent 进程
 * 这一跳出现，永不进 renderer**——renderer 侧只报 id，主进程负责装配。
 * 内建 id（zai / deepseek…）只靠 apiKey 就够，自建网关必须带 baseUrl / api / models，
 * 否则 pi 不知道往哪发。models 上的可选参数字段是用户覆盖声明（用户 > pi 目录 > 兜底）。
 */
export interface ProviderSecrets {
  id: string;
  api: string;
  baseUrl: string;
  /** api_key 的明文，或 OAuth 的访问令牌（sk-ant-oat…，pi 端自动切换 Bearer 头） */
  apiKey: string;
  headers?: Record<string, string>;
  models: ModelDecl[];
}

/**
 * `provider:oauth-login` 的入参。登录即保存：主进程成功后 upsert 这条 provider
 * （scheme oauth）并落盘凭据。重登录（create=false）时模型清单沿用盘上的——
 * 换令牌不该把用户配好的模型一并抹掉。
 */
export interface OauthLoginInput {
  id: string;
  displayName: string;
  /** 新建时 true（id 撞名拒绝）；已有 provider 重登录时缺省 */
  create?: boolean;
  /** 仅 create 时生效：登录后启用的模型清单（一般空，登录后用 Fetch 拉取） */
  models?: ModelDecl[];
}

/**
 * 一轮 agent 调用的完整开工上下文（runtime 无状态化后每次都要带）：
 * pi 只当无状态循环，每轮开 → 跑 → 销毁，「建会话」不再是独立的一步——
 * 原本 create 需要的全部上下文，随每次 submit / interrupt / compact 一起给。
 * renderer 只报 providerId，明文密钥由主进程装配（ProviderSecrets）后发给 agent 进程。
 */
export interface AgentTurnContext {
  sessionId: string;
  cwd: string;
  /** 这条会话属于哪个工作区；null = 不属于任何工作区（侧栏 TASKS 节点下那些）。首次 submit 时主进程用它建 meta */
  workspaceId: string | null;
  /**
   * 续跑 pi 的本子：把它自己的 session 文件路径还给 pi（`SessionManager.open`）；
   * null = 开新本子（`.create`）。
   */
  resume: { piSessionFile: string } | null;
  providerId: string;
  modelId: string;
  mode: PermissionMode;
  /**
   * 这轮跑在哪一档思考上。**必填**（同 mode 的理由）：可选就会静默退到
   * pi 解析链的用户全局配置——正是这一刀要修的病。真源是 SessionMeta，
   * 主进程与 renderer 都从它读；模型 clamp 后的真值经 `thinking` 事件回传。
   */
  thinkingLevel: ThinkingLevel;
}

/** 发一轮（renderer → 主进程的载荷） */
export interface SubmitAgentInput extends AgentTurnContext {
  text: string;
  /**
   * 随这条消息发的图片（原图 base64，缩放在 agent 进程做）。缺席 / 空 = 纯文本。
   * 有图时 text 可以为空串——只发一张截图也是一句完整的话。
   */
  images?: PromptImage[];
  /**
   * 随消息引用的文件（**纯路径，不携内容**，模型用 read 工具自己读）。
   * external 的由主进程在发送前复制进会话附件目录并改写指向；落盘与组装的语义
   * 见 `shared/prompt-attachments.ts`。
   */
  files?: PromptFileRef[];
  /** 随消息发的粘贴文本块（全文、永不截断），按加入顺序；agent 进程组装进正文之后 */
  pasted?: string[];
}

/** 手动压缩（renderer → 主进程）。压缩是一次真实的 LLM 调用，同样要带全套开工上下文 */
export interface CompactAgentInput extends AgentTurnContext {
  instructions?: string;
}

/** `session:workbench-stat` 的回执。目录不存在时 exists=false、fileCount=0；fileCount 递归计文件不计目录 */
export interface SessionWorkbenchStat {
  path: string;
  exists: boolean;
  fileCount: number;
}

/**
 * 开轮目录清单（文件系统 2026-09-22 裁决）。一个工作区就是一个用户能在 Finder 里打开的文件夹（cwd）；
 * 附加目录挂在工作区上；工作台属于会话、住在 userData。三者都只是告知模型「可以去哪」。
 */
export interface TurnDirectories {
  /** 工作区的附加目录（`Workspace.attachedDirs`），绝对路径，按用户挂上的顺序。Home 会话恒为空 */
  attached: string[];
  /**
   * 本会话的工作台 `<userData>/workbenches/<sessionId>/`：plan / handoff / 草稿的落点。
   * **目录可能还不存在**（首次写入才建，空会话不占目录），模型用时自己 mkdir。
   * 不套在 sessions/ 里：protectedPaths 把整个 sessions/ 设为工具面只读，工作台必须可写。
   */
  workbench: string;
  /**
   * 父子会话互见对方的工作台（子会话 2026-09-23 裁决）：父的清单列每个子会话的、
   * 子的列父的。**只告知不硬拦**（同 attached）：label 是对方会话的标题，path 是对方
   * 工作台的绝对路径——父子各自工作台独立，但「任务说明在那个目录里」这件事
   * 对面的模型该知道。
   *
   * `sessionId` 是对方会话的 id——`reply_subsession` 要靠它定位子会话。
   * `relation` 是**对方**相对本会话的角色（子会话清单里父那一项是 `"parent"`、
   * 父会话清单里每个子是 `"child"`）：runtime 靠它判断本会话是不是子会话，
   * 决定注册哪些通道工具、讲哪段提示词——仅凭 label/path 分不出「列的是父还是子」
   * （父有子时 related 也非空）。
   *
   * 缺席 = 没有父子关系（绝大多数会话）。
   */
  related?: { sessionId: string; relation: "parent" | "child"; label: string; path: string }[];
  /**
   * 受管浏览器「你的」tab 的下载目录（设置 › 浏览器，缺席 = 系统下载文件夹）。用户在浏览器里
   * 下载的论文、导出文件落在这里；agent 可读写，帮用户按对话整理。只告知不硬拦（同 attached）。
   */
  browserDownloads?: string;
}

/** `channel:speak` 的载荷：用户在通道 composer 里代父发的那句话 */
export interface ChannelSpeakInput {
  parentId: string;
  childId: string;
  text: string;
  /** 投递方式（默认 steer，可切 turn end = followUp）：子在跑时注入不断轮，子空闲退化普通开轮 */
  delivery: ChannelDelivery;
}

/** `channel:stop` 的载荷：用户终止这个子会话（语义见 ipcChannels.channelStop 的注释） */
export type ChannelStopInput = ChannelKey;

/**
 * 意图系统（实验功能 intent-system）的开轮装配（submit / interrupt 共用）。
 * **主进程装配**（同 skillsDirs / directories 的纪律）：开关状态、intent-lab 地址、
 * 渠道与模型选择、会话标题都从设置与 meta 现算，agent 进程只收数据。
 * 缺席 = 开关关闭或这一轮不召回，runtime 走与 main 完全一致的路径。
 */
export interface IntentTurnContext {
  /** intent-lab 服务地址（settings.intent.baseUrl，缺省 http://127.0.0.1:8723） */
  baseUrl: string;
  /** 会话标题（meta.title；没生成就空串，契约允许） */
  title: string;
  /** 按渠道解析好的 /recall models 覆盖（INTENT_MODELS_BY_CHANNEL）；缺席 = 不带字段 */
  models?: IntentRecallModels;
}

/** `channel:event` 的推送载荷。status 是派生值（channelStatus），主进程算好推——
renderer 不必为更新通道列的状态徽标拉一份全量账本 */
export type ChannelEvent =
  | { type: "message"; parentId: string; childId: string; message: ChannelMessage }
  | { type: "status"; parentId: string; childId: string; status: ChannelStatus };

/** 主进程 → agent 进程 */
export type AgentCommand =
  | {
      /**
       * 开一轮：open（piSessionFile 有值就续，没有就新建）→ prompt → 跑完销毁。
       * 同一会话已在跑时 agent 进程抛 already running。
       */
      type: "submit";
      sessionId: string;
      text: string;
      /** 随消息发的图片（原图 + 主进程铸的原图引用），语义见 SentImage */
      images?: SentImage[];
      /** 随消息引用的文件（external 的已复制进会话目录、path 已指向副本），语义见 SentFileRef */
      files?: SentFileRef[];
      /** 随消息发的粘贴文本块，语义见 SubmitAgentInput.pasted */
      pasted?: string[];
      cwd: string;
      /**
       * 这条会话属于哪个工作区；null = 不属于任何工作区。
       * **MCP 连接按它分片**（同一工作区共用一份，不同工作区各一份实例），
       * 工具描述里的工作区绑定也用它——agent 进程不认工作区，只收这个 id。
       */
      workspaceId: string | null;
      /**
       * 所属工作区的名字（workspaceId 翻译过来的那份，给模型的提示词用：
       * store-tools 的 scope 指引要告诉模型这条会话属不属于工作区）。
       * **可选，缺席 = 有工作区但翻不出名字**（旧夹具 / 工作区已删）——提示词里
       * 如实说「未知」，不猜。workspaceId 为 null 时省略。
       */
      workspaceName?: string;
      provider: ProviderSecrets;
      modelId: string;
      mode: PermissionMode;
      /** 这轮的思考档（同 AgentTurnContext.thinkingLevel；开轮命令必带，不退 pi 全局配置） */
      thinkingLevel: ThinkingLevel;
      /**
       * pi 把自己的 session 文件放在哪。**由主进程给**——runtime 不做路径策略决定。
       */
      piSessionDir: string;
      /**
       * 本会话的附图原图目录（`sessions/<会话id>.attachments/` 的绝对路径）。
       * 图片字节预算把早期图片换成占位时要给出可 read 回来的原图绝对路径
       * （image-byte-budget.ts），而 `original` 引用是相对的、目录布局是主进程的
       * 路径策略——同 `piSessionDir` 的纪律，由主进程铸好随轮发。
       */
      attachmentsDir: string;
      /**
       * 工具永不许写的目录（会话账本 sessions/ 与 pi 的本子 pi-sessions/）。
       * **主进程定，agent 进程只收数据**（同 piSessionDir 的纪律）：tool_call 闸门
       * 在权限档判定**之前**拦——「会话记录不可变」是全档不变量，Skip 也抬不掉。
       */
      protectedPaths: string[];
      /**
       * skill 的链接集合目录（2-1 起是数组：global 恒在，当前工作区再加一条）。
       * **路径由主进程给**（同 `piSessionDir`）：哪个集合对该会话生效是主进程的策略，
       * agent 进程只收数据。目录里是指向中心存储的 symlink，pi 的加载器跟符号链接。
       *
       * 目录不存在不是错，当作一个 skill 都没链（pi 内部先 existsSync 拦一道）。
       */
      skillsDirs: string[];
      /**
       * 开轮目录清单（2026-09-22 裁决）：除 cwd 外这条会话的 agent 还能去哪。
       * **只告知不硬拦**：runtime 把它拼进 systemPrompt，工具面仍是 cwd 加 protectedPaths 黑名单——
       * pi 的 read/write 只把相对路径 resolve 到 cwd，不做包含性校验，白名单硬拦是新功能不是这个字段的事。
       * **主进程装配**（同 skillsDirs / protectedPaths 的纪律）：附加目录来自工作区记录，
       * 工作台路径由 session id 派生，agent 进程只收数据。缺席 = 不注入这段（旧测试夹具）。
       */
      directories?: TurnDirectories;
      /**
       * MCP server 配置。**传解析好的而不是文件路径**：读文件与讲错误是主进程的事
       * （跟 skillsDir 同一条纪律），而且 env 里往往有密钥，路径传过去等于让
       * agent 进程自己去读一份我们已经读过的敏感文件。
       *
       * **每轮送的是「这一轮那个工作区该看到的那一份」**：主进程已经按工作区白名单
       * 筛过、把 `${workspaceFolder}` 换成了那个工作区的根。连接按 (工作区, server)
       * 建：同一个 server 名在不同工作区是不同实例，同一工作区的多条会话共用一份
       * （每条会话各拉起一份 `npx some-server` 会让子进程随会话数线性增长）。
       */
      mcpServers: Record<string, McpServer>;
      /** 有值就让 pi 打开这份它自己的 session 文件（续），没有就新建（`SessionManager.open` vs `.create`） */
      piSessionFile?: string;
      /**
       * 自动压缩偏好（A-1）。**主进程从设置装配**，renderer 的开轮载荷不携带；
       * runtime 开轮时按本轮模型的窗口换算成 pi 的 reserveTokens / keepRecentTokens
       * 覆盖进去。缺席（理论上不发生，主进程兜 COMPACTION_DEFAULT）= pi 出厂默认。
       */
      compaction?: CompactionSetting;
      /**
       * commit / PR 的 Orbita 标识开关。**主进程从设置装配**（同 compaction）：
       * runtime 不读设置文件，只收数据，每轮拼进 system prompt。
       * 缺席 = 开启（与设置契约同一口径）。
       */
      gitAttribution?: boolean;
      /**
       * 署名用哪门语言（PR 描述里那一行）。**主进程按设置算好**（`effectiveLanguage`：
       * 单语主题说了算，双语主题听语言设置），runtime 只收数据。缺席 = "en"。
       */
      attributionLanguage?: Language;
      /**
       * 实验功能「PDF 引用」的开关（settings.experimentalFeatures["pdf-citations"]）。
       * **主进程从设置装配**（同 gitAttribution）。开着时 runtime 才注册 cite_pdf
       * 并讲它的用法；缺席 = 关
       */
      pdfCitations?: boolean;
      /**
       * 意图系统（实验功能 intent-system）：开关开且这是根会话的用户原话时主进程
       * 装配（intentTurnEnv 的纯推导）。缺席 = 不召回，runtime 走与 main 完全
       * 一致的路径（不调 recall、不发卡片事件）。
       */
      intent?: IntentTurnContext;
      /**
       * pi 本子还没消化的 user 原话（此前召回失败 / 取消轮留下的尾巴，旧→新）。
       * 主进程从转录尾部推导（pendingBackfillFromRecords），**与 intent 开关无关**
       * 地随开轮命令带——prompt 之前逐条 appendMessage 补记，两本账对齐。
       * 开关全关时不装配（与 main 行为一致的边界代价，见主进程装配处注释）。
       */
      backfill?: string[];
      /**
       * 实验功能「电脑使用」的开关（settings.experimentalFeatures["computer-use"]）。
       * **主进程从设置装配**（同 pdfCitations）。开着时 runtime 才注册沙箱工具组
       * （computer_screenshot / click / type / key / scroll）；缺席 = 关——关着时模型
       * 根本看不到这些工具（不是执行时才拦）。沙箱本身由用户在设置页启停。
       */
      computerUse?: boolean;
    }
  /**
   * 用 text（一条用户消息）异步生成会话标题（C-3）。**结果不当场返回**：标题
   * 生成是一次独立的小 LLM 调用，成功经 `title` 事件回传；失败/模型拒答不发事件，
   * 门禁（meta 的 titleSource 仍是 derived）不变，下一条用户消息自然重试。
   */
  | {
      type: "generateTitle";
      sessionId: string;
      text: string;
      /**
       * 家务活模型（设置里的 choreModel，给任务起名等小活用）。**主进程解好密钥面再发**：
       * runtime 不读设置也不读密钥库，只收数据（同开轮命令的 provider）。
       * 缺席 = 用会话当前的模型（原有行为）；指的 provider 已删或解析失败时
       * 主进程同样不带，标题不因此停掉。
       */
      model?: { provider: ProviderSecrets; modelId: string };
    }
  | {
      /**
       * 迁移的「只说了句 hi / test」检查：messages 是一批会话各自唯一的那条用户消息（主进程已截短），
       * 结果经 `greetingsClassified` 事件按 requestId 回传。独立的小调用，不开会话、不落盘。
       * 模型与密钥面由主进程解好再发（同 generateTitle 的 model）。
       */
      type: "classifyGreetings";
      requestId: string;
      provider: ProviderSecrets;
      modelId: string;
      messages: string[];
    }
  | {
      /**
       * 专注模式的收工小结：prompt 是主进程归拢好的素材正文（时段内会话流水 + 工作区
       * U/M），结果经 `focusSummarized` 事件按 requestId 回传。独立小调用，不开会话、
       * 不落盘；模型与密钥面由主进程解好再发（同 classifyGreetings）。
       */
      type: "summarizeFocus";
      requestId: string;
      provider: ProviderSecrets;
      modelId: string;
      prompt: string;
    }
  | {
      /**
       * 连接探测（设置 › 模型服务的 Test，OAuth 令牌专用路由）：主进程的裸 fetch
       * 补齐身份头后仍被 429（实测 2026-10），官方 SDK 客户端自带的遥测指纹补不了——
       * 干脆让探测走 agent 进程里 pi 的同一个客户端，与真会话完全同源。
       * 结果经 `providerProbed` 事件按 requestId 回传。独立小调用，不开会话、不落盘。
       */
      type: "probeProvider";
      requestId: string;
      provider: ProviderSecrets;
      modelId: string;
    }
  | { type: "abort"; sessionId: string }
  | {
      /** 立即发送排队中的某一条：abort 当前轮（含正在跑的工具调用）→ 这条作为新一轮 submit */
      type: "interrupt";
      sessionId: string;
      /** 要发的文本。**队列在 renderer 一侧**，这里只负责「停下当前这一轮、发这句话」 */
      text: string;
      /** 随消息发的图片，语义同 submit */
      images?: SentImage[];
      /** 随消息引用的文件，语义同 submit */
      files?: SentFileRef[];
      /** 随消息发的粘贴文本块，语义同 submit */
      pasted?: string[];
      cwd: string;
      /** 这条会话属于哪个工作区，语义同 submit（MCP 连接按它分片） */
      workspaceId: string | null;
      /** 所属工作区名字，语义同 submit（scope 指引用；缺席 = 翻不出名字，说未知） */
      workspaceName?: string;
      provider: ProviderSecrets;
      modelId: string;
      mode: PermissionMode;
      /** 这轮的思考档，语义同 submit */
      thinkingLevel: ThinkingLevel;
      piSessionDir: string;
      /** 本会话的附图原图目录（图片字节预算占位用），语义同 submit */
      attachmentsDir: string;
      /** 会话文件不可变（2026-09-18）：主进程定的工具禁区，全档拦截，语义同 submit */
      protectedPaths: string[];
      /** 开轮环境，语义同 submit（skill 集合目录 + 目录清单 + MCP 配置）——无状态化后每轮开机都要带全 */
      skillsDirs: string[];
      directories?: TurnDirectories;
      mcpServers: Record<string, McpServer>;
      piSessionFile?: string;
      /** 自动压缩偏好（A-1），语义同 submit */
      compaction?: CompactionSetting;
      /** commit / PR 的 Orbita 标识开关，语义同 submit */
      gitAttribution?: boolean;
      /** 署名语言，语义同 submit */
      attributionLanguage?: Language;
      /** 实验功能「PDF 引用」的开关，语义同 submit */
      pdfCitations?: boolean;
      /** 意图系统（实验），语义同 submit：开关开时主进程装配；缺席 = 走与 main 一致的路径 */
      intent?: IntentTurnContext;
      /** 待补记的 user 原话尾巴，语义同 submit */
      backfill?: string[];
      /** 实验功能「电脑使用」的开关，语义同 submit */
      computerUse?: boolean;
    }
  | {
      /**
       * 父→子注入（Q2' 裁决）：目标会话正在跑时，把 text 注入进去。**目标空闲时
       * 主进程不发这条**（退化成普通 submit），所以 runtime 收到它会话却不在跑
       * 就是状态失步，回 failed 事件说明、不静默丢。
       *
       * `delivery`（缺席 = `"steer"`）决定注入方式，两者都是 pi 的
       * `prompt(text, { streamingBehavior })` 原生行为：
       *   `"steer"` —— 下一个工具调用边界生效，**不断当前轮**（干活的线跟着调整而不断）。
       *   `"followUp"` —— 等目标这轮本来要停时再处理，**同一个 run 里接着跑**、不开新轮
       *     （子会话通道 2026-09-23：`ChannelSpeakInput.delivery` / `reply_subsession`
       *     允许「等这轮收尾」时用这个，pi 原生就有，不必在主进程另起队列）。
       *
       * 2026-09-06 的「不碰 steering」收回的是**队列所有权**——排队状态属于 renderer
       * 的会话槽，不是否定 steer 本身；队列所有权至今仍在 renderer。这条命令因此
       * 不带开轮上下文（provider / directories 等）：它不开新轮，只是往正在跑的
       * 那一轮里加话。
       */
      type: "steer";
      sessionId: string;
      text: string;
      delivery?: ChannelDelivery;
    }
  /**
   * 手动压缩。**结果不当场返回**：压缩是一次真实的 LLM 调用，
   * 忙碌态与界碑都走 `compaction_start` / `compaction` 事件那一条链。
   */
  | {
      /** 手动压缩：开（或续）本子 → compact → 销毁。忙碌态与界碑走事件链，不当场返回 */
      type: "compact";
      sessionId: string;
      instructions?: string;
      cwd: string;
      /** 这条会话属于哪个工作区，语义同 submit（MCP 连接按它分片） */
      workspaceId: string | null;
      /** 所属工作区名字，语义同 submit（scope 指引用；缺席 = 翻不出名字，说未知） */
      workspaceName?: string;
      provider: ProviderSecrets;
      modelId: string;
      mode: PermissionMode;
      /** 这轮的思考档，语义同 submit（压缩轮内部照旧强制 off，这里传的是会话意图档） */
      thinkingLevel: ThinkingLevel;
      piSessionDir: string;
      /** 本会话的附图原图目录（图片字节预算占位用；压缩轮不开主链路，随开轮装配统一携带） */
      attachmentsDir: string;
      /** 会话文件不可变（2026-09-18）：主进程定的工具禁区，全档拦截，语义同 submit */
      protectedPaths: string[];
      /** 开轮环境，语义同 submit（skill 集合目录 + 目录清单 + MCP 配置）——无状态化后每轮开机都要带全 */
      skillsDirs: string[];
      directories?: TurnDirectories;
      mcpServers: Record<string, McpServer>;
      piSessionFile?: string;
      /** 手动压缩轮不走阈值，但轮内的自动压缩（threshold/overflow）照此生效 */
      compaction?: CompactionSetting;
      /** 压缩轮自己不提交，但开轮装配是同一份（turnFields），语义同 submit */
      gitAttribution?: boolean;
      /** 署名语言，语义同 submit */
      attributionLanguage?: Language;
      /** 实验功能「PDF 引用」的开关，语义同 submit */
      pdfCitations?: boolean;
      /** 实验功能「电脑使用」的开关，语义同 submit */
      computerUse?: boolean;
    }
  | { type: "listBuiltins" }
  /**
   * 热重载（1-1）：把现有 MCP 连接全拆，下一轮开机按新配置重建。**不送 servers**——
   * 配置本来就每轮由主进程现读现解析（开轮命令里的 `mcpServers`），这里再送一份
   * 等于把同一份真相说两遍，而且说不了「哪个工作区看哪一份」。
   * 已开会话的 customTools 在开机时已定格，不受影响；下一轮开机拿新工具集。
   */
  | { type: "mcpReload" }
  /** 4-3：主进程对 skillWriteRequest 的回执（同 permissionAnswer 的 requestId 模式） */
  | {
      type: "skillWriteResult";
      requestId: string;
      ok: boolean;
      /** 成功时的中心存储路径 */
      path?: string;
      error?: string;
    }
  /** 4-3：主进程对 mcpWriteRequest 的回执 */
  | {
      type: "mcpWriteResult";
      requestId: string;
      ok: boolean;
      /** 重连后这台 server 的状态（ready / failed …），给模型看连接结果 */
      status?: McpStatus;
      error?: string;
    }
  /** B-1：主进程对 readTaskRequest 的回执（requestId 问答的第三对） */
  | ({ type: "readTaskResult"; requestId: string } & ReadTaskOutcome)
  /** 受管浏览器：主进程对 browserRequest 的回执（readTaskResult 同款） */
  | ({ type: "browserResult"; requestId: string } & BrowserToolOutcome)
  /** 终端：主进程对 terminalRequest 的回执（browserResult 同款） */
  | ({ type: "terminalResult"; requestId: string } & TerminalToolOutcome)
  /** computer use：主进程对 computerUseRequest 的回执（browserResult 同款） */
  | ({ type: "computerUseResult"; requestId: string } & ComputerUseToolOutcome)
  /** 子会话：主进程对 delegateRequest 的回执（requestId 问答，readTaskResult 同款） */
  | ({ type: "delegateResult"; requestId: string } & DelegateOutcome)
  /** 子会话：主进程对 channelSendRequest 的回执；kind 与方向不匹配等错误走 ok: false */
  | ({ type: "channelSendResult"; requestId: string } & ChannelSendOutcome)
  | {
      /**
       * 会话回退的 pi 侧一刀（不依赖任何表，直接裁文件）：打开源本子 →
       * 按 getBranch()（当前叶子路径）对账 → 裁到 roles 前缀之后（roles 为空 =
       * 回退到开头，resetLeaf）→ 追加一条 `orbita-revert` custom 条目把新叶子落盘。
       * 不开新文件、不碰活 manager——回退后下一次开轮自然从新叶子继续。
       * 完成（或拒绝）经 `piBookEdited` / `failed` 事件回传。
       */
      type: "revertPiBook";
      sessionId: string;
      sourcePiSessionFile: string;
      cwd: string;
      /** 生效列表里目标消息之前的 user/assistant 角色序列；空 = 回退到首条消息之前 */
      roles: readonly ("user" | "assistant")[];
      /** 回退目标（我们转录里的 user 消息 id）——写进界碑 details，排障用 */
      targetMessageId: string;
    }
  | {
      /**
       * 单轮撤销的 pi 侧一刀：打开源本子，在当前叶子追加一条 custom_message
       * （进上下文，告知模型用户撤销了那轮文件改动）。会话必须不在跑——
       * 在跑由 runtime 拒绝（宁拒不切错）。完成经 `piBookEdited` / `failed` 回传。
       */
      type: "undoPiBook";
      sessionId: string;
      sourcePiSessionFile: string;
      cwd: string;
      /** 告知模型的那句通知（含文件清单） */
      notice: string;
    }
  | { type: "setMode"; sessionId: string; mode: PermissionMode }
  /**
   * 会话内换模型（C-4）。provider 是主进程装配好的完整载荷（create 同款）。
   * **对正在跑的轮无效**：pi 在轮启动时快照模型，当前轮用旧模型跑完，
   * 下一次 prompt 起新模型。结果不当场返回：成功经 `model` 事件、失败经 `failed` 事件。
   */
  | { type: "setModel"; sessionId: string; provider: ProviderSecrets; modelId: string }
  /**
   * pi 侧分支（C-2）：把源 pi 本子裁一份只含「锚点回答及之前」的新文件。
   * sessionId 是主进程先生成好的**新会话 id**（此刻 record/meta 都还没落盘）。
   * roles 是我们这本账前缀（含锚点）的 user/assistant 角色序列——两本账没有
   * id 映射（pi-ai 的 Message 没有 id），按位对账是唯一桥梁；对不上 runtime
   * 直接抛错。成功经 `created` 事件回传新 pi 文件路径。
   */
  | {
      type: "branch";
      sessionId: string;
      sourcePiSessionFile: string;
      cwd: string;
      roles: readonly ("user" | "assistant")[];
    }
  /** 用户对一次工具审批的回答，按 requestId 对回去 */
  | { type: "permissionAnswer"; requestId: string; answer: PermissionAnswer }
  /** 意图确认卡的回答（实验功能 intent-system），按 requestId 对回去；停止 / 抢跑时 runtime 侧按取消结掉 */
  | { type: "intentConfirmResult"; requestId: string; decision: IntentConfirmDecision }
  | { type: "dispose"; sessionId: string };

/**
 * B-1：read_task 读到的「这是一条什么 task」。**只给 UI、不入模型上下文**——
 * 走 pi ToolResult 的 `details` 通路（adapter 对它明写「不入模型上下文，只给
 * UI 与日志」，edit 的 diff 是同款先例）：模型拿 text 全文，renderer 拿它
 * 渲染任务卡与点击跳转（openSession）。
 */
export interface ReadTaskCard {
  /** 被读 task 的 session id。renderer 跳转就跳它 */
  sessionId: string;
  /** 被读 task 的标题；空标题（一条消息都没发过）由调用方填占位 */
  title: string;
  /**
   * briefing = 默认那次调用：头部 + 目录 + 最近轮全文；读子会话时是它的状态与回报
   * （不给过程，见 read-task.ts 的 buildSubSessionOutput）。rounds = 指定轮全文
   */
  mode: "briefing" | "rounds";
  /** rounds 模式下模型给的轮号串（原样回显，卡片副标用） */
  rounds?: string;
  /** 目标 task 的 user 轮总数 */
  roundCount: number;
}

/**
 * readTaskRequest 的回执载荷：主进程组装，agent 进程翻成工具结果。
 * `task` 缺席 = 目录模式（列当前工作区的兄弟 task）：没有单一跳转目标，card 为 null。
 */
export type ReadTaskOutcome =
  | { ok: true; card: ReadTaskCard | null; text: string }
  | { ok: false; error: string };

/**
 * 派出卡（delegate 工具的结果卡，同 ReadTaskCard 通路：走 pi ToolResult 的
 * `details` 给 UI 画「DELEGATED · 标题 · 状态」、**不进模型上下文**）。
 * 活状态不在这里——跟子会话的 phase 事件走，卡只是「派出去那一刻」的快照。
 */
export interface DelegateCard {
  /** 新建子会话的 id：右栏 Sub-sessions 面板 / 通道列都以它对账 */
  childId: string;
  /** 模型起的子会话标题（用户可改，同会话标题的 rename 通路） */
  title: string;
  /** 子会话落在哪个模型上（解析顺序：delegate 参数 > settings.subSessionModel > 同父） */
  modelId: string;
  /** 子会话的思考档（解析顺序同上：delegate 参数 > settings.subSessionThinking > 同父） */
  thinkingLevel: ThinkingLevel;
  /** 子会话的工作台路径——从派出卡跳到子会话的产出目录 */
  workbench: string;
}

/** delegateRequest 的回执载荷：childId / title 供 runtime 拼给模型看的正文，card 给 UI */
export type DelegateOutcome =
  | { ok: true; childId: string; title: string; card: DelegateCard }
  | { ok: false; error: string };

/** channelSendRequest 的回执载荷：成功回落进通道的那条消息 id（供对账与测试断言） */
export type ChannelSendOutcome =
  | { ok: true; messageId: string }
  | { ok: false; error: string };

/** agent 进程 → 主进程 → renderer（同一份形状，主进程只做转发） */
export type AgentEvent =
  | { type: "ready" }
  | { type: "builtins"; providers: BuiltinProvider[] }
  /**
   * MCP 连接结果。**没有 sessionId**：连接是进程级的，不属于哪一条会话。
   * 主进程接住它当缓存，管理面查的就是这份快照（连接状态是运行时事实，不落盘）。
   */
  | { type: "mcp"; servers: McpStatusSnapshot }
  /**
   * 4-3：agent 工具 create_skill 的写盘请求。**写盘在主进程**（agent 进程
   * 不碰 userData）——主进程调 SkillStore 后回 skillWriteResult。
   * scope 的 workspace 一侧由主进程按会话归属解析（agent 不知道 workspaceId）。
   */
  | {
      type: "skillWriteRequest";
      requestId: string;
      sessionId: string;
      slug: string;
      name: string;
      description: string;
      body: string;
      scope: "global" | "workspace";
    }
  /** 4-3：agent 工具 add_mcp_server 的写盘请求（MCP 无 workspace 语义） */
  | {
      type: "mcpWriteRequest";
      requestId: string;
      name: string;
      server: McpServer;
    }
  /**
   * B-1：agent 工具 read_task 的读盘请求。**读在主进程**（agent 进程不碰
   * userData，skillWriteRequest 的同一条边界）：主进程解析引用 → 读
   * SessionStore → 组简报 → 回 readTaskResult。rounds 缺席 = 简报
   * （目录 + 最近轮全文）；有值 = 只取目录里那些轮号的全文。
   * task 缺席 = **目录模式**：列当前会话所在工作区的兄弟 task（按更新时间倒序）。
   * 范围是工作区而不是整仓——「之前两个会话」这类关系式指称只有拿着工作区
   * 索引才能解析（2026-09-21 复验：模型没有索引就靠前缀探测摸标题，12 次调用
   * 读错了组）。
   */
  | { type: "readTaskRequest"; requestId: string; sessionId: string; task?: string; rounds?: string }
  /**
   * 受管浏览器：agent 的浏览器工具请求。**浏览器实例在主进程**（WebContentsView 只能在
   * 主进程建），agent 进程只剩「工具定义 → requestId 问答」一层薄包装——换内核只重写那层。
   * 作用于该会话自己的 agent tab（没有就建）。回 browserResult。
   */
  | { type: "browserRequest"; requestId: string; sessionId: string; request: BrowserToolRequest }
  /**
   * computer use：agent 的沙箱像素工具请求（screenshot / click / type / key / scroll，
   * 形状见 shared/computer-use.ts 的 ComputerUseToolRequest）。**沙箱在主进程**
   * （SandboxController，browserRequest 同一条边界）：agent 进程只剩「工具定义 →
   * requestId 问答」一层薄包装。沙箱是应用级一份（不按会话分），sessionId 只为信封一致。
   * 回 computerUseResult。
   */
  | { type: "computerUseRequest"; requestId: string; sessionId: string; request: ComputerUseToolRequest }
  /**
   * 终端：agent 的终端工具请求（terminal_open / execute / read / list /
   * interrupt / close，形状见 shared/terminal.ts 的 TerminalToolRequest）。
   * **PTY 在主进程**（TerminalService，browserRequest 同一条边界）：agent 进程
   * 不碰 node-pty、不碰 userData，只剩「工具定义 → requestId 问答」一层薄包装。
   * 终端是**可见**的：主进程另广播 terminal:agent-open，renderer 自动点亮面板。
   * 回 terminalResult。
   */
  | { type: "terminalRequest"; requestId: string; sessionId: string; request: TerminalToolRequest }
  /**
   * 子会话：父模型的 delegate 工具请求。**建会话在主进程**（agent 进程不碰
   * userData，readTaskRequest 同一条边界）：主进程建子会话（parentId = sessionId、
   * cwd / workspaceId 同父）、解析模型（delegate 参数 > settings.subSessionModel > 同父）
   * 与思考档（**跟着模型走**：delegate 显式给的档最优先；否则模型来自 delegate 参数 →
   * 该模型默认档，来自设置 → subSessionThinking ?? 该模型默认档，同父 → 父的档）、
   * 把 task 写进通道（通道的第一条
   * 消息，from parent · kind task）、submit 子的首轮，然后回 delegateResult。
   * 只有模型能开子会话（Q1 裁决）：用户手开的「多条互通会话」是 multi-agent 的
   * 概念，等 composer 引用系统落地后再看。
   */
  | {
      type: "delegateRequest";
      requestId: string;
      sessionId: string;
      /** 子会话标题：模型起的 */
      title: string;
      /** 任务说明：写进通道的第一条消息，也是子会话首轮的输入 */
      task: string;
      /** 可选的模型指定（裸 id，主进程在已装配的 provider 里解析）；缺席走 settings > 同父 */
      modelId?: string;
      /** 可选的思考档；缺席时跟着解析出的模型走（见上方 delegateRequest 的说明） */
      thinkingLevel?: ThinkingLevel;
    }
  /**
   * 子会话：通道发信请求，主进程写账本并回 channelSendResult。父的 reply_subsession
   * （to = { childId }，kind 恒 reply）与子的 report_to_parent（to = "parent"，
   * kind ∈ question / progress / done / failed）共用这一条。**kind 与方向不匹配
   * 主进程拒**（allowedKinds 是硬约束，不是建议）——它只能来自工具描述被无视或
   * 手改文件，两种都不该被静默容忍。delivery 缺席按方向定：父→子 steer（子空闲
   * 退化 submit）、子→父恒 followUp。
   */
  | {
      type: "channelSendRequest";
      requestId: string;
      sessionId: string;
      to: { childId: string } | "parent";
      kind: ChannelMessageKind;
      text: string;
      delivery?: ChannelDelivery;
    }
/**
 * 4-3：skills 磁盘状态变了（主进程写完广播）。Skills 面板开着就刷新——
 * 没有 sessionId：归属是全局事实，不属于哪条会话（同 mcp 事件）。
 */
| { type: "skillsChanged" }
  /** piSessionFile：pi 这一次用的那份 session 文件，主进程要把它记进会话 meta 里 */
  | { type: "created"; sessionId: string; piSessionFile: string | null }
  /**
   * 一轮落定时的文件账（agent 进程的快照跟踪器报来）：正文内联，主进程写 blob
   * 后落 FileTurnRecord。没有改动的轮不发（不落空记录）。webArtifacts 是旁路
   * 网页产物（脚本生成的 .html / .htm / .svg，不在 changes 里、不参与撤销）；
   * 只有它、没有 changes 的轮也发（卡片要出）。webArtifactsBatch 是批量折叠：
   * 本轮网页文件变动超过上限时不逐个列（webArtifacts 缺席），只报计数——
   * git checkout / 解压归档这类批量操作不该被当成「本轮生成了 N 个网页」。
   * 与 webArtifacts 互斥：折叠时不给列表。
   */
  | {
      type: "fileTurn";
      sessionId: string;
      changes: readonly FileChangePayload[];
      webArtifacts?: readonly string[];
      webArtifactsBatch?: number;
    }
  /**
   * 轮尾账的渲染视图（主进程收到 fileTurn 落盘后广播）：剥掉快照正文，只留路径
   * 与统计——renderer 的轮尾卡片不吃正文，1MB 的文件内容没有理由过这道 IPC。
   */
  | {
      type: "fileTurnView";
      sessionId: string;
      turnId: string;
      changes: readonly FileChangeView[];
      webArtifacts?: readonly string[];
      /** 批量折叠计数：本轮网页文件变动超过上限，不逐个列（与 webArtifacts 互斥） */
      webArtifactsBatch?: number;
    }
  /**
   * pi 本子的回退 / 撤销一刀完成（revertPiBook / undoPiBook 的回执）。主进程的
   * pending 等待者吃掉它——renderer 不消费，不广播。
   */
  | { type: "piBookEdited"; sessionId: string; edit: "revert" | "undo" }
  | { type: "progress"; sessionId: string; progress: TranscriptProgress }
  /**
   * 模型生成的会话标题（C-3 的 `generateTitle` 命令翻译而来）。**只在成功时发**：
   * 主进程落 meta（title + titleSource = auto）并转给 renderer 刷新侧栏；失败静默，
   * 侧栏保留首句截断。
   */
  | { type: "title"; sessionId: string; title: string }
  /**
   * `classifyGreetings` 的回执：throwaway 是判为随手一句的消息下标（对应命令里的 messages）；
   * 调用失败或回复读不懂时 throwaway 为 null、error 写原因。
   */
  | { type: "greetingsClassified"; requestId: string; throwaway: number[] | null; error?: string }
  | { type: "focusSummarized"; requestId: string; bullets: string[] | null; error?: string }
  /** `probeProvider` 的回执：ok = 真会话同源客户端拿到了模型响应；message 直接进 Test 的状态行 */
  | { type: "providerProbed"; requestId: string; ok: boolean; message: string }
  /**
   * 会话内模型切换成功（C-4 的 `setModel` 命令翻译而来）。主进程落 meta
   * （providerId / modelId——分支继承与重开恢复都读它）并转给 renderer 对齐
   * 模型显示与新任务默认。失败不发本事件（`failed` 事件说明原因），meta 不动。
   */
  | { type: "model"; sessionId: string; providerId: string; modelId: string }
  /**
   * 思考档真值（开轮时必推一次；pi 内部改档时再推）。**level 是 clamp 后的事实**：
   * 我们传的意图档可能被模型能力裁剪（不支持的就近落档），芯片必须显示这个值
   * 而不是用户点的那一档。supported 是 pi 算的支持集（可能含我们菜单外的 xhigh /
   * max——菜单只放 5 档，这不矛盾：菜单管「能选什么」，supported 管「它支持什么」）。
   */
  | {
      type: "thinking";
      sessionId: string;
      level: PiThinkingLevel;
      supported: readonly PiThinkingLevel[];
    }
  | { type: "phase"; sessionId: string; phase: SessionPhase }
  /**
   * 一份会话用量快照（token 分项 / 花费 / 上下文余量）。推送粒度与 pi 的数据粒度对齐
   * ——usage 跟着每次 LLM 响应落地，所以每条 assistant 消息完成（message_end）推一次；
   * 建会话后、每轮落定、压缩结束再各兜一次。单条消息流式期间 usage 还没回来，不推。
   * contextUsage.tokens 压缩后到下一次 LLM 响应前是 null，UI 如实显示未知。
   */
  | {
      type: "stats";
      sessionId: string;
      stats: AgentStats;
      /**
       * 这一帧该不该落盘（A1-Q1）。
       *
       * **推送很密、落盘很稀是故意的**：界面要跟着每条消息走（`message_end`），
       * 而磁盘只需要「上一次跑完时的快照」。不分的话，一轮 30 个工具就是 30 次原子写。
       * 缺席 = 只给界面看，recorder 不落盘。
       */
      persist?: true;
    }
/**
 * 上下文压缩完成，附边界记录（摘要 + tokensBefore）。pi 只经 `compaction_end`
 * 事件暴露压缩，摘要不在任何 TranscriptItem 里——我们在这里把它变成一条落盘的界碑。
 */
  | { type: "compaction"; sessionId: string; record: CompactedRecord }
  /**
   * 自动重试进行态（pi 的 auto_retry_* / summarization_retry_* 翻译而来）。
   * status 非 null = 正在等下一次重试；null = 清除。纯 ephemeral，不落盘。
   * 清除信号**不依赖本事件**：重试尝试真正开跑时 pi 会再发一次 agent_start，
   * runtime 翻成 phase 事件，renderer 的重试槽随任何 phase 事件一并清空（自愈）。
   */
  | { type: "retry"; sessionId: string; status: RetryStatus | null }
  /** 工具执行前的请示。UI 要显示它并等用户回答（三档模式见 shared/permission.ts） */
  | {
      type: "permission";
      sessionId: string;
      requestId: string;
      toolName: string;
      input: unknown;
    }
  /**
   * 回合级失败的标记（如重试耗尽）：true = 这一轮没跑成，renderer 把文案标注进
   * 该会话的槽、挂在这轮没送出去的消息下面（转录末尾）；缺省 = 操作级失败
   * （建会话 / 压缩 / 分支对账拒绝），仍报在输入框上方的全局红字里。
   */
  | { type: "failed"; sessionId: string | null; message: string; turn?: true }
  /* ---------- 意图系统（实验功能 intent-system）的三条事件 ---------- */
  /**
   * /recall 流式事件的原样透传（心跳除外）：renderer 用 applyRecallEvent 归约成
   * 流水线卡片。纯 ephemeral，不落盘——终态由 intentRecallRecord 承载。
   */
  | {
      type: "intentRecall";
      sessionId: string;
      /** 本轮回显 user item 的 id（与 /recall 的 turnId 同一个值） */
      turnId: string;
      event: IntentRecallStreamEvent;
    }
  /**
   * 一轮召回的终态记录：主进程落盘（会话 JSONL）并广播。带 usage 时同步进日账本。
   */
  | { type: "intentRecallRecord"; sessionId: string; record: IntentRecallRecord }
  /**
   * 回答前确认：recall 判定有「拿不准」的边要问用户，卡片浮在输入框上方。
   * 应答走 agentAnswerIntentConfirm；runtime 侧无超时，停止 / 抢跑时按取消结掉。
   */
  | {
      type: "intentAsk";
      sessionId: string;
      requestId: string;
      runId: string;
      turnId: string;
      ask: IntentAskView[];
    };
