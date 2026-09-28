/**
 * 工具权限策略 —— 三档模式的唯一定义（契约层，主进程与 renderer 共用）。
 *
 * pi **没有**审批钩子：它拿到工具定义就直接调 `execute`。所以「执行前先请示」这件事
 * 完全是我们的——做法是把工具定义包一层（见 `src/agent/permission.ts`）。
 * 这层的好处是三档模式只是同一个包装的三种返回策略，不需要动 pi 的任何东西。
 */
export const PERMISSION_MODES = ["plan", "manual", "skip"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const PERMISSION_MODE_LABELS: Record<PermissionMode, { label: string; hint: string }> = {
  plan: { label: "Plan", hint: "Read-only. Writing and shell are refused." },
  manual: { label: "Manual", hint: "Ask before every tool call." },
  skip: { label: "Skip", hint: "Run every tool without asking." },
};

/**
 * 不改变任何东西的工具：pi 内建五个，加我们自己的 read_task（B-1）——它经主进程
 * 读别的 task 的落盘记录，不改任何盘。其余（write / edit / bash…）一律视为有副作用。
 *
 * read_task 是「跨会话读」，曾在 2026-09-18 短暂立过「plan 档也弹审批」的桶
 * （CROSS_SESSION_READ_TOOLS），同日二次裁决撤销：读取而已，每次点击不值；
 * 会话文件的**写入**侧另有全档不变量兜着（tool_call 闸门的 protectedPaths），
 * 读的敞开不影响那道锁。见 PR #31/#32（立）与本文件的现状（撤）。
 *
 * read_pdf 同口径：提取 PDF 文本层而已（./pdf-tools.ts），与 read 同一待遇。
 * show_image 同理：读盘展示、零副作用（./image-tools.ts）。
 */
export const READ_ONLY_TOOLS = [
  "read",
  "grep",
  "glob",
  "ls",
  "find",
  "read_task",
  "read_pdf",
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
 * 点击、输入、按键（browser_click / browser_type / browser_press）**不在这里**：它们能提交表单、
 * 下单、发消息，走默认的写操作闸门——plan 拒、manual 问、skip 放。不为它们另立名单：
 * decidePermission 对不认识的工具本来就按有副作用处理。
 */
export const BROWSER_READ_TOOLS = [
  "browser_navigate",
  "browser_observe",
  "browser_extract",
  "browser_screenshot",
  "browser_tabs",
  "browser_scroll",
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
  // 浏览器只读四件与交接：三档一律放行，理由见 BROWSER_READ_TOOLS / USER_ACTION_TOOL 的注释
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
