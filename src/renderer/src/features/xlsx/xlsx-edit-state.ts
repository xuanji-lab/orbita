/**
 * 网格编辑的**纯状态机**（选区 / 编辑草稿 / 未保存改动）。独立成模块而不是塞进
 * XlsxView.tsx：组件要连 IPC + React，这里只留纯函数，`node --test` 直接可测——
 * 「回车往下、Tab 往右、Esc 取消、同一格改两次只算一条、改回原值就不算改动」这些
 * 规则用不着开窗口就能钉住。
 *
 * 坐标：本模块内部一律 **0-based**（与 `XlsxSheet.rows[r][c]`、合并区同一套）；只有
 * 出门去主进程的 `XlsxCellEdit` 换成 1-based（A1 写法）。换坐标只在这一处发生。
 *
 * 一个格的「显示文本」有三层来源，优先级从高到低：
 *   1. 未保存的改动（`pending`）——用户刚敲的；
 *   2. 预览回执里的格（公式取缓存值）；
 *   3. 空。
 * 第 2 层里「有公式但盘上没有缓存值」的格显示**公式原文**并标 `uncached`：我们不重算，
 * 假装有数就是骗人（见 `main/xlsx/edit.ts` 顶注释）。
 */
import type { XlsxCell, XlsxCellEdit } from "@shared/xlsx";

/** 一格的位置（0-based，与 `XlsxSheet.rows` 的下标同一套） */
export interface CellPosition {
  row: number;
  col: number;
}

/** 一条未保存的改动 */
export interface PendingCellEdit {
  /** 0-based 位置（网格用） */
  row: number;
  col: number;
  /** 给主进程的那一条（1-based；带 `before` 供改动清单显示） */
  edit: XlsxCellEdit;
  /** 改之前的显示文本（改动清单的「旧」） */
  before: string;
  /** 改之后的显示文本（清单的「新」；公式带前导 `=`） */
  after: string;
  /** 写进去的是公式：盘上没有缓存值，数值要 Excel 打开后才更新 */
  formula: boolean;
}

/** 正在编辑的那一格：草稿是输入框里的原文（公式带 `=`） */
export interface CellEditing extends CellPosition {
  draft: string;
}

export interface GridEditState {
  /** 选中的格；null = 还没选（首屏） */
  active: CellPosition | null;
  /** 正在编辑的格；null = 不在编辑 */
  editing: CellEditing | null;
  /** 未保存的改动，按提交顺序；同一格改多次只留最新一条（位置不变） */
  pending: PendingCellEdit[];
}

export const EMPTY_GRID_EDIT: GridEditState = { active: null, editing: null, pending: [] };

/** 一格的显示结果（网格照它画） */
export interface CellDisplay {
  text: string;
  /** 有公式、没有缓存值：显式说「未计算」，不假装有数 */
  uncached: boolean;
  /** 有未保存的改动：画角标 */
  edited: boolean;
  /** 数值（含用户刚敲的数字）：右对齐 + 等宽 */
  numeric: boolean;
}

const sameCell = (a: CellPosition, b: CellPosition): boolean => a.row === b.row && a.col === b.col;

/** 选中一格。正在编辑就当作取消（未提交的草稿丢掉——与常见的表格一致） */
export function selectCell(state: GridEditState, row: number, col: number): GridEditState {
  return { active: { row, col }, editing: null, pending: state.pending };
}

/** 进入编辑。`draft` 省略 = 从这一格现在的原文开始（双击）；给了就是「直接键入」的首字符 */
export function beginEdit(state: GridEditState, row: number, col: number, draft?: string): GridEditState {
  return {
    active: { row, col },
    editing: { row, col, draft: draft ?? state.editing?.draft ?? "" },
    pending: state.pending,
  };
}

export function updateDraft(state: GridEditState, draft: string): GridEditState {
  if (state.editing === null) return state;
  return { ...state, editing: { ...state.editing, draft } };
}

/** Esc：丢掉草稿，选区留在原处 */
export function cancelEdit(state: GridEditState): GridEditState {
  return state.editing === null ? state : { ...state, editing: null };
}

/** 一个格现在显示什么（含公式原文与未保存改动的叠加） */
export function cellDisplay(pending: PendingCellEdit | null, cell: XlsxCell | null): CellDisplay {
  if (pending !== null) {
    return {
      text: pending.after,
      uncached: pending.formula,
      edited: true,
      numeric: typeof pending.edit.value === "number",
    };
  }
  if (cell === null) return { text: "", uncached: false, edited: false, numeric: false };
  const uncached = cell.formula !== undefined && cell.text === "";
  return {
    text: uncached ? `=${cell.formula ?? ""}` : cell.text,
    uncached,
    edited: false,
    numeric: cell.numeric === true,
  };
}

/** 这一格现在该显示 / 该带进输入框的原文（公式带 `=`） */
export function cellRawText(pending: PendingCellEdit | null, cell: XlsxCell | null): string {
  if (pending !== null) return pending.after;
  if (cell === null) return "";
  if (cell.formula !== undefined) return `=${cell.formula}`;
  return cell.text;
}

/** 草稿 → 要写进文件的内容。空草稿 = 清空这一格（`value: null`） */
export function parseDraft(draft: string): { value?: string | number | null; formula?: string } {
  if (draft.startsWith("=")) {
    const formula = draft.slice(1).trim();
    return formula === "" ? { value: null } : { formula };
  }
  if (draft === "") return { value: null };
  // 纯数字按数字写（Excel 的读法）：`007` 是文本（有前导零），`1.5` / `-2` 是数字
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(draft)) {
    const parsed = Number(draft);
    if (Number.isFinite(parsed)) return { value: parsed };
  }
  return { value: draft };
}

/** 草稿的显示形态（清单的「新」）：公式带 `=`、清空是空串 */
function draftDisplay(draft: string): { after: string; formula: boolean } {
  const parsed = parseDraft(draft);
  if (parsed.formula !== undefined) return { after: `=${parsed.formula}`, formula: true };
  if (parsed.value === null || parsed.value === undefined) return { after: "", formula: false };
  return { after: String(parsed.value), formula: false };
}

/**
 * 按一个格**原来**的样子判断「这次编辑算不算改动」：
 *  - 草稿与原来的显示文本相同、且原来没有公式 → 不算（用户只是把字又敲了一遍）；
 *  - 原来是空格、草稿也是空 → 不算；
 *  - 原来是公式格 → 写值一定算改动（公式没了）。
 */
function isNoop(draft: string, original: XlsxCell | null): boolean {
  const parsed = parseDraft(draft);
  if (parsed.formula !== undefined) return false;
  const value = parsed.value ?? null;
  if (value === null) return original === null || (original.text === "" && original.formula === undefined);
  if (original === null || original.formula !== undefined) return false;
  return String(value) === original.text;
}

export interface CommitInput {
  /** 表名（写进 `XlsxCellEdit.sheet`） */
  sheet: string;
  /** 提交后选区去哪：回车往下、Tab 往右、公式栏 / 失去焦点不动 */
  next: "down" | "right" | "none";
  /** 网格的边界（0-based 上界，用来夹住移动后的选区） */
  bounds: { rows: number; cols: number };
  /** 这一格在预览里的原样（没有就是空） */
  original: XlsxCell | null;
}

/**
 * 提交草稿：算出要写回的那一条、把未保存清单更新掉、选区按 `next` 移动。
 * 不在编辑状态就原样返回（可安全地当 keydown 的兜底）。
 */
export function commitEdit(state: GridEditState, input: CommitInput): GridEditState {
  const editing = state.editing;
  if (editing === null) return state;
  const draft = editing.draft;
  const pending = state.pending.filter((item) => item.row !== editing.row || item.col !== editing.col);
  const moved = moveFrom(editing, input.next, input.bounds);
  if (isNoop(draft, input.original)) {
    return { active: moved, editing: null, pending };
  }
  const parsed = parseDraft(draft);
  const { after, formula } = draftDisplay(draft);
  const before = input.original === null ? "" : cellRawText(null, input.original);
  const edit: XlsxCellEdit = {
    sheet: input.sheet,
    row: editing.row + 1,
    col: editing.col + 1,
    ...(parsed.formula !== undefined ? { formula: parsed.formula } : { value: parsed.value ?? null }),
    before: input.original === null ? null : input.original.text,
  };
  return {
    active: moved,
    editing: null,
    // 同一格在清单里的位置不变（用户看到的是「这一处改成了什么」，不是改动历史）
    pending: insertKeepingOrder(state.pending, { row: editing.row, col: editing.col, edit, before, after, formula }, pending),
  };
}

/** 已存在的条目留在原位（覆盖），新条目追加在末尾 */
function insertKeepingOrder(all: readonly PendingCellEdit[], next: PendingCellEdit, others: PendingCellEdit[]): PendingCellEdit[] {
  const index = all.findIndex((item) => item.row === next.row && item.col === next.col);
  if (index < 0) return [...others, next];
  const out = [...others];
  const position = all.slice(0, index).filter((item) => others.includes(item)).length;
  out.splice(position, 0, next);
  return out;
}

function moveFrom(position: CellPosition, next: "down" | "right" | "none", bounds: { rows: number; cols: number }): CellPosition {
  if (next === "down") return { row: Math.min(position.row + 1, Math.max(0, bounds.rows - 1)), col: position.col };
  if (next === "right") return { row: position.row, col: Math.min(position.col + 1, Math.max(0, bounds.cols - 1)) };
  return position;
}

/** 逐条撤回一处改动 */
export function removePending(state: GridEditState, row: number, col: number): GridEditState {
  const pending = state.pending.filter((item) => item.row !== row || item.col !== col);
  return pending.length === state.pending.length ? state : { ...state, pending };
}

/** 全部撤回（本次未保存的改动） */
export function clearPending(state: GridEditState): GridEditState {
  return state.pending.length === 0 ? state : { ...state, pending: [] };
}

export function pendingAt(state: GridEditState, row: number, col: number): PendingCellEdit | null {
  return state.pending.find((item) => item.row === row && item.col === col) ?? null;
}

export function isDirty(state: GridEditState): boolean {
  return state.pending.length > 0;
}

/** 保存要发给主进程的那一批（1-based、带 sheet 与旧值） */
export function pendingEdits(state: GridEditState): XlsxCellEdit[] {
  return state.pending.map((item) => item.edit);
}

/** 保存按钮能不能点：有改动、且不在保存中 */
export function canSave(state: GridEditState, saving: boolean): boolean {
  return !saving && isDirty(state);
}

/** 方向键 / Tab 在「没在编辑」时移动选区（夹在网格内） */
export function moveSelection(
  state: GridEditState,
  direction: "up" | "down" | "left" | "right",
  bounds: { rows: number; cols: number },
): GridEditState {
  const current = state.active ?? { row: 0, col: 0 };
  const row = direction === "up" ? current.row - 1 : direction === "down" ? current.row + 1 : current.row;
  const col = direction === "left" ? current.col - 1 : direction === "right" ? current.col + 1 : current.col;
  const clamped = {
    row: Math.max(0, Math.min(row, Math.max(0, bounds.rows - 1))),
    col: Math.max(0, Math.min(col, Math.max(0, bounds.cols - 1))),
  };
  return { active: clamped, editing: null, pending: state.pending };
}

/** 这一格是不是同一格（组件里比对选区/编辑用） */
export const isSameCell = sameCell;
