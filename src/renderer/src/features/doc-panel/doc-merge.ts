/**
 * 文档的最小差异与三向合并（纯函数，无 DOM）。
 *
 * 场景：用户在编辑器里打字（local），agent 同时用 edit / write 改了盘上的文件（disk），
 * 两边都是从上次同步的版本（base）出发。要的结果：**两边的改动都在，用户的光标与未落盘的
 * 输入原样保住，只有 agent 动过的地方变**——而不是整份刷新。
 *
 * 做法（OT 的最小形态）：
 *   userChanges = diff(base → local)，diskChanges = diff(base → disk)
 *   mapped = diskChanges 越过 userChanges（`ChangeSet.map`），再作用到 local 上
 * 差异只在合并那一刻算（每次 agent 写入一次），不在每次按键上维护——打字路径零开销。
 *
 * `diffToChanges` 先剥公共前后缀，中间用行级 diff，再对每个替换块剥字符级前后缀，
 * 所以「agent 在第二段后面加一段」得到的就是一处纯插入。
 */
import { ChangeSet, Text } from "@codemirror/state";
import { diffLines } from "diff";

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/** 行级 diff 的体量闸：两边中间段都不超过它才逐行比，否则整段当一处替换（不为 5 万字重写卡主线程） */
const LINE_DIFF_MAX_CHARS = 200_000;

function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  // 不把一个代理对（emoji）劈成两半
  if (i > 0 && i < max + 1 && isHighSurrogate(a.charCodeAt(i - 1))) i -= 1;
  return i;
}

function commonSuffix(a: string, b: string, limit: number): number {
  const max = Math.min(a.length, b.length, limit);
  let i = 0;
  while (i < max && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i += 1;
  if (i > 0 && isLowSurrogate(a.charCodeAt(a.length - i))) i -= 1;
  return i;
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** old → new 的一组不重叠的替换（坐标都在 old 里，升序）。相同返回空数组 */
export function diffToChanges(oldText: string, newText: string): TextChange[] {
  if (oldText === newText) return [];
  const prefix = commonPrefix(oldText, newText);
  const suffix = commonSuffix(oldText, newText, Math.min(oldText.length, newText.length) - prefix);
  const oldMid = oldText.slice(prefix, oldText.length - suffix);
  const newMid = newText.slice(prefix, newText.length - suffix);
  if (oldMid === "" || newMid === "" || oldMid.length > LINE_DIFF_MAX_CHARS || newMid.length > LINE_DIFF_MAX_CHARS) {
    return [{ from: prefix, to: oldText.length - suffix, insert: newMid }];
  }
  const changes: TextChange[] = [];
  let oldPos = prefix;
  let pendingFrom = -1;
  let removed = "";
  let added = "";
  const flush = (): void => {
    if (pendingFrom === -1) return;
    // 替换块里再剥一层字符级公共前后缀：「改了一个字」不要变成「换了一整行」
    const p = commonPrefix(removed, added);
    const s = commonSuffix(removed, added, Math.min(removed.length, added.length) - p);
    const from = pendingFrom + p;
    const to = pendingFrom + removed.length - s;
    const insert = added.slice(p, added.length - s);
    if (to > from || insert !== "") changes.push({ from, to, insert });
    pendingFrom = -1;
    removed = "";
    added = "";
  };
  for (const part of diffLines(oldMid, newMid)) {
    if (part.added) {
      if (pendingFrom === -1) pendingFrom = oldPos;
      added += part.value;
    } else if (part.removed) {
      if (pendingFrom === -1) pendingFrom = oldPos;
      removed += part.value;
      oldPos += part.value.length;
    } else {
      flush();
      oldPos += part.value.length;
    }
  }
  flush();
  return changes;
}

/** 把一组替换（坐标在 old 里）作为 ChangeSet；换行在 CM 里按行计，长度由 Text 决定 */
function toChangeSet(length: number, changes: readonly TextChange[]): ChangeSet {
  return ChangeSet.of(
    changes.map((change) => ({ from: change.from, to: change.to, insert: change.insert })),
    length,
  );
}

export interface MergeResult {
  /** 合并后的整份文本（= local 上叠 agent 的改动） */
  text: string;
  /** 新增 / 改动的区间（坐标在 `text` 里）：绿边标出来 */
  inserted: { from: number; to: number }[];
  /** 相对 local 的那几处替换（坐标在 local 里）：编辑器直接按它改，光标自动跟着映射 */
  changes: TextChange[];
}

export function merge3(base: string, local: string, disk: string): MergeResult {
  if (base === disk) return { text: local, inserted: [], changes: [] };
  if (base === local) {
    // 用户这边没动：盘上的就是答案。仍按 local → disk 的最小差异给出 changes / inserted
    return fromLocalTo(local, disk);
  }
  const user = toChangeSet(base.length, diffToChanges(base, local));
  const theirs = toChangeSet(base.length, diffToChanges(base, disk));
  const mapped = theirs.map(user);
  const merged = mapped.apply(Text.of(local.split("\n")));
  return collect(mapped, merged.toString());
}

function fromLocalTo(local: string, target: string): MergeResult {
  const set = toChangeSet(local.length, diffToChanges(local, target));
  return collect(set, target);
}

function collect(set: ChangeSet, text: string): MergeResult {
  const inserted: { from: number; to: number }[] = [];
  const changes: TextChange[] = [];
  set.iterChanges((fromA, toA, fromB, toB, insert) => {
    changes.push({ from: fromA, to: toA, insert: insert.toString() });
    if (toB > fromB) inserted.push({ from: fromB, to: toB });
  });
  return { text, inserted, changes };
}
