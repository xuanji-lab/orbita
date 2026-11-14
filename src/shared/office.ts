/**
 * Office「指哪打哪」——xlsx / pptx 的应用内渲染、点击标注与 agent 批改的契约。
 * IPC 四层契约的第 1 层（与实做同一次提交）。
 *
 * **渲染只用 `view <file> html`**：实测输出是自包含 HTML（内联样式与 data URI 图片），
 * 不需要任何外部浏览器；截图走 Electron 自己的 `capturePage`，不用 `view screenshot`
 * （它要求机器上装着 Chrome / Edge，且没有配置项）。位图链路见主进程 office/ipc.ts。
 *
 * **改只用 `batch`**：`set` / `add` / `remove` 拼成一条 JSON 数组，一次 open/save。
 * 默认是 atomic 的——任何一项失败整批回滚，所以「改了一半」不会落盘。禁 `open` /
 * resident / `refresh`（见 docs 调研：resident 有 CPU 100% 与 TMPDIR 长路径两条已知问题，
 * 我们不需要它；batch 单独跑就是一次 open/save 循环）。
 *
 * **标注路径就是 officecli 的 DOM path**（`view html` 的 `[data-path]` 与 `get` 的输出同源）：
 *   xlsx  `/Sheet1/B2`、区间 `/Sheet1/B2:D5`
 *   pptx  `/slide[3]/table[@id=3]`、`/slide[1]/shape[@id=100000]`
 * 用户在预览里点一下，路径就进输入框（见 shared/quote.ts 的 office 字段），模型据此调
 * `edit_office`，不需要自己数格子。
 */
import type { FileListRequest } from "./files.ts";

export type OfficeFormat = "xlsx" | "pptx";

/** 单次调用的硬超时。杀整个进程树（Windows 下 officecli 会带子进程） */
export const OFFICE_TIMEOUT_MS = 15_000;

/** 一次渲染最多收多少 HTML（超过就不塞进 iframe，退回网格 / 大纲——几 MB 的 srcdoc 会把面板卡死） */
export const OFFICE_HTML_MAX_BYTES = 8 * 1024 * 1024;

/** 一次 batch 最多几项操作：模型一口气改几十格时，拆成几次比一条巨大的 argv 安全 */
export const OFFICE_MAX_OPS = 40;

/** 一页 / 一格路径的最大长度（长的多半是模型拼坏了） */
export const OFFICE_MAX_PATH_CHARS = 500;

/** 二进制从哪儿找到的（设置页与工具错误里如实说来源） */
export type OfficeBinSource = "settings" | "env" | "packaged" | "dev" | "common";

/** OfficeCLI 的可用性快照；`available:false` 时 `detail` 是人话原因 */
export interface OfficeStatus {
  available: boolean;
  version: string | null;
  source: OfficeBinSource | null;
  /** 找到的可执行文件绝对路径 */
  bin: string | null;
  detail: string | null;
}

/**
 * 渲染请求：白名单字段与 fs:read 相同（root/dir 由主进程再核一遍），`dir` 就是文件路径。
 * 只认 .xlsx / .pptx——其余格式不进这条通道。
 */
export type OfficeRenderRequest = FileListRequest;

/**
 * 渲染结果。`unavailable` 不是异常：OfficeCLI 没装 / 跑不动是**正常降级**，
 * 面板据此退回网格 / 大纲并显示一行说明（不弹错误条）。
 */
export type OfficeRenderResult =
  | { kind: "html"; html: string; version: string; elapsedMs: number }
  | { kind: "unavailable"; detail: string };

/** 一次改动：给 UI 的清单条目（path 是 officecli 的 DOM path） */
export interface OfficeChange {
  /** 稳定 id（一次编辑里 index + timestamp），React key 用 */
  id: string;
  command: "set" | "add" | "remove";
  path: string;
  /** 改前的值（空格子的 get 会失败 → null）；add 恒为 null */
  before: string | null;
  /** 改后的值（remove 恒为 null；add 是新建元素的中文描述） */
  after: string | null;
}

export interface OfficeChangeFailure {
  path: string;
  error: string;
}

/** 一份文件当前的改动清单（一轮内多笔编辑聚合成一份） */
export interface OfficeChanges {
  /** 没有改动时 file 为请求里的路径、items 为空 */
  file: string;
  items: OfficeChange[];
  /** 这批改动开始前的备份（在主进程的 userData 里；回退用它还原） */
  backup: string | null;
  startedAt: number | null;
}

/** `edit_office` 的一次操作。add 的 path 是**父路径**（往哪加），set/remove 是目标路径 */
export interface OfficeOp {
  op: "set" | "add" | "remove";
  path: string;
  /** add 必填：officecli 的元素类型（shape / textbox / table / slide …） */
  type?: string;
  /** set / add 的属性（officecli 的 prop 名与值；value / text / bold / x / y …） */
  props?: Record<string, string | number | boolean>;
}

/** agent → 主进程的请求（`officeRequest` 事件） */
export type OfficeAgentRequest =
  | {
      kind: "read";
      /** 绝对路径（主进程按会话根再核一遍） */
      file: string;
      /** DOM path，默认 / */
      path?: string;
      /** get 的层级（默认 2：够看清一页 / 一张表的成员） */
      depth?: number;
    }
  | { kind: "edit"; file: string; ops: OfficeOp[] };

/** 主进程 → agent 的回执 */
export type OfficeAgentOutcome =
  | { ok: true; kind: "read"; text: string }
  | {
      ok: true;
      kind: "edit";
      file: string;
      version: string;
      elapsedMs: number;
      items: OfficeChange[];
      failures: OfficeChangeFailure[];
      /** 这批改动之前的备份是否存在（可回退） */
      canRevert: boolean;
    }
  | { ok: false; error: string };

/** 回退的回执（renderer 的「回退整批」按钮） */
export interface OfficeRevertResult {
  ok: boolean;
  /** 失败原因（ok:false 时） */
  error?: string;
  /** 还原回文件里的改动条数 */
  restored: number;
}

/** 把文件改成可执行的绝对路径；认不出格式返回 null */
export function officeFormatOf(path: string): OfficeFormat | null {
  if (/\.xlsx$/i.test(path)) return "xlsx";
  if (/\.pptx$/i.test(path)) return "pptx";
  return null;
}

/**
 * 规范化一个 data-path：必须是 `/` 开头的绝对 DOM path，不许含空白 / 换行 / 引号
 * （会把 batch 的 JSON 拼坏）；超过上限的当作模型拼坏了。返回 null = 不认。
 */
export function normalizeOfficePath(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > OFFICE_MAX_PATH_CHARS) return null;
  if (!trimmed.startsWith("/")) return null;
  if (/[\s"'`<>]/.test(trimmed)) return null;
  if (trimmed.includes("..")) return null;
  return trimmed;
}

/** xlsx 单元格路径拆成「表名 + 单元地址」（`/Sheet1/B2` → Sheet1 / B2）；不是单元格返回 null */
export function xlsxCellOf(path: string): { sheet: string; cell: string } | null {
  const match = /^\/([^/]+)\/([A-Za-z]{1,3}[0-9]{1,7})$/.exec(path);
  if (match === null) return null;
  return { sheet: match[1] as string, cell: (match[2] as string).toUpperCase() };
}

/** 列字母 → 0 起的列号（A=0, Z=25, AA=26） */
export function xlsxColumnIndex(letters: string): number {
  let index = 0;
  for (const char of letters.toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

/** 列号 → 列字母（0=A）；非法值回空串（调用方按「不是单元格」处理） */
export function xlsxColumnLabel(index: number): string {
  if (!Number.isInteger(index) || index < 0) return "";
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** `/Sheet1/B2:D5` 拆成两端；`/Sheet1/B2` 当作单元点 */
export function xlsxRangeOf(path: string): { sheet: string; from: string; to: string } | null {
  const match = /^\/([^/]+)\/([A-Za-z]{1,3}[0-9]{1,7})(?::([A-Za-z]{1,3}[0-9]{1,7}))?$/.exec(path);
  if (match === null) return null;
  const from = (match[2] as string).toUpperCase();
  return { sheet: match[1] as string, from, to: (match[3] ?? match[2] as string).toUpperCase() };
}

/**
 * 两次点单元格 → 一个区间路径。同一张表才成立（跨表没有可表达的形式），
 * 顺序按左上 / 右下归一（反向拖动与反向 shift 点选同一结果）。
 */
export function xlsxRangePath(anchor: string, target: string): string | null {
  const a = xlsxCellOf(anchor);
  const b = xlsxCellOf(target);
  if (a === null || b === null || a.sheet !== b.sheet) return null;
  if (a.cell === b.cell) return anchor;
  const split = (cell: string): { col: number; row: number } => {
    const match = /^([A-Z]+)([0-9]+)$/.exec(cell) as RegExpExecArray;
    return { col: xlsxColumnIndex(match[1] as string), row: Number(match[2]) };
  };
  const first = split(a.cell);
  const second = split(b.cell);
  const left = Math.min(first.col, second.col);
  const right = Math.max(first.col, second.col);
  const top = Math.min(first.row, second.row);
  const bottom = Math.max(first.row, second.row);
  return `/${a.sheet}/${xlsxColumnLabel(left)}${top}:${xlsxColumnLabel(right)}${bottom}`;
}

/**
 * 路径 → 给人看的标注（chip 上、输入框引用里都用它）：
 *   xlsx  `/Sheet1/B2:D5` → `Sheet1!B2:D5`
 *   pptx  `/slide[3]/table[@id=3]` → 原样（DOM path 就是模型的坐标系）
 */
export function officeDisplayPath(format: OfficeFormat, path: string): string {
  if (format !== "xlsx") return path;
  const range = xlsxRangeOf(path);
  if (range === null) return path;
  return range.from === range.to ? `${range.sheet}!${range.from}` : `${range.sheet}!${range.from}:${range.to}`;
}

/** batch 请求里的一项（形状与 officecli batch 的 JSON 数组一致） */
export interface OfficeBatchItem {
  command: "get" | "set" | "add" | "remove";
  path?: string;
  parent?: string;
  type?: string;
  props?: Record<string, string>;
}

/** props 一律转成字符串：officecli 的 --prop 值就是文本，数字 / 布尔交给它自己解析 */
export function officePropsOf(props: Record<string, string | number | boolean> | undefined): Record<string, string> | undefined {
  if (props === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key === "" || key.includes(" ")) continue;
    out[key] = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * 一次编辑 → 「先读后写」两条 batch 请求。
 *
 * - `reads`：`set` / `remove` 在改之前取一份旧值（`add` 没有旧值）。
 *   单独一条 batch、`--best-effort`：空格子的 get 会失败，但读不改盘，
 *   不能让它把整批回滚掉。
 * - `items`：真正的写，默认 atomic（任何一项失败整批不落盘）。
 *
 * 读与写分开的第二个理由：reads 里的失败是**信息**（这格本来就没有内容），
 * 不是错误——合在一条 atomic batch 里，一个空格子就能让整次编辑失败。
 */
export function buildOfficeBatch(ops: readonly OfficeOp[]): { reads: OfficeBatchItem[]; items: OfficeBatchItem[] } {
  const reads: OfficeBatchItem[] = [];
  const items: OfficeBatchItem[] = [];
  for (const op of ops) {
    const path = normalizeOfficePath(op.path);
    if (path === null) continue;
    if (op.op === "set") {
      reads.push({ command: "get", path });
      const props = officePropsOf(op.props);
      items.push({ command: "set", path, ...(props === undefined ? {} : { props }) });
    } else if (op.op === "remove") {
      reads.push({ command: "get", path });
      items.push({ command: "remove", path });
    } else {
      const props = officePropsOf(op.props);
      const type = (op.type ?? "").trim();
      items.push({
        command: "add",
        parent: path,
        ...(type === "" ? {} : { type }),
        ...(props === undefined ? {} : { props }),
      });
    }
  }
  return { reads, items };
}

/** batch --json 的一条结果（只取这里用得上的字段） */
export interface OfficeBatchResultItem {
  index: number;
  success: boolean;
  /** get 的正文（第一个匹配节点的 text / 标题） */
  text: string | null;
  /** add 成功时新建元素的路径 */
  addedPath: string | null;
  error: string | null;
}

export interface OfficeBatchReport {
  success: boolean;
  results: OfficeBatchResultItem[];
  failed: number;
  /** 解析不了 JSON（老版本 / 被截断）时为 null，原文进 detail */
  parsed: boolean;
}

/** 从 get 的 output 里取一句可读的值（cell.text / 元素标题 / 第一行预览） */
function readTextOf(output: unknown): string | null {
  if (typeof output === "string") return output.trim() === "" ? null : output.trim();
  if (typeof output !== "object" || output === null) return null;
  const record = output as { results?: unknown; text?: unknown; title?: unknown; preview?: unknown };
  if (Array.isArray(record.results) && record.results.length > 0) {
    const first = record.results[0];
    if (typeof first === "object" && first !== null) {
      const item = first as { text?: unknown; title?: unknown; preview?: unknown };
      for (const value of [item.text, item.title, item.preview]) {
        if (typeof value === "string" && value.trim() !== "") return value.trim();
      }
      return null;
    }
  }
  if (typeof record.text === "string" && record.text.trim() !== "") return record.text.trim();
  if (typeof record.title === "string" && record.title.trim() !== "") return record.title.trim();
  return null;
}

/**
 * 解析 `batch --json` 的输出。老版本 / 被截断时 `parsed:false`——调用方退成
 * 「按退出码判断」，不把一次成功的编辑报成失败。
 */
export function parseOfficeBatchReport(stdout: string): OfficeBatchReport {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { success: false, results: [], failed: 0, parsed: false };
  }
  const data = typeof raw === "object" && raw !== null ? (raw as { success?: unknown; data?: unknown }).data : null;
  const resultsRaw =
    typeof data === "object" && data !== null ? (data as { results?: unknown }).results : undefined;
  if (!Array.isArray(resultsRaw)) return { success: false, results: [], failed: 0, parsed: false };
  const results: OfficeBatchResultItem[] = [];
  for (const entry of resultsRaw) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as { index?: unknown; success?: unknown; output?: unknown; error?: unknown };
    const index = typeof item.index === "number" ? item.index : results.length;
    const outputText = readTextOf(item.output);
    const addedMatch = outputText === null ? null : /^Added .* at (\/\S*)$/.exec(outputText);
    results.push({
      index,
      success: item.success === true,
      text: addedMatch === null ? outputText : null,
      addedPath: addedMatch === null ? null : (addedMatch[1] as string),
      error: typeof item.error === "string" ? item.error : null,
    });
  }
  const failed = results.filter((item) => !item.success).length;
  return { success: failed === 0, results, failed, parsed: true };
}

/**
 * batch 结果 + 编辑前的读数 → 改动清单。`reads` 与 `ops` 里的 set/remove 一一对应
 * （buildOfficeBatch 保序），所以按 op 自己的读写位置取旧值。
 */
export function officeChangesFromBatch(
  ops: readonly OfficeOp[],
  report: OfficeBatchReport,
  reads: readonly OfficeBatchResultItem[],
  stamp: number,
): { items: OfficeChange[]; failures: OfficeChangeFailure[] } {
  const items: OfficeChange[] = [];
  const failures: OfficeChangeFailure[] = [];
  let readIndex = 0;
  ops.forEach((op, index) => {
    const path = normalizeOfficePath(op.path) ?? op.path;
    const result = report.results.find((entry) => entry.index === index) ?? null;
    const before =
      op.op === "add" ? null : (reads[readIndex]?.text ?? null);
    if (op.op !== "add") readIndex += 1;
    if (result === null || !result.success) {
      failures.push({ path, error: result?.error ?? "officecli did not report this item" });
      return;
    }
    if (op.op === "set") {
      const props = officePropsOf(op.props) ?? {};
      const after =
        props["value"] ?? props["text"] ?? (Object.keys(props).length > 0 ? Object.entries(props).map(([k, v]) => `${k}=${v}`).join(", ") : "");
      items.push({ id: `${stamp}:${index}`, command: "set", path, before, after });
      return;
    }
    if (op.op === "remove") {
      items.push({ id: `${stamp}:${index}`, command: "remove", path, before, after: null });
      return;
    }
    const added = result.addedPath ?? path;
    items.push({
      id: `${stamp}:${index}`,
      command: "add",
      path: added,
      before: null,
      after: officePropsOf(op.props)?.["text"] ?? officePropsOf(op.props)?.["value"] ?? (op.type ?? ""),
    });
  });
  return { items, failures };
}
