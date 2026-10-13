/**
 * 意图系统确认卡（Tier B 第二批）的共享纯核 —— 类型与行状态机。
 *
 * 回答前确认：recall 的 done.needsFeedback 为 true 时，runtime 把 review.ask 发给
 * renderer 弹确认卡（对 / 不对 / 不表态，可改字），应答回来后 POST /feedback 换取
 * 最终注入块再发给模型。本文件是三态行、改字、两个按钮各自 answers 的可测核，
 * renderer 的组件与 runtime 的应答解析共用它。
 *
 * 纯模块：不 import electron、不 import pi。
 */
import type { IntentAskView } from "./intent-recall.ts";

/** 一条确认项的用户表态（契约 FeedbackRequest.answers 的一项）。 */
export interface IntentConfirmAnswer {
  askId: string;
  verdict: "yes" | "no" | "skip";
  /** 改字 = 矫正：与原陈述不同的说法。可与任何 verdict 并存（契约原文）。 */
  edited?: string;
}

/** 确认卡的未提交草稿（第五轮 2c）：表态、改字与补充背景——刷新 / 切会话不丢。 */
export interface IntentConfirmDraft {
  /** 草稿属于哪张卡（intentAsk 的 requestId）——新卡不带旧草稿 */
  requestId: string;
  rows: ConfirmRowState[];
  note: string;
}

/** renderer 一次确认的完整决定：按了哪个按钮 + 每条的表态 + 补的一句背景。 */
export interface IntentConfirmDecision {
  /** confirm = 「确认并回答」；skip-all = 「不确认，直接回答」（answers 全 skip，note 仍带上） */
  action: "confirm" | "skip-all";
  answers: IntentConfirmAnswer[];
  /** 用户补的一句背景；没写就是空串（契约的 note 可选，发时省略） */
  note: string;
}

/** 确认卡一行 的显示状态：三态默认 skip（不表态）。 */
export interface ConfirmRowState {
  askId: string;
  verdict: "yes" | "no" | "skip";
  /** 行内编辑中的文本；null = 没改过（显示原陈述）。保存时与原陈述不同才落 edited。 */
  edited: string | null;
}

/** 从 review.ask 建初始行：全部不表态、未改字（默认不表态是示意图的裁决——默认全确认会把没看过的假设顺手放行）。 */
export function initialConfirmRows(ask: readonly IntentAskView[]): ConfirmRowState[] {
  return ask.map((item) => ({ askId: item.askId, verdict: "skip", edited: null }));
}

/**
 * 三态切换：点「对 / 不对」选中它；**点已选中的那个回到不表态**（示意图交互：
 * 再点一下取消选择）。只动目标行，其余引用不变。
 */
export function toggleConfirmVerdict(
  rows: readonly ConfirmRowState[],
  askId: string,
  next: "yes" | "no",
): ConfirmRowState[] {
  return rows.map((row) =>
    row.askId === askId ? { ...row, verdict: row.verdict === next ? "skip" : next } : row,
  );
}

/** 行内改字（矫正）：记录当前编辑文本；是否真的算「改过」在组装 answers 时判。 */
export function editConfirmRow(
  rows: readonly ConfirmRowState[],
  askId: string,
  text: string,
): ConfirmRowState[] {
  return rows.map((row) => (row.askId === askId ? { ...row, edited: text } : row));
}

/**
 * 「确认并回答」的 answers：选了对 → yes，不对 → no，没选 → skip；
 * 改过字的（trim 后与原陈述不同）带 edited——写回 intent-lab 的就是用户说法。
 */
export function buildConfirmAnswers(
  rows: readonly ConfirmRowState[],
  ask: readonly IntentAskView[],
): IntentConfirmAnswer[] {
  return rows.map((row) => {
    const source = ask.find((item) => item.askId === row.askId);
    const original = source?.statement ?? "";
    const edited = row.edited !== null && row.edited.trim() !== original.trim() ? row.edited.trim() : undefined;
    return { askId: row.askId, verdict: row.verdict, ...(edited === undefined ? {} : { edited }) };
  });
}

/** 「不确认，直接回答」的 answers：全 skip（note 仍由调用方带上）。 */
export function buildSkipAllAnswers(ask: readonly IntentAskView[]): IntentConfirmAnswer[] {
  return ask.map((item) => ({ askId: item.askId, verdict: "skip" as const }));
}


/**
 * 草稿内容是否与本地态真的不同（P0 2026-09-27：确认卡「对 / 不对」没反应）。
 * 只比内容（requestId、note、逐行的 verdict/edited），不比引用——草稿经
 * IPC / 槽层往返必是新对象，引用比较会把「内容相同」误判成变化，两个 effect
 * 互相触发成死循环（真机 138 秒 1,552 次 Maximum update depth，用户点击被刷掉）。
 * requestId 不匹配返回 false：不是这张卡的草稿不同步（换卡由 key 重挂载处理）。
 */
export function confirmDraftDiffers(
  draft: { requestId: string; rows: readonly ConfirmRowState[]; note: string },
  requestId: string,
  rows: readonly ConfirmRowState[],
  note: string,
): boolean {
  if (draft.requestId !== requestId) return false;
  if (draft.note !== note) return true;
  if (draft.rows.length !== rows.length) return true;
  for (let i = 0; i < rows.length; i += 1) {
    if (draft.rows[i]!.askId !== rows[i]!.askId) return true;
    if (draft.rows[i]!.verdict !== rows[i]!.verdict) return true;
    if ((draft.rows[i]!.edited ?? null) !== (rows[i]!.edited ?? null)) return true;
  }
  return false;
}
