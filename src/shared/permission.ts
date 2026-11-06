/**
 * 工具权限策略 —— 三档模式的唯一定义（契约层，主进程与 renderer 共用）。
 *
 * pi **没有**审批钩子：它拿到工具定义就直接调 `execute`。所以「执行前先请示」这件事
 * 完全是我们的——做法是把工具定义包一层（见 `src/agent/permission.ts`）。
 * 这层的好处是三档模式只是同一个包装的三种返回策略，不需要动 pi 的任何东西。
 */
export const PERMISSION_MODES = ["plan", "manual", "skip"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * 新任务槽的起始档（没有 lastUsed 可恢复时）。skip：用户 2026-09-29 裁决——plan 起步
 * 意味着第一次让 agent 动手必撞墙、再回来切档（反馈「每次默认模式都是 plan」）。
 * 中间档（manual 全问）同样被否：用户要的是开箱即干活，要收紧时自己切档。
 * 与 Proma 的默认档（bypassPermissions）同口径。会话记录只读锁不受档位影响，skip 也拦。
 *
 * 它只管「用户看得见的起始档」。坏值回落（session meta 解析）、导入会话、agent 进程
 * 账本的兜底仍是 plan——那是「没人告诉我档位」时的最保守值，不是默认值。
 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "skip";

/**
 * 把档压到不高于「询问」（manual）：skip → manual；plan 比询问更严，原样留着（不放宽）。
 *
 * 用在两处不是用户亲手发起的开轮（审核 F-4，2026-10-25 用户拍板）：
 * - **收尾扫描轮**：只该回看对话，提示词也写明不调工具；万一模型还是去调，弹审批。
 * - **从遗留事项「继续」开出的新会话**：种子里的 detail 常带上一个会话里的绝对路径，「放行」档
 *   下智能体会照着往用户真实目录写（PR 320 验收时往 ~/Orbita/TRX50服务器/ 写了两次）。新会话从
 *   询问起步，用户自己再切。
 */
export function atMostManual(mode: PermissionMode): PermissionMode {
  return mode === "skip" ? "manual" : mode;
}

/**
 * bash / powershell 的 timeout 下限（秒）：模型自填的小值会被权限闸门抬到这里
 * （只升不降；闸门改的是 pi 传进来的入参对象、不回写会话记录，完整理由见
 * `src/agent/permission.ts`）。**放 shared 是为了 UI 同源**：renderer 的「上限」
 * 显示读的是模型原始入参，不套同一条规则的话，模型填 60 时界面说「上限 1:00」、
 * 实际跑在 10 分钟上——界面对用户撒谎。两边都调下面的 `gatedCommandTimeout`。
 */
export const COMMAND_TIMEOUT_FLOOR_SECONDS = 600;

/**
 * 模型**没填** timeout 时，闸门替它补上的默认上限（秒）。pi 的 bash 工具没有系统超时，
 * 不填就是一直跑：命令自己卡死（启动脚本等输入、dev server 不退出）时整轮挂住，
 * 只能用户手动停（2026-10-25 任务 461c6fce）。到点由 pi 杀整棵进程树并把已有输出
 * 连同「Command timed out after 3600 seconds」交回模型。
 *
 * 取 1 小时而不是更短（2026-10-30 用户拍板）：工具指引让模型跑依赖安装 / 构建 /
 * 测试时**别传** timeout，上限太短就会误杀正常的长命令；真要跑更久的，模型显式
 * 传更大的值，闸门尊重。
 */
export const COMMAND_TIMEOUT_DEFAULT_SECONDS = 3600;

/**
 * 闸门落到入参上的 timeout——权限闸门（改入参）与 renderer 的「上限」显示（读原始入参）
 * 共用这一条规则，同一个数不许有两处真源：
 * - 不填（undefined）→ 默认上限 `COMMAND_TIMEOUT_DEFAULT_SECONDS`；
 * - 有限正数且小于下限 → 抬到 `COMMAND_TIMEOUT_FLOOR_SECONDS`；
 * - 其余原样返回：填得比下限大是模型自己的判断；非法值（≤ 0、非有限数、字符串、null）
 *   不在这里修，pi 自己会报「Invalid timeout」，不替它做第二套校验。
 */
export function gatedCommandTimeout(raw: unknown): unknown {
  if (raw === undefined) return COMMAND_TIMEOUT_DEFAULT_SECONDS;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return raw;
  if (raw > 0 && raw < COMMAND_TIMEOUT_FLOOR_SECONDS) return COMMAND_TIMEOUT_FLOOR_SECONDS;
  return raw;
}

export const PERMISSION_MODE_LABELS: Record<PermissionMode, { label: string; hint: string }> = {
  plan: { label: "Plan", hint: "Read-only. Writing and shell are refused." },
  manual: { label: "Manual", hint: "Ask before every tool call." },
  skip: { label: "Skip", hint: "Run every tool without asking." },
};

/**
 * 不改变任何东西的工具：pi 内建四个（read / grep / ls / find），加我们自己的
 * read_task（B-1）——它经主进程读别的 task 的落盘记录，不改任何盘。
 * 其余（write / edit / bash…）一律视为有副作用。
 *
 * **名单里不放 pi 没有的工具**：以前这里（与 agent/permission.ts 的内建名单）都带着一个
 * `glob`，而 pi 0.84.3 的 createAllToolDefinitions 里没有这个工具（只有
 * read / bash / powershell / edit / write / grep / find / ls）。一个永远不会被调到的名字
 * 放在这里只是假的声明——它不会多拦任何东西，但会让读的人以为有这条路。
 * 真源与启用的内建工具集同源：`src/agent/permission.ts` 的 `ENABLED_BUILTIN_TOOLS`。
 *
 * read_task 是「跨会话读」，曾在 2026-09-18 短暂立过「plan 档也弹审批」的桶
 * （CROSS_SESSION_READ_TOOLS），同日二次裁决撤销：读取而已，每次点击不值；
 * 会话文件的**写入**侧另有全档不变量兜着（tool_call 闸门的 protectedPaths），
 * 读的敞开不影响那道锁。见 PR #31/#32（立）与本文件的现状（撤）。
 *
 * read_pdf 同口径：提取 PDF 文本层而已（./pdf-tools.ts），与 read 同一待遇。
 * read_docx 同理（./docx-tools.ts）：word 文档的结构化提取，同样零副作用。
 * show_image 同理：读盘展示、零副作用（./image-tools.ts）。
 */
export const READ_ONLY_TOOLS = [
  "read",
  "grep",
  "ls",
  "find",
  "read_task",
  "read_pdf",
  "read_docx",
  "show_image",
  // 插件列表：读已装插件的名字与技能，不改任何东西
  "list_plugins",
] as const;

export function isReadOnlyTool(toolName: string): boolean {
  return (READ_ONLY_TOOLS as readonly string[]).includes(toolName);
}

/**
 * 通道三件套（子会话 2026-09-23 裁决）：delegate / reply_subsession / report_to_parent，
 * 三档模式一律放行。model_costs（派发前查各型号的价格 · 能力）一并放在这里：它只读我们自己的
 * 用量账本，是 delegate 的前置一步——manual 档下每次派发前都为它弹一次审批，就把派发流程
 * 拖成两次点击，而它什么也不改。
 *
 * 它们是**协调**而不是**动作**——只写我们自己的通道账本（`ChannelStore`），不碰用户的
 * 文件与 shell；真正有副作用的动作发生在子会话自己的工具调用上，那些照子会话的档位
 * 过闸。不放行的后果：plan 档下父派不出子（delegate 被拒）、子连 done 都报不回去，
 * 永远卡在那一轮；manual 档下每次回报都弹一次审批，而子会话的审批用户往往根本没在看，
 * 通道就此卡死。
 *
 * **否决「并进 READ_ONLY_TOOLS」**：那个名单的语义是「只读」，manual 档下用户明确要
 * 「全都问」、只读也问——而这三个工具问了没有意义（它们不改用户能看到的任何东西）。
 * 单独立一个桶，语义与 READ_ONLY_TOOLS 不同，不能共用同一张表。
 */
export const CHANNEL_TOOLS = ["delegate", "reply_subsession", "report_to_parent", "model_costs"] as const;

export function isChannelTool(toolName: string): boolean {
  return (CHANNEL_TOOLS as readonly string[]).includes(toolName);
}

/**
 * 记忆三件套（2026-10-29 用户裁决「我不想去确认记忆，agent 应该自己有判断力吧」）：
 * memory_search / memory_revise / memory_retire，三档模式一律放行。
 *
 * 它们只读写我们自己的记忆库（记忆服务进程是唯一写者），不碰用户的文件与 shell；
 * 每一次改动都能在条目卡上撤销（恢复旧说法 / 恢复使用），演变链里看得到。问了也没意义——
 * 用户要的是「一句话纠错就改对」，弹审批正是他明确不要的「需要他去确认」。plan 档同样
 * 放行：plan 拦的是对用户工作成果的改动，记忆对齐不是。
 *
 * 只在根会话注册（子会话读不写），主进程另有一道会话身份校验。
 */
export const MEMORY_TOOLS = ["memory_search", "memory_revise", "memory_retire"] as const;

export function isMemoryTool(toolName: string): boolean {
  return (MEMORY_TOOLS as readonly string[]).includes(toolName);
}

/**
 * 自动化四件套：automation_create / automation_list /
 * automation_cancel / automation_update，三档模式一律放行。
 *
 * 它们只写我们自己的 `automations.json`，不碰用户的文件与 shell；建出来的任务**直接生效**
 * （2026-10-31 用户裁决），到点才真正动手——那时的动作照任务所绑会话 / 新会话自己的权限档过闸。
 * 所以这里问了也没意义：建的这一下不改用户能看到的任何东西，用户在对话里能看到那张卡并随时暂停。
 * plan 档同样放行：规划「要定期查什么」本就是 plan 的一部分。
 * automation_update 只开放权限档一项，**放行这个工具本身不放行它的效果**：把自动化调成 skip（无人值守写盘）
 * 的上限在主进程——只有会话此刻本来就是 skip 才直接改，manual / plan 档只在对话里留一行让用户点「允许」
 * （agent 给自动化的权限不能高于这条会话此刻的权限）。所以这里同样三档放行，闸在主进程而不在工具门口。
 * 只在根会话注册；自动化新开的会话与子会话不注册（防递归），主进程另有一道会话身份校验。
 * 条数有护栏（每会话活跃 ≤ 5、全局 ≤ 20，间隔 ≥ 5 分钟，24 小时 ≤ 24 次，agent 建的必有终点）。
 *
 * **否决「并进 CHANNEL_TOOLS」**：语义不同（通道是协调、这是排期），将来收紧时不该连坐。
 */
export const AUTOMATION_TOOLS = ["automation_create", "automation_list", "automation_cancel", "automation_update"] as const;

export function isAutomationTool(toolName: string): boolean {
  return (AUTOMATION_TOOLS as readonly string[]).includes(toolName);
}

/**
 * 受管浏览器的只读四件（2026-09-27 wafo 裁决）：三档模式一律放行。
 *
 * 它们只在隔离的沙盒浏览器里读页面（导航、结构、正文、截图），不碰用户的文件与 shell；
 * 登录态本来就是用户为 agent 准备的。plan 档要能用——「上网找参考」本就是规划的一部分，
 * web search 之外还能读需要登录的站；manual 档也不问——翻一次论文列表点十次审批不值。
 *
 * **否决「并进 READ_ONLY_TOOLS」**：那个名单在 manual 档仍要问（「全都问」对本机读取成立）。
 * 浏览器读的是外部页面，不是用户的盘，单独立桶。
 *
 * browser_scroll 也在这里：滚动只是往下读，不提交任何东西——翻长页要一屏屏看，每屏问一次不值。
 * browser_wait_for 同理：等页面自己长出来，不发请求、不改页面。
 * 点击、输入、按键（browser_click / browser_type / browser_press）**不在这里**：它们能提交表单、
 * 下单、发消息，走默认的写操作闸门——plan 拒、manual 问、skip 放。不为它们另立名单：
 * decidePermission 对不认识的工具本来就按有副作用处理。
 *
 * browser_console_messages / browser_network_requests 同属这里：页面加载成功但内容空白时，
 * 它们是模型唯一能自己查清原因的只读证据（JS 报错、XHR 401/403、CORS 被拒）；查完要不要重试
 * 仍由模型决定，工具本身不提交任何东西。
 */
export const BROWSER_READ_TOOLS = [
  "browser_navigate",
  "browser_observe",
  "browser_extract",
  "browser_wait_for",
  "browser_screenshot",
  "browser_tabs",
  "browser_scroll",
  "browser_console_messages",
  "browser_network_requests",
] as const;

export function isBrowserReadTool(toolName: string): boolean {
  return (BROWSER_READ_TOOLS as readonly string[]).includes(toolName);
}

/**
 * 写计划（update_plan，2026-10-30）：三档一律放行。它只是把打算说出来，清单落在转录里，
 * 不碰用户的文件与 shell；plan 档尤其要用得上（规划本来就是 plan 档的事），manual 档问了
 * 也没意义——用户要看的是计划本身，不是「要不要允许它写计划」。
 */
export const PLAN_TOOL = "update_plan";

/** 定会话目标（update_goal，2026-10-30）：同 update_plan，只是把目标记在转录里，三档一律放行 */
export const GOAL_TOOL = "update_goal";

/**
 * 自己带确认的工具：install_plugin 不靠审批条，它**自己**在对话里留一行（「装上 X　[安装] [看详情]」，
 * 或低风险时直接装上后的「已装上 X · [卸载]」）。权限档的语义：
 *
 * - **plan**：拒（装插件改的是用户已装的东西，plan 的语义是「描述而不动手」）。
 * - **manual**（Ask before every tool call）：不再另弹审批条（那一行就是那次询问，再弹是套娃），
 *   但**永不直接装**——主进程见 manual 档一律只留带「安装」的那一行，用户点了才装。
 * - **skip**：低风险（会话工作区内、链接安装、不带 MCP、范围是工作区、无冲突）直接装；
 *   带 MCP / 范围是所有工作区 / 有冲突仍留那一行——放行档放的是审批，不是「看一眼」。
 *
 * 以前的做法（挂起等用户点的确认卡 + 15 分钟超时）已删：agent 一直等着，用户吃饭回来它还挂着。
 */
export const SELF_CONFIRMING_TOOLS = ["install_plugin"] as const;

export function isSelfConfirmingTool(toolName: string): boolean {
  return (SELF_CONFIRMING_TOOLS as readonly string[]).includes(toolName);
}

/**
 * 草稿预览：preview_plugin 只扫描会话工作区里的插件文件夹、让右栏显示「正在做」视图，不装也不写任何东西。
 * 三档一律放行（含 plan：它只是把已经写好的文件给用户看；manual 下为一次预览弹审批，会把「边聊边改卡片」
 * 的节奏打断成一问一答）。
 */
export const PLUGIN_DRAFT_TOOL = "preview_plugin";

/**
 * 看板结果：show_plugin_board 把插件**已经写好的**卡（模板 + 此刻的数据）快照进工具结果、显示在对话里。
 * 它不碰用户的文件与 shell，唯一的写是 userData 里我们自己的模板缓存（board-templates/，按哈希去重）。
 * 三档一律放行（同 preview_plugin）：
 * - plan：只是把结果给用户看，不改用户的工作成果；
 * - manual：每跑一次插件弹一次审批会把「看结果」打断成一问一答；this_session 自动化跟随会话的档，
 *   manual 会话里无人值守的那一轮会卡在这张审批上。
 * **否决「并进 READ_ONLY_TOOLS」**：那张表在 manual 档仍要问（2026-11-05 主会话裁决）。
 */
export const PLUGIN_BOARD_TOOL = "show_plugin_board";

/**
 * 交接：agent 请用户亲手做一步（登录、验证码、授权）。三档一律放行——它本身就是在问用户，
 * 再为「要不要问用户」弹一次审批是套娃。名字不带 browser 前缀：终端的 sudo / 2FA 是同一件事，
 * 将来复用这个名字。
 */
export const USER_ACTION_TOOL = "request_user_action";

export type PermissionDecision =
  | { behavior: "allow" }
  /** 需要问用户；调用方负责把问题送到 UI 并等回答 */
  | { behavior: "ask" }
  | { behavior: "deny"; message: string };

/**
 * 纯策略：只看模式与工具名。**不做 IO、不认识 UI**——所以它可以被穷尽测试，
 * 也保证「plan 模式下 bash 绝不可能被执行」这类判断有唯一出处。
 */
export function decidePermission(mode: PermissionMode, toolName: string): PermissionDecision {
  if (mode === "skip") return { behavior: "allow" };
  // 通道三件套：三档一律放行，理由见 CHANNEL_TOOLS 的注释
  if (isChannelTool(toolName)) return { behavior: "allow" };
  // 记忆三件套：三档一律放行，理由见 MEMORY_TOOLS 的注释
  if (isMemoryTool(toolName)) return { behavior: "allow" };
  // 自动化四件套：三档一律放行（建出来是待启用，确认在启用那一下），理由见 AUTOMATION_TOOLS 的注释
  if (isAutomationTool(toolName)) return { behavior: "allow" };
  // 浏览器只读工具与交接：三档一律放行，理由见 BROWSER_READ_TOOLS / USER_ACTION_TOOL 的注释
  if (isBrowserReadTool(toolName) || toolName === USER_ACTION_TOOL) return { behavior: "allow" };
  // 写计划：三档一律放行，理由见 PLAN_TOOL 的注释
  if (toolName === PLAN_TOOL || toolName === GOAL_TOOL) return { behavior: "allow" };
  // 草稿预览：三档一律放行（理由见 PLUGIN_DRAFT_TOOL）
  if (toolName === PLUGIN_DRAFT_TOOL) return { behavior: "allow" };
  // 看板结果：三档一律放行（理由见 PLUGIN_BOARD_TOOL）
  if (toolName === PLUGIN_BOARD_TOOL) return { behavior: "allow" };
  // 自带确认的工具：manual 不再问一次（对话里那一行就是询问），plan 照拒（理由见 SELF_CONFIRMING_TOOLS）
  if (isSelfConfirmingTool(toolName) && mode === "manual") return { behavior: "allow" };
  if (isReadOnlyTool(toolName)) {
    // plan 下只读工具静默放行；manual 下用户要求「全都问」，只读也问
    return mode === "plan" ? { behavior: "allow" } : { behavior: "ask" };
  }
  if (mode === "plan") {
    return {
      behavior: "deny",
      // 这句话会作为工具失败原因回灌给模型，让它改用只读方式继续，而不是反复重试
      message: `Plan mode is on: ${toolName} is not available. Describe the change instead of making it.`,
    };
  }
  return { behavior: "ask" };
}

/** 用户对一次询问的回答。改写入参是刻意保留的能力（把 rm -rf 改成别的路径再放行）。 */
export type PermissionAnswer =
  | { behavior: "allow"; input?: unknown }
  | { behavior: "deny"; message?: string };
