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
  /**
   * 改字时带上用户写的那段话（2026-10-14 裁决：改掉的大字陈述就是用户的表态，
   * statement 与 edited 同文）。intent-lab 的 FeedbackAnswer 今天只认
   * askId / verdict / edited（多余字段被它的解析剥掉），这个字段先随决策对象
   * 走——服务端哪天想以用户措辞覆盖它存的「问时的陈述句」，不用再改客户端。
   */
  statement?: string;
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
 *
 * 与改字的不变量（2026-10-14：改字 = 表态，同「对」）：离开「对」时把改字一起
 * 撤掉——点「不对」或取消「对」，这条回到原始陈述（edited 清空）。改过的字与
 * 「不对 / 不表态」自相矛盾，以最后一次表态为准。
 */
export function toggleConfirmVerdict(
  rows: readonly ConfirmRowState[],
  askId: string,
  next: "yes" | "no",
): ConfirmRowState[] {
  return rows.map((row) => {
    if (row.askId !== askId) return row;
    if (next === "no") return { ...row, verdict: row.verdict === "no" ? "skip" : "no", edited: null };
    // 点「对」：选中它（改字保留）；再点已选中的「对」：回到不表态，改字一并撤
    return row.verdict === "yes" ? { ...row, verdict: "skip", edited: null } : { ...row, verdict: "yes" };
  });
}

/**
 * 行内改字（矫正）：记录当前编辑文本；是否真的算「改过」在组装 answers 时判。
 * 改字本身就是表态（2026-10-14 用户裁决：用户改完的那句话就是他确认的说法）——
 * 只要动了字，这一行按「对」计。
 */
export function editConfirmRow(
  rows: readonly ConfirmRowState[],
  askId: string,
  text: string,
): ConfirmRowState[] {
  return rows.map((row) => (row.askId === askId ? { ...row, edited: text, verdict: "yes" } : row));
}

/**
 * 「确认并回答」的 answers：选了对 → yes，不对 → no，没选 → skip；
 * 改过字的（trim 后与原陈述不同、且不是空串）强制按「对」计，并把用户的说法
 * 同时填进 statement 与 edited——写回 intent-lab 的「理由」就是用户说法
 * （服务端注入块连接句取 edited ?? statement）。
 */
export function buildConfirmAnswers(
  rows: readonly ConfirmRowState[],
  ask: readonly IntentAskView[],
): IntentConfirmAnswer[] {
  return rows.map((row) => {
    const source = ask.find((item) => item.askId === row.askId);
    const original = source?.statement ?? "";
    const edited =
      row.edited !== null && row.edited.trim() !== "" && row.edited.trim() !== original.trim()
        ? row.edited.trim()
        : undefined;
    return {
      askId: row.askId,
      verdict: edited !== undefined ? "yes" : row.verdict,
      ...(edited === undefined ? {} : { edited, statement: edited }),
    };
  });
}

/** 「不确认，直接回答」的 answers：全 skip（note 仍由调用方带上）。 */
export function buildSkipAllAnswers(ask: readonly IntentAskView[]): IntentConfirmAnswer[] {
  return ask.map((item) => ({ askId: item.askId, verdict: "skip" as const }));
}

/**
 * 确认卡大字陈述的显示文本（2026-10-14 逐条版）：卡上只留「如果对，这次回答会」
 * 这一句——用 S3 写的 prediction，剥掉开头的「回答会」（标签里已有这四个字）。
 * join 不到边（/edges 拉失败）时调用方退回 ask.statement，不走这里。
 */
export function predictionStatement(prediction: string): string {
  return prediction.replace(/^\s*回答会[，,：:]?\s*/, "");
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
