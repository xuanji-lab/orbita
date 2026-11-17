/**
 * 审阅条的数据：把「一次 AI 改动」与「文档里剩下的修订」拼成一行一行的裁决单位。
 *
 * **裁决单位必须是 `applied[].revisionIds`，不是 `getTrackedChanges()` 的单条**（实测）：
 * 一次 replace 产出删除侧 + 插入侧两个 `w:id`，只接受其中一个时干净视图的文本**看起来没变**、
 * 却残留半条修订——用户会以为按钮坏了。所以：
 *
 *   - 我们自己写进去的改动按 `DocxEditGroup`（op → revisionIds）分组，整组裁决；
 *   - 别人写的 / 上次打开就有的修订，按「同一段 + 同一作者 + 同一时刻 + 相邻」折叠成一行
 *     （Word 写一次替换也是 del 紧跟 ins，折叠就是用户眼里的「一条改动」）；
 *   - 其余（格式修订、行/格增删、段落标记……）各自一行。
 *
 * 分组信息（哪几个 id 是一次 op）只活在会话里：重开文档后 id 会重排，官方原语里没有
 * 「这次 replace 的两个 id 属于同一条建议」的持久标记（suggested 模式有，但它的标记
 * 不会被序列化进文件）。所以重开后退回上面的启发式折叠——如实写在报告里。
 */
import type { FolioReviewChange } from "@stll/folio-core/ai-edits";
import type { DocxEditGroup } from "@shared/docx";

/** 审阅条上的一行 */
export interface DocxChangeRow {
  key: string;
  /** **整组**一起接受 / 拒绝的 id 列表 */
  revisionIds: number[];
  author: string;
  blockId: string | null;
  /** 改前（删除侧的文字）；纯插入为空串 */
  before: string;
  /** 改后（插入侧的文字）；纯删除为空串 */
  after: string;
  kind: "replace" | "insert" | "delete" | "other";
  date: string | null;
  /** 这一行是我们（agent）写进去的：有账可查 */
  ours: boolean;
  /** 锚点失配后按上下文重新定位过（只有我们的行才有） */
  reanchored: boolean;
}

const isInsert = (change: FolioReviewChange): boolean => change.type === "insertion";
const isDelete = (change: FolioReviewChange): boolean => change.type === "deletion";

/** 一行里能裁决的 id：只留文档里还在的那些（用户可能已经单独接受过一条） */
function liveIds(ids: readonly number[], byId: ReadonlyMap<number, FolioReviewChange>): number[] {
  return ids.filter((id) => byId.has(id));
}

function kindOf(before: string, after: string): DocxChangeRow["kind"] {
  if (before !== "" && after !== "") return "replace";
  if (before === "") return "insert";
  if (after === "") return "delete";
  return "other";
}

/** 同一段（blockId 可能是 null）+ 同作者 + 同日期：Word 一次替换的 del/ins 就是这个形状 */
function runKey(change: FolioReviewChange): string {
  return `${change.blockId ?? ""}\u0000${change.author}\u0000${change.date ?? ""}`;
}

/**
 * @param groups 本会话里 agent 写进去的改动（`applyDocxEdit` 的返回值，按时间先后）
 * @param changes 引擎此刻的修订清单（`getTrackedChanges()`）
 */
export function buildReviewRows(
  groups: readonly DocxEditGroup[],
  changes: readonly FolioReviewChange[],
): DocxChangeRow[] {
  const byId = new Map<number, FolioReviewChange>();
  for (const change of changes) byId.set(change.id, change);
  const consumed = new Set<number>();
  const rows: DocxChangeRow[] = [];

  // ① 我们自己写的：一行一次 op
  for (const group of groups) {
    const ids = liveIds(group.revisionIds, byId);
    if (ids.length === 0) continue;
    for (const id of ids) consumed.add(id);
    const first = byId.get(ids[0] as number);
    rows.push({
      key: `op:${group.id}:${ids.join(",")}`,
      revisionIds: ids,
      author: first?.author ?? "",
      blockId: group.blockId === "" ? null : group.blockId,
      before: group.before,
      after: group.after,
      kind: kindOf(group.before, group.after),
      date: first?.date ?? null,
      ours: true,
      reanchored: group.reanchored,
    });
  }

  // ② 剩下的：按「同段同作者同时刻」的连续段折叠
  const rest = changes.filter((change) => !consumed.has(change.id));
  for (let i = 0; i < rest.length; ) {
    const head = rest[i] as FolioReviewChange;
    const key = runKey(head);
    const run: FolioReviewChange[] = [];
    while (i < rest.length && runKey(rest[i] as FolioReviewChange) === key) {
      run.push(rest[i] as FolioReviewChange);
      i += 1;
    }
    const deletions = run.filter(isDelete);
    const insertions = run.filter(isInsert);
    const others = run.filter((change) => !isDelete(change) && !isInsert(change));
    // 一次替换：一条删除 + 一条插入（Word / folio 写出来的形状）
    if (others.length === 0 && deletions.length === 1 && insertions.length === 1) {
      const del = deletions[0] as FolioReviewChange;
      const ins = insertions[0] as FolioReviewChange;
      rows.push({
        key: `pair:${del.id}:${ins.id}`,
        revisionIds: [del.id, ins.id],
        author: head.author,
        blockId: head.blockId,
        before: del.text,
        after: ins.text,
        kind: "replace",
        date: head.date,
        ours: false,
        reanchored: false,
      });
      continue;
    }
    for (const change of run) {
      const insert = isInsert(change);
      const remove = isDelete(change);
      rows.push({
        key: `rev:${change.id}`,
        revisionIds: [change.id],
        author: change.author,
        blockId: change.blockId,
        before: remove ? change.text : "",
        after: insert ? change.text : "",
        kind: insert ? "insert" : remove ? "delete" : "other",
        date: change.date,
        ours: false,
        reanchored: false,
      });
    }
  }
  return mergeChainedRows(rows);
}

/**
 * 两行是不是「同一处的连续两次改动」：后一行的旧文正好等于前一行的新文。
 *
 * 为什么必须合：同一句先 A→B 再 B→C 时，两条修订都还待裁决，用户看到的是
 * 「A→B」「B→C」两条——可 B 这个中间态从没被接受过，两条并列在逻辑上是自相矛盾
 * （评审 P2）。合起来才是用户心里那件事：把 A 改成 C。
 */
function chains(head: DocxChangeRow, next: DocxChangeRow): boolean {
  return (
    head.kind === "replace" &&
    next.kind === "replace" &&
    head.blockId !== null &&
    head.blockId === next.blockId &&
    head.author === next.author &&
    head.after !== "" &&
    next.before !== "" &&
    head.after === next.before &&
    // A→B→A 这种「又改回去」不并成 A→A（那样一行什么也没说，还挡着用户逐条撤）
    head.before !== next.after
  );
}

/**
 * 链式合并：**裁决单位仍是 revisionIds**（这里只是把几组的 id 并起来），一行从最早的
 * 旧文到最新的新文。
 *
 * 只并**连续相邻**的行：中间夹了别的改动（另一个块、另一处）就断开——那条链已经
 * 不是「同一处改了两次」。已经裁决掉的那半条不会在这里：`buildReviewRows` 先按
 * 「文档里还在的 id」过滤，接受过的组整行消失，剩下的那条自然不与他人相链。
 *
 * 合并后接受 = 整段落到最后的新文；拒绝 = 回到最早的旧文（中间态 B 的插入与删除
 * 一起被撤，净效果就是 A）。
 */
export function mergeChainedRows(rows: readonly DocxChangeRow[]): DocxChangeRow[] {
  const out: DocxChangeRow[] = [];
  for (const row of rows) {
    const head = out.length === 0 ? undefined : out[out.length - 1];
    if (head === undefined || !chains(head, row)) {
      out.push({ ...row, revisionIds: [...row.revisionIds] });
      continue;
    }
    const revisionIds = [...head.revisionIds];
    for (const id of row.revisionIds) if (!revisionIds.includes(id)) revisionIds.push(id);
    out[out.length - 1] = {
      ...head,
      key: `${head.key}+${row.key}`,
      revisionIds,
      after: row.after,
      ours: head.ours && row.ours,
      reanchored: head.reanchored || row.reanchored,
    };
  }
  return out;
}

/**
 * 这一行的文字能不能自己说明改了什么。字太少（「8 → 5」这种）时说得再准也没用——
 * 用户看不出是哪一处，得补段号。
 */
export function rowNeedsContext(row: DocxChangeRow): boolean {
  const chars = (text: string): number => Array.from(text.trim()).length;
  return chars(row.before) + chars(row.after) <= 6;
}

const clip = (text: string, max = 40): string => {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max).join("")}…`;
};

/**
 * 一行的短描述（「把 A 改成 B」/「插入 X」/「删除 Y」），UI 与回执共用。
 *
 * `ordinal`（第几段，0 = 不知道）只用来补上下文：短到看不出位置的改动写成
 * 「第 12 段 · 「8」→「5」」；连段号也没有就明说「改动范围未知」，别只丢两个数字。
 */
export function describeRow(row: DocxChangeRow, ordinal = 0): string {
  const core =
    row.kind === "replace"
      ? `${clip(row.before)} → ${clip(row.after)}`
      : row.kind === "insert"
        ? `+ ${clip(row.after)}`
        : row.kind === "delete"
          ? `- ${clip(row.before)}`
          : clip(row.before !== "" ? row.before : row.after);
  if (!rowNeedsContext(row)) return core;
  const where = ordinal > 0 ? `第 ${ordinal} 段 · ` : "";
  const quotes = row.kind === "insert" ? `新增「${clip(row.after)}」` : row.kind === "delete" ? `删除「${clip(row.before)}」` : `「${clip(row.before)}」→「${clip(row.after)}」`;
  return `${where}${quotes}${ordinal > 0 ? "" : "（改动范围未知）"}`;
}
