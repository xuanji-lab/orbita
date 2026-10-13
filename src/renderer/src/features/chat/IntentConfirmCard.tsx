import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import type { IntentAskView } from "../../../../shared/intent-recall.ts";
import {
  buildConfirmAnswers,
  buildSkipAllAnswers,
  confirmDraftDiffers,
  editConfirmRow,
  initialConfirmRows,
  toggleConfirmVerdict,
} from "../../../../shared/intent-confirm.ts";
import type { IntentConfirmDecision, IntentConfirmDraft } from "../../../../shared/intent-confirm.ts";

/**
 * 回答前确认卡（Tier B 第二批）—— recall 判定「有待确认的连接」后浮在输入框
 * 上方，与 ApprovalBar / CarryoverChecklist 同位同配方（glass-card glass-float）：
 * 比聊天面高一层、要求一个回答才继续，但不霸屏、不抢焦点、不藏输入框。
 *
 * 每行三态：对 / 不对 / 不表态（默认不表态；点已选中的回到不表态——示意图的
 * 裁决：默认全确认会把没看过的假设顺手放行）。陈述可行内改字（= 矫正，写回
 * intent-lab 的是用户的说法）；「不对」加删除线但照样可编辑。底部一行补背景
 * （note）。两个出口都继续回答：「不确认，直接回答」全 skip、「确认并回答」
 * 按行态。**不做 Esc**——两个出口都是继续回答，没有「取消」语义。
 *
 * 样式对照 research-vault …/0921/orbita-confirm-card-mockup.html（与
 * CarryoverChecklist 同一个样式配方，不改它本身）。
 */
export function IntentConfirmCard(props: {
  ask: IntentAskView[];
  requestId: string;
  /** 未提交草稿（切会话 / 刷新恢复）；null = 没编辑过 */
  draft: IntentConfirmDraft | null;
  onDraftChange: (draft: IntentConfirmDraft) => void;
  onAnswer: (requestId: string, decision: IntentConfirmDecision) => void;
}) {
  const t = useT();
  const [rows, setRows] = useState(() =>
    props.draft !== null && props.draft.requestId === props.requestId ? props.draft.rows : initialConfirmRows(props.ask),
  );
  const [note, setNote] = useState(
    props.draft !== null && props.draft.requestId === props.requestId ? props.draft.note : "",
  );
  /**
   * P0（2026-09-27 00:36 真机：确认卡「对 / 不对」没反应，138 秒 1,552 次
   * Maximum update depth，三次点击全丢、发出去全是 skip）：上层回调身份不稳
   * （engine 未 memo，每次渲染新函数），旧的上抛 effect 把 onDraftChange 放在
   * 依赖里——每渲染重跑 → setStates → 再渲染 → 新回调 → 死循环；用户点击的
   * setRows 在循环里被草稿同步冲掉。两个护栏把数据流改成单向：
   * - 上抛只依赖内容（rows / note / requestId），回调经 ref 取最新——回调身份
   *   变化不再触发上抛；
   * - 下行同步只在「同卡、内容真的不同、且用户还没动过」时重置（dirty 后本地
   *   是真源）——IPC 克隆往返（引用必变、内容相同）不再重置。
   */
  const dirtyRef = useRef(false);
  const onDraftChangeRef = useRef(props.onDraftChange);
  onDraftChangeRef.current = props.onDraftChange;
  useEffect(() => {
    onDraftChangeRef.current({ requestId: props.requestId, rows, note });
  }, [rows, note, props.requestId]);
  // 恢复的草稿晚于挂载到达（拉取是异步的）：同卡、内容不同、用户未动过才同步
  useEffect(() => {
    if (
      !dirtyRef.current &&
      props.draft !== null &&
      confirmDraftDiffers(props.draft, props.requestId, rows, note)
    ) {
      setRows(props.draft.rows);
      setNote(props.draft.note);
    }
  }, [props.draft, props.requestId, rows, note]);

  const answered = useMemo(() => buildConfirmAnswers(rows, props.ask), [rows, props.ask]);

  const submit = (action: "confirm" | "skip-all"): void => {
    const trimmed = note.trim();
    props.onAnswer(props.requestId, {
      action,
      answers: action === "confirm" ? answered : buildSkipAllAnswers(props.ask),
      note: trimmed,
    });
  };

  return (
    <section
      role="region"
      aria-label={t.chat.recall.confirm.title}
      className="glass-card glass-float"
      style={{
        display: "grid",
        gap: "var(--space-3)",
        padding: "var(--space-4)",
        color: "var(--color-text-primary)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <Icon name="circle-help" size={16} style={{ color: "var(--color-text-secondary)" }} />
        <strong style={{ fontSize: "var(--font-size-body)", fontWeight: "var(--weight-bold)" }}>
          {t.chat.recall.confirm.title}
        </strong>
      </div>
      <p
        style={{
          margin: 0,
          fontSize: "var(--font-size-caption)",
          lineHeight: "var(--line-height-caption)",
          color: "var(--color-text-secondary)",
        }}
      >
        {t.chat.recall.confirm.intro}
      </p>

      <div
        className="scroll"
        style={{ minHeight: 0, maxHeight: 264, display: "grid", gap: "var(--space-1)", alignContent: "start" }}
      >
        {props.ask.map((item, index) => {
          const row = rows[index];
          if (row === undefined) return null;
          return (
            <div
              key={item.askId}
              className={row.verdict === "no" ? "confirm-row confirm-row-no" : "confirm-row"}
              style={{
                display: "grid",
                gridTemplateColumns: "auto minmax(0, 1fr)",
                gap: "var(--space-2)",
                alignItems: "start",
                padding: "var(--space-2)",
                borderRadius: "var(--radius-sm)",
              }}
            >
              <span
                role="group"
                aria-label={item.statement}
                style={{
                  display: "inline-flex",
                  borderRadius: "var(--radius-md)",
                  background: "var(--color-bg-muted)",
                  padding: 2,
                  gap: 2,
                  marginTop: 1,
                }}
              >
                {(["yes", "no"] as const).map((verdict) => {
                  // 选中态的可见性（审核第四轮 2）：颜色之外再加图标信号（对=check、
                  // 不对=x）+ 实底——色/底都在 CSS 类里，inline style 只管形状，
                  // 不然 inline 的 color/background 会把 CSS 盖掉（上一版就是这么
                  // 变成「看不出选了哪个」的）
                  const selected = row.verdict === verdict;
                  return (
                    <button
                      key={verdict}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        dirtyRef.current = true;
                        setRows((prev) => toggleConfirmVerdict(prev, item.askId, verdict));
                      }}
                      className={
                        selected
                          ? verdict === "yes"
                            ? "confirm-verdict on yes"
                            : "confirm-verdict on no"
                          : "confirm-verdict"
                      }
                      style={{
                        border: 0,
                        borderRadius: "var(--radius-sm)",
                        height: 22,
                        minWidth: 28,
                        padding: "0 6px",
                        fontFamily: "var(--font-family-base)",
                        fontSize: "var(--font-size-micro)",
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 3,
                      }}
                    >
                      {selected && <Icon name={verdict === "yes" ? "circle-check" : "x"} size={10} />}
                      {verdict === "yes" ? t.chat.recall.confirm.verdictYes : t.chat.recall.confirm.verdictNo}
                    </button>
                  );
                })}
              </span>
              <div style={{ minWidth: 0 }}>
                {/* 第一行：岗名小标签 + 陈述。标签在编辑区外（改字改不到它）；
                    小字（时间 · 会话 · 摘句）固定放第二行——flex 只包这一行，
                    不然 quote 空时短小字会并到行尾（审核第四轮 4） */}
                <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-1)", flexWrap: "wrap", minWidth: 0 }}>
                <span
                  style={{
                    flex: "0 0 auto",
                    fontSize: "var(--font-size-micro)",
                    color: "var(--color-text-secondary)",
                    background: "var(--color-bg-muted)",
                    borderRadius: "var(--radius-xs)",
                    padding: "0 5px",
                    fontFamily: "var(--font-family-mono)",
                  }}
                >
                  {item.slot}
                </span>
                {/* 行内改字 = 矫正：非受控 contenteditable（挂载时写一次初值，
                    onInput 只记账）——React 重渲染不碰 children，光标不丢 */}
                <div
                  contentEditable
                  suppressContentEditableWarning
                  role="textbox"
                  aria-label={t.chat.recall.confirm.statementLabel}
                  ref={(node) => {
                    // 挂载时写一次初值，之后 React 不碰（无 children），光标不丢；
                    // dataset 标记防 inline ref 每次渲染重写
                    if (node !== null && node.dataset["seeded"] !== "1") {
                      node.textContent = item.statement;
                      node.dataset["seeded"] = "1";
                    }
                  }}
                  onInput={(event) => {
                    // 同步取文本再 setState：updater 被 React 延后调用时
                    // event.currentTarget 已是 null（审核实测白屏的根因）
                    const text = event.currentTarget.textContent ?? "";
                    dirtyRef.current = true;
                    setRows((prev) => editConfirmRow(prev, item.askId, text));
                  }}
                  className="confirm-statement"
                  style={{
                    flex: "1 1 auto",
                    fontWeight: "var(--weight-medium)",
                    fontSize: "var(--font-size-control)",
                    lineHeight: "var(--line-height-control)",
                    minWidth: 0,
                    outline: "none",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                />
                </div>
                <p
                  style={{
                    margin: "2px 0 0",
                    fontSize: "var(--font-size-micro)",
                    lineHeight: "var(--line-height-caption)",
                    color: "var(--color-text-tertiary)",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  {item.when} · {item.title}
                  {item.quote === "" ? null : (
                    <>
                      {" · "}
                      <span style={{ fontStyle: "italic" }}>“{item.quote}”</span>
                    </>
                  )}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      <input
        value={note}
        placeholder={t.chat.recall.confirm.notePlaceholder}
        aria-label={t.chat.recall.confirm.noteLabel}
        onChange={(event) => {
          dirtyRef.current = true;
          setNote(event.target.value);
        }}
        style={{
          height: 28,
          padding: "0 var(--space-3)",
          border: 0,
          borderRadius: "var(--radius-md)",
          background: "var(--color-bg-muted)",
          color: "var(--color-text-primary)",
          fontFamily: "var(--font-family-base)",
          fontSize: "var(--font-size-control)",
          outline: "none",
          boxShadow: "var(--focus-ring)",
        }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", paddingTop: "var(--space-1)" }}>
        <button type="button" onClick={() => submit("skip-all")} style={{ ...footerButton, color: "var(--color-text-secondary)" }}>
          {t.chat.recall.confirm.answerWithoutConfirming}
        </button>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => submit("confirm")}
          style={{
            ...footerButton,
            background: "var(--color-accent)",
            color: "var(--color-accent-fg)",
            fontWeight: "var(--weight-semibold)",
          }}
        >
          {t.chat.recall.confirm.confirmAndAnswer}
        </button>
      </div>
    </section>
  );
}

const footerButton: React.CSSProperties = {
  height: 28,
  padding: "0 12px",
  border: "1px solid var(--color-border-subtle)",
  borderRadius: "var(--radius-md)",
  background: "transparent",
  fontFamily: "var(--font-family-base)",
  fontSize: "var(--font-size-control)",
  cursor: "pointer",
  transition: "var(--transition-hover)",
};
