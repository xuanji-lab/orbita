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
  return rows;
}

/** 一行的短描述（「把 A 改成 B」/「插入 X」/「删除 Y」），UI 与回执共用 */
export function describeRow(row: DocxChangeRow): string {
  const clip = (text: string, max = 40): string => {
    const chars = Array.from(text.replace(/\s+/g, " ").trim());
    return chars.length <= max ? chars.join("") : `${chars.slice(0, max).join("")}…`;
  };
  if (row.kind === "replace") return `${clip(row.before)} → ${clip(row.after)}`;
  if (row.kind === "insert") return `+ ${clip(row.after)}`;
  if (row.kind === "delete") return `- ${clip(row.before)}`;
  return clip(row.before !== "" ? row.before : row.after);
}
