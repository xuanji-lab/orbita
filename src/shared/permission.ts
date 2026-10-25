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
 * bash / powershell 的 timeout 三档数（秒）。闸门（`src/agent/permission.ts`）与
 * renderer 的「上限」显示（`tool-results.ts`）读同一份：闸门改的是 pi 传进来的入参对象、
 * 不回写会话记录，显示若不套同一条规则，模型填 60 时界面说「上限 1:00」、实际跑在
 * 10 分钟上——界面对用户撒谎。
 *
 * - `FLOOR`（600）：**下限**。模型自填的小值抬到这里——它常填 60s / 30s / 10s，
 *   慢命令被自己的秒表砍掉，代价是白等一分钟再从头跑。
 * - `DEFAULT`（1800）：**模型不填时的上限**。pi 的 bash 没有系统超时（唯一可设的是
 *   那个可选 `timeout` 参数，2147483 秒 ≈ 24 天），不填等于允许一条命令跑到天荒地老：
 *   实测最近 60 个会话里 12 次 bash 跑过 30 分钟（最长 3.7 小时），吃掉全部 bash 墙上
 *   时间的 41%。所以「不填」从此也是 30 分钟封顶。
 * - `HARD_MAX`（3600）：**声明值的天花板**。模型（或人在审批卡片里）说要更久，最多到这里。
 *   它同时是**策略函数的默认输入**：设置项 `commandTimeoutMaxSeconds` 可把它换掉（默认仍
 *   3600），三档随之上收敛——见 `commandTimeoutPolicy`。
 *
 * **为什么默认值比 dsh / ZCode 的 120s 大得多**：它们到点**不杀进程**，只把控制权交还、
 * 转后台任务接着跑；我们只有 pi 的 `timeout`，到点就是 `killProcessTree`，活直接扔了
 * （dsh 的复盘原话：被前台超时杀掉的命令，其工作全部作废，是长构建失败最常见的原因）。
 * 既然代价是「扔掉正在干的活」，窗口就得给足；而合法的长命令确实存在——实测里 44 分钟
 * 那条是验收脚本，自己声明了 `timeout=2900`。所以：不填 30 分钟、声明最多 60 分钟。
 *
 * 非法值（≤0 / 非有限数 / 字符串 / null）**不在这里修**：pi 自己会报 `Invalid timeout`，
 * 我们不替它做第二套校验。三处（闸门、显示、提示词）的规则必须一字不差。
 */
export const COMMAND_TIMEOUT_FLOOR_SECONDS = 600;
export const COMMAND_TIMEOUT_DEFAULT_SECONDS = 1800;
export const COMMAND_TIMEOUT_HARD_MAX_SECONDS = 3600;

/**
 * 用户在设置里能给「硬上限」填的合法区间（秒，整数）：`[10, 86400]`。
 *
 * **下限 10 秒**：这个旋钮是为了让「验超时」不用改源码，但再小就不是策略而是事故了——
 * 5 秒的上限连 `bun run typecheck` 都跑不完，选择它就等于选择让每条命令都失败，
 * 而且失败得毫无线索（命令被杀、输出为空）。10 秒刚好够 `sleep 30` 这类验收探针
 * 必然超时，又不至于让正常的 `ls` 都活不下来。
 *
 * **上限 86400 秒（一天）**：超过一天的「上限」等于没有上限——回落到默认的
 * 3600 比接受一个假的上限诚实。
 *
 * 这是**设置项的合法区间**，不是运行时的夹取区间：越界的值在 `parseSettings` 里
 * 直接丢掉（读回缺席语义），不修成最近值。`commandTimeoutPolicy` 用同一个判断
 * 兜住「没经过 parseSettings 的调用方」（测试、旧夹具）。
 */
export const COMMAND_TIMEOUT_SETTING_MIN_SECONDS = 10;
export const COMMAND_TIMEOUT_SETTING_MAX_SECONDS = 86400;

/** 设置项的值是否合法（整数、落在区间内）。非法值由调用方丢掉，不夹取。 */
export function isCommandTimeoutMaxSeconds(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= COMMAND_TIMEOUT_SETTING_MIN_SECONDS &&
    value <= COMMAND_TIMEOUT_SETTING_MAX_SECONDS
  );
}

/** 命令超时的三档策略（秒）。三档都从用户设的上限推导，见 `commandTimeoutPolicy`。 */
export interface CommandTimeoutPolicy {
  floorSeconds: number;
  defaultSeconds: number;
  hardMaxSeconds: number;
}

/**
 * 把「用户设置的上限」换算成闸门与界面共用的三档。**一处真源**：`src/agent/permission.ts`
 * 的闸门、`runtime.ts` 的钩子、renderer 的「上限」显示都走这个函数，谁都不许自己
 * 拿常量拼一份——拼出来的规则一旦漂，界面就会对用户撒谎（见上面三档常量的注释）。
 *
 * **地板与默认值都跟着上限收敛**：设成 10 秒时若地板仍是 600，闸门会先把「不填」
 * 补成 600、把声明值抬到 600，上限 10 秒等于没生效——那正是这个设置项要消灭的处境
 * （用户要能不改源码就验出超时）。所以 `floor = min(FLOOR, hardMax)`、
 * `default = min(DEFAULT, hardMax)`：上限永远是真的上限，下面的两档只是它的从属。
 *
 * 缺席 / 非法（非数、非整数、越界）→ 全套用出厂常量，与「用户没设过」同一行为。
 * 只认合法整数、坏值丢掉（不修成最近值）与 `settings.ts` 的白名单纪律一致。
 */
export function commandTimeoutPolicy(hardMaxSetting?: number): CommandTimeoutPolicy {
  const hardMaxSeconds = isCommandTimeoutMaxSeconds(hardMaxSetting)
    ? hardMaxSetting
    : COMMAND_TIMEOUT_HARD_MAX_SECONDS;
  return {
    floorSeconds: Math.min(COMMAND_TIMEOUT_FLOOR_SECONDS, hardMaxSeconds),
    defaultSeconds: Math.min(COMMAND_TIMEOUT_DEFAULT_SECONDS, hardMaxSeconds),
    hardMaxSeconds,
  };
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
] as const;

export function isReadOnlyTool(toolName: string): boolean {
  return (READ_ONLY_TOOLS as readonly string[]).includes(toolName);
}

/**
 * 通道三件套（子会话 2026-09-23 裁决）：delegate / reply_subsession / report_to_parent，
 * 三档模式一律放行。
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
export const CHANNEL_TOOLS = ["delegate", "reply_subsession", "report_to_parent"] as const;

export function isChannelTool(toolName: string): boolean {
  return (CHANNEL_TOOLS as readonly string[]).includes(toolName);
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
  // 浏览器只读工具与交接：三档一律放行，理由见 BROWSER_READ_TOOLS / USER_ACTION_TOOL 的注释
  if (isBrowserReadTool(toolName) || toolName === USER_ACTION_TOOL) return { behavior: "allow" };
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
