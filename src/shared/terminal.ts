/**
 * 终端面板契约 —— IPC 四层的第 1 层。
 *
 * 这是**人工终端**（用户在右栏面板里亲手敲的 shell）：无审批层，renderer 只递键入与
 * 尺寸，shell 可执行文件永远由主进程侧的 terminal runtime 探测与解析——renderer
 * 传什么都不信，`cwd` 也只是「想在哪儿开」的意愿（失效时主进程回退 homedir）。
 *
 * 链路（与 agent 域同构）：renderer ↔ IPC ↔ 主进程（TerminalService）↔ MessagePort
 * ↔ terminal utility 进程（node-pty）。一个 runtime 进程管全部 PTY；PTY 与快照缓冲
 * 都活在主进程/runtime 侧，renderer 的面板与 xterm 实例随时可拆可建——重挂载先拉
 * `snapshot` 重放、再接续 `output` 事件流，按 `sequence` 去重。
 *
 * PR2（agent 终端工具组）预留的缝：**所有权字段不在契约里**——今天全部终端都归
 * 「人工」，agent 开的终端才需要归属 id 与授权校验；到那时加字段是加法，现有
 * 消息形状不动。
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

/** `terminal:create` 的载荷。cwd 缺席或失效时主进程回退 homedir（人工终端不报错） */
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

/** main → renderer 的推送。output 与 exit 的顺序由 runtime 保证：exit 在输出排空之后 */
export type TerminalEvent =
  | { type: "output"; event: TerminalOutputEvent }
  | { type: "exit"; terminalId: string; exitCode: number };

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
