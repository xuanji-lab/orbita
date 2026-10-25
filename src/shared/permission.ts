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
 * bash / powershell 的 timeout 下限（秒）：模型自填的小值会被权限闸门抬到这里
 * （只升不降；闸门改的是 pi 传进来的入参对象、不回写会话记录，完整理由见
 * `src/agent/permission.ts`）。**放 shared 是为了 UI 同源**：renderer 的「上限」
 * 显示读的是模型原始入参，不套同一条规则的话，模型填 60 时界面说「上限 1:00」、
 * 实际跑在 10 分钟上——界面对用户撒谎。规则与闸门一字不差：不填不动、填大尊重、
 * 非法（≤0 / 非有限数）不修。
 */
export const COMMAND_TIMEOUT_FLOOR_SECONDS = 600;

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
 * computer use 的只读件：`computer_screenshot`（沙箱桌面）+ `sandbox_observe` /
 * `sandbox_extract` / `sandbox_screenshot`（沙箱里的网页）。三档一律放行。
 *
 * 它们只向沙箱要图 / 要文本，不往沙箱里送任何输入，也不碰用户的文件与 shell；plan 档下
 * 「先看一眼屏幕再规划」本就是规划的一部分，manual 档下看一眼也弹审批只会让人烦。
 * sandbox_wait 也在这里：它只是等某个选择器出现（或等一段时间），不改变页面、不注入
 * 输入；plan 档下「等页面加载完再看」同样是只读规划的一部分。
 *
 * 其余写件**不在这里**，它们收在 COMPUTER_USE_WRITE_TOOLS（下面那只桶）里：
 * 像素四件（computer_click / type / key / scroll）与网页五件（sandbox_navigate / click /
 * type / upload / download）真往沙箱里注入鼠标键盘事件、改变页面状态或搬文件，能提交
 * 表单、删文件、关窗口。三档判定仍是默认写闸门（plan 拒 / manual 问 / skip 放），
 * 另外在 skip 档还要过一道本会话授权（见写桶的注释）。
 */
export const COMPUTER_USE_READ_TOOLS = [
  "computer_screenshot",
  "sandbox_observe",
  "sandbox_extract",
  "sandbox_screenshot",
  "sandbox_wait",
] as const;

export function isComputerUseReadTool(toolName: string): boolean {
  return (COMPUTER_USE_READ_TOOLS as readonly string[]).includes(toolName);
}

/**
 * computer use 的写件：**凡能改变沙箱状态、往沙箱里送输入、或让文件进出的工具**都在这里。
 * 名单按「有没有副作用」判，不按车道判——像素（computer_*）、网页 CDP（sandbox_*）、
 * UIA（computer_uia）三条车道的写动作同一待遇。
 *
 * 这十件**不在只读桶里**（三档判定仍走默认写闸门：plan 拒、manual 逐次问、skip 放），
 * 单独立桶是因为 skip 档下它们还要过一道「本会话授权」：默认档是 skip，没有这道闸，
 * agent 在用户什么都没同意的情况下就能操作沙箱（2026-10 终审裁决）。同一只桶同时是
 * 预算（60 / 90 次）与急停撤销的判定口径——名单漏一个，那个工具就同时绕过三道闸。
 *
 * 分组与理由：
 *   - 像素四件 computer_click / type / key / scroll：往唯一一块桌面注入鼠标键盘事件；
 *   - 网页五件 sandbox_navigate / click / type / upload / download：换页面、点元素、往输入框
 *     打字、把宿主机文件送进页面、把页面下载物落到宿主机。沙箱隔离不改变「它做了用户没
 *     点头的事」这一点；
 *   - computer_uia：按控件动作（invoke / setValue / selection / focus），直接改窗口里的控件
 *     状态。它的 `list` 只读控件树，**名单是工具级的、不含参数**，所以 list 也跟着走写闸门。
 *     **这是刻意选保守的一侧**：按参数分档要把 args 穿进 `decidePermission`（三档语义的
 *     唯一出处）、写闸门的三处判定与预算口径，并重新裁决「plan 档下 list 算不算只读」——
 *     那是另一件事。多问一次（skip 档下仅会话第一张卡，授权后不再问）比把 invoke 漏成
 *     免审批便宜得多。
 * 授权与破坏性确认的判定在 `src/agent/permission.ts` 的闸门里，规则在
 * `src/shared/computer-guard.ts`。
 */
export const COMPUTER_USE_WRITE_TOOLS = [
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_scroll",
  "sandbox_navigate",
  "sandbox_click",
  "sandbox_type",
  "sandbox_upload",
  "sandbox_download",
  "computer_uia",
] as const;

export function isComputerUseWriteTool(toolName: string): boolean {
  return (COMPUTER_USE_WRITE_TOOLS as readonly string[]).includes(toolName);
}

/** 工具组全体（读取 + 写入）：预算按这个口径计——截图也吃上下文，必须计入 */
export function isComputerUseTool(toolName: string): boolean {
  return isComputerUseReadTool(toolName) || isComputerUseWriteTool(toolName);
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
  // 沙箱截图：三档一律放行，理由见 COMPUTER_USE_READ_TOOLS 的注释
  if (isComputerUseReadTool(toolName)) return { behavior: "allow" };
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
