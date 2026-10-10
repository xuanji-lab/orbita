/**
 * 终端域契约 —— IPC 四层的第 1 层。
 *
 * 这是**人工终端**（用户在右栏面板里亲手敲的 shell）：无审批层，renderer 只递键入与
 * 尺寸，shell 可执行文件永远由主进程侧的 terminal runtime 探测与解析——renderer
 * 传什么都不信，`cwd` 也只是「想在哪儿开」的意愿（失效时主进程回退 homedir）。
 *
 * agent 终端（PR2）与人工终端**共用同一套 PTY 与同一个面板 tab**：agent 通过
 * `terminalRequest` 问答（shared/agent-ipc.ts）开终端、写命令、读输出，人在同一个
 * tab 里随时能接着敲。两者的差别只有三条：归属（`owner`）、cwd 授权（agent 侧硬校验，
 * 见 main/terminal/agent-policy.ts）、以及 agent 开的终端要**可见**（`agent-open`
 * 事件把面板点亮）。
 *
 * 链路（与 agent 域同构）：renderer ↔ IPC ↔ 主进程（TerminalService）↔ MessagePort
 * ↔ terminal utility 进程（node-pty）。一个 runtime 进程管全部 PTY；PTY 与快照缓冲
 * 都活在主进程/runtime 侧，renderer 的面板与 xterm 实例随时可拆可建——重挂载先拉
 * `snapshot` 重放、再接续 `output` 事件流，按 `sequence` 去重。
 */

/** IPC 通道名。与 `ipcChannels`（agent-ipc.ts）分开：终端是独立域，不掺 agent 的表 */
export const terminalChannels = {
  /** 开一个终端（renderer 铸 uuid 当 terminalId，幂等：id 已知就直接回现状） */
  create: "terminal:create",
  /** 现存终端清单（面板重挂载 / renderer 整页刷新后收养孤儿 PTY 用） */
  list: "terminal:list",
  /** 键入（用户敲的字符与粘贴，含控制字符，原样透传） */
  input: "terminal:input",
  /** 行列变化（xterm fit 之后同步给 PTY） */
  resize: "terminal:resize",
  /** 关 tab：杀 PTY（Windows 杀整棵进程树）并丢弃快照缓冲 */
  kill: "terminal:kill",
  /** 重放缓冲快照（重挂载先画它，再接事件流） */
  snapshot: "terminal:snapshot",
  /** 一批输出画完了（背压：runtime 同一时刻只放一批在飞） */
  ackOutput: "terminal:ack-output",
  /** main → renderer 推送（`TerminalEvent`），全应用一个通道 */
  event: "terminal:event",
} as const;

/**
 * terminalId 的形状闸：renderer 铸的是 uuid（带连字符），这里只认
 * `[0-9a-f-]` 形状的 8–64 位串——路径分隔符、空白与控制字符进不了协议与日志。
 */
export const TERMINAL_ID_PATTERN = /^[0-9a-f][0-9a-f-]{7,63}$/;

export function isTerminalId(value: unknown): value is string {
  return typeof value === "string" && TERMINAL_ID_PATTERN.test(value);
}

/**
 * 行列的合法区间。上界 500 同 Proma 的口径：xterm 容器再宽也到不了 500 列，
 * 恶意或坏值夹进来就行——ConPTY 对 0 / 负数会直接抛。
 */
export const TERMINAL_DIMENSION_MAX = 500;

/** 把任意来路（renderer 传参）夹成合法行列：非有限数回退 fallback，越界夹到边上 */
export function clampTerminalDimension(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(TERMINAL_DIMENSION_MAX, Math.max(1, Math.floor(value)));
}

/**
 * 单次键入的字符数上限（UTF-16 code unit，与 Proma 同口径的 64KB）。
 * 粘贴超长文本拦在主进程：整段塞给 PTY 会把输出管线顶穿。
 */
export const TERMINAL_INPUT_LIMIT = 64 * 1024;

/**
 * `terminal:create` 的载荷。cwd 缺席或失效时主进程回退 homedir（人工终端不报错）。
 * **agent 终端不走这条 IPC**（它经 agent 进程的 terminalRequest 由主进程代开），
 * 所以这里没有 owner 字段——归属由主进程记，renderer 说得不算。
 */
export interface TerminalCreateRequest {
  terminalId: string;
  cols: number;
  rows: number;
  cwd?: string;
}

/**
 * 一个终端的现状。`title` 是主进程按解析后的 cwd 末段铸的（tab 上显示的文件夹名）；
 * `exited` 非 null = 进程已退出（exit code），tab 留着给用户看退场原因，关 tab 才清。
 */
export interface TerminalInfo {
  terminalId: string;
  title: string;
  /** 归属：人工开的 / 哪个会话的 agent 开的 */
  owner: TerminalOwner;
  /** 实际跑起来的 shell 短名（pwsh / powershell / cmd / bash …），探测在 runtime */
  shell: string;
  cwd: string;
  pid: number;
  exited: number | null;
}

/** `terminal:snapshot` 的回执：sequence 是缓冲里最后一批输出的序号（renderer 由此续流） */
export interface TerminalSnapshot {
  terminalId: string;
  output: string;
  sequence: number;
}

/** 一批输出。sequence 单终端单调递增，从 1 起——重放去重与 ACK 都认它 */
export interface TerminalOutputEvent {
  terminalId: string;
  sequence: number;
  data: string;
}

/**
 * 终端的归属。`agent` 带所属会话——**代码层的所有权校验**（execute / read /
 * interrupt / close 都查它）与「本会话拥有哪些终端」的列表都认这一字段。
 *
 * 人工终端恒为 `human`：renderer 铸 id 走 IPC 开的那种。agent 终端由主进程代开
 * （service.createForAgent），renderer 伪造不了归属——归属是主进程记的事实。
 */
export type TerminalOwner = { kind: "human" } | { kind: "agent"; sessionId: string };

/** main → renderer 的推送。output 与 exit 的顺序由 runtime 保证：exit 在输出排空之后 */
export type TerminalEvent =
  | { type: "output"; event: TerminalOutputEvent }
  | { type: "exit"; terminalId: string; exitCode: number }
  /**
   * agent 开了一个可见终端。renderer 收到后**自动点亮终端面板位并激活该 tab**
   * （Proma 的 terminal:agent-open 同款）：agent 要在用户眼前干活，而不是在
   * 用户看不见的地方跑。只对 agent 开的终端发——人工开的不需要（人自己点的）。
   *
   * `terminal` 是刚建成的现状，随事件一起给：面板据此**收养**这个 tab（它的 tabs 是
   * 挂载时的一次性快照，不收养就没有 xterm 视图 → 没有人 ack → runtime 的输出背压
   * 把这个终端永久卡在第 1 批）。带全文而不是让 renderer 再拉一次 list：那条路上
   * 的旧清单会把用户刚关掉的 tab 复活。
   */
  | { type: "agent-open"; terminalId: string; sessionId: string; terminal: TerminalInfo };

/**
 * 重放缓冲的一条追加（main 侧每个终端一份，容量见 appendReplay）。
 * sequence 不前进（重复或乱序旧批）就整个丢掉——renderer 重挂载靠它去重。
 */
export function appendReplay(
  buffer: { output: string; sequence: number },
  event: TerminalOutputEvent,
  maxChars: number,
): { output: string; sequence: number } {
  if (event.sequence <= buffer.sequence) return buffer;
  const merged = buffer.output + event.data;
  // 只留末尾 maxChars：重放永远从「最近的历史」开始，前面的旧输出 xterm 自己的
  // scrollback 已经画过、也不值得为它付内存
  const output = merged.length > maxChars ? merged.slice(merged.length - maxChars) : merged;
  return { output, sequence: event.sequence };
}

// ── agent 的读视图：控制序列剥离 + 分页 ────────────────────────────────

/**
 * `terminal_read` 默认返回的字符数（**纯文本视图**的末尾这么多）。终端输出里九成是
 * 回显、进度条与 ANSI 着色，1.2 万字符足够看「上一条命令跑完没有、报了什么」。
 */
export const TERMINAL_READ_DEFAULT_LIMIT = 12_000;

/** 单次 `terminal_read` 的字符上限。再大就分页——一次塞 5 万字符进上下文不如问两次 */
export const TERMINAL_READ_MAX_LIMIT = 48_000;

/**
 * 终端转义序列的整条匹配。写成一条而不是循环扫描：一次正则替换跑完，坏序列
 * （半条 CSI、没配对的 OSC）按「不是序列」处理，由控制符那一轮收拾。
 */
const TERMINAL_ESCAPE_PATTERN = new RegExp(
  [
    "\u001b\\[[0-9:;<=>?]*[ -/]*[@-~]", // CSI
    "\u001b\\][^\u0007\u001b]*(?:\u0007|\u001b\\\\)", // OSC：BEL 或 ST 收尾
    "\u001b[P^_X][^\u001b]*(?:\u001b\\\\)?", // DCS / PM / APC / SOS
    "\u001b[ -/]+[0-~]", // nF：ESC ( B、ESC $ B…（终字节 0x30–0x7E）
    "\u001b[@-Z_\\\\]", // 单字符转义：ESC = ESC > ESC M ESC 7 …
  ].join("|"),
  "g",
);

/**
 * 剥掉终端控制序列，得到给人/模型读的纯文本。
 *
 * 数据源是 runtime 的**原始输出**（raw 保留：xterm 画图要它，见 appendReplay），
 * 这里只做读视图的规整。剥什么：
 *   CSI（`ESC [ … 终字节`，光标移动 / 颜色 / 清屏 / 私有模式）
 *   OSC（`ESC ] … BEL|ESC \`，窗口标题、超链接）
 *   DCS / PM / APC（`ESC P|^|_ … ESC \`，sixel、应用层协议）
 *   nF 与单字符转义（`ESC ( B`、`ESC =`、`ESC M`…）
 * 剩下的 C0 控制符只留 `\n` 与 `\t`：`\r\n` 先折成 `\n`，落单的 `\r`（PowerShell
 * 进度条的老家）直接丢掉——它在本视图里的意思是「回到行首」，没有对应字符。
 *
 * 顺序要紧：先按 ESC 序列整条摘掉（OSC 的终止符本身就是 BEL，先删控制符会失去
 * 终止边界），再收拾残留下来的控制符。
 */
export function stripTerminalControlSequences(raw: string): string {
  return raw
    .replace(TERMINAL_ESCAPE_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/** `terminal_read` 的入参（模型给的部分都已收窄；越界值由 pageTerminalOutput 夹） */
export interface TerminalReadOptions {
  /** 纯文本视图里的字符偏移。缺席 = 读末尾（默认 12000 字符） */
  offset?: number;
  /** 最多返回多少字符，1–48000。缺席 = 12000 */
  limit?: number;
}

/** `terminal_read` 的结果。offset 系都指**纯文本视图**的坐标，不是 raw 缓冲的 */
export interface TerminalReadView {
  text: string;
  /** 本次从哪个字符开始（模型传的 offset 被夹过之后的真值） */
  startOffset: number;
  /** 本次到哪个字符结束；把它当 offset 传回去就是继续往后读 */
  endOffset: number;
  /** 纯文本视图的总长度 */
  total: number;
  /** 还有没读到的尾巴 */
  hasMore: boolean;
}

/**
 * 在纯文本视图上开一页。**夹取而非报错**：模型把 limit 写成 999999 或 offset 写成
 * 负数都不是要它失败，是要「尽量多给 / 从头给」。
 */
export function pageTerminalOutput(raw: string, options: TerminalReadOptions = {}): TerminalReadView {
  const text = stripTerminalControlSequences(raw);
  const total = text.length;
  const limit = clampReadNumber(options.limit, TERMINAL_READ_DEFAULT_LIMIT, 1, TERMINAL_READ_MAX_LIMIT);
  const startOffset =
    options.offset === undefined
      ? Math.max(0, total - limit)
      : clampReadNumber(options.offset, 0, 0, Math.max(0, total));
  const endOffset = Math.min(total, startOffset + limit);
  return {
    text: text.slice(startOffset, endOffset),
    startOffset,
    endOffset,
    total,
    hasMore: endOffset < total,
  };
}

/** 数字入参的收窄：非有限数（含模型写成的 "12000" 字符串）回退 fallback，再夹进 [min, max] */
function clampReadNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

// ── agent 终端工具的请求 / 回执（shared/agent-ipc.ts 的 terminalRequest 用）────

/**
 * agent 的终端工具请求（agent 进程 → 主进程）。**六个工具一对一的动作**：
 * terminal_open / terminal_execute / terminal_read / terminal_list /
 * terminal_interrupt / terminal_close。
 *
 * 与浏览器工具（shared/browser.ts）同一条边界：agent 进程不碰 PTY、不碰 userData，
 * 只发请求等回执；终端本体在主进程的 TerminalService。
 */
export type TerminalToolRequest =
  /**
   * 开一个**可见**终端 tab，不跑命令。cwd 缺席 = 会话 cwd（授权目录内）。
   * 没有 title 参数：tab 标题由主进程按 cwd 末段铸（面板上显示文件夹名），
   * 再由 agent 起一个名字就是两个会漂的真源。
   */
  | { action: "open"; cwd?: string }
  /**
   * 往可见终端写一条完整命令（`command + "\r"`）。**立即返回、不带输出**——
   * 结果里明确 `outputSharedWithAgent: false`，要结果自己 terminal_read。
   * terminalId 缺席 = 开一个新终端再写（复用纪律见工具的 promptGuidelines）。
   */
  | { action: "execute"; command: string; terminalId?: string; cwd?: string }
  | { action: "read"; terminalId: string; offset?: number; limit?: number }
  | { action: "list" }
  | { action: "interrupt"; terminalId: string }
  | { action: "close"; terminalId: string };

/** terminalRequest 的回执载荷：主进程组装，agent 进程翻成工具结果（browserResult 同款） */
export type TerminalToolOutcome =
  | {
      ok: true;
      /** 给模型的正文（纯文本，含下一步该干什么） */
      text: string;
      /** 涉及的那个终端的现状（list 之外每个动作都带，模型拿它当可信的 terminalId） */
      terminal?: TerminalInfo;
    }
  | { ok: false; error: string };
