import { useRef, useState } from "react";
import { Icon } from "../../shell/Icon";
import { IconButton } from "../../shell/IconButton";
import { useT } from "../../locale.ts";
import { formatTokens } from "../../utils/format-tokens.ts";
import { formatCost } from "../settings/price-chart-model.ts";
import { useDictation } from "../voice/useDictation.ts";
import { DictationStatus } from "../voice/DictationStatus.tsx";
import type { WrapupDraft, WrapupEntry, WrapupPlan, WrapupReviseResult } from "@shared/wrapup";
import { wrapupTokenTotal } from "../../../../shared/wrapup-scan.ts";
import {
  addEntry,
  confirmCounts,
  editTitle,
  entryTotals,
  moveEntry,
  removeEntry,
  type WrapupGroup,
} from "./wrapup-card-model.ts";

/**
 * 收尾确认卡（原型 8「收尾卡片」方案 A）：点「完成」后家务活模型回看会话，这里列出**做完的事**
 * （每件占第几轮、哪个型号、多少 token、≈ 官方价花费）与**留下的事**（进遗留清单）。
 *
 * - 直接改：点标题行内改（回车保存、Esc 放弃）；悬停一行，行尾出挪动（两组之间）与删除；
 *   每组底部加一项；「第 x–y 轮」点了跳回对话那一段。
 * - 跟它说：底部反馈条打字或按麦克风口述（复用输入卡的听写），发出后家务活模型拿「当前清单 +
 *   这句话」改清单；改的时候清单变淡、不可点；改好后改过的行挂小标签，顶部一行说改了什么，可撤回。
 *   这句话不进对话、不进意图系统、不进任务账本（主进程一次独立小调用）。
 * - 确认：做完的事每件 = 价格图里的一个任务；留下的事进遗留清单。取消两段式（收尾的意愿已经
 *   表达了，一键退回误触代价太高），与上一版一致。
 *
 * 位置与配方同上一版：inline 浮层挂在输入卡上方（与审批条同位），不霸屏、不藏输入框。
 */
export function WrapupCard(props: {
  plan: WrapupPlan;
  draft: WrapupDraft;
  /** 型号显示名（与模型菜单同一套） */
  nameOf: (modelId: string) => string;
  onConfirm: (draft: WrapupDraft) => void;
  onCancel: () => void;
  onRevise: (draft: WrapupDraft, feedback: string) => Promise<WrapupReviseResult>;
  /** 跳回第 n 轮那条用户消息；undefined = 不可跳 */
  onJumpTurn?: (userId: string) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<WrapupDraft>(props.draft);
  /** 上一次反馈改写之前的清单（撤回用）与改写说明；null = 没有可撤回的改写 */
  const [applied, setApplied] = useState<{ before: WrapupDraft; summary: string } | null>(null);
  /** 正在改：用户说的那句话 */
  const [revising, setRevising] = useState<string | null>(null);
  const [reviseError, setReviseError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ group: WrapupGroup; index: number; value: string } | null>(null);
  const [adding, setAdding] = useState<{ group: WrapupGroup; value: string } | null>(null);
  const [cancelArmed, setCancelArmed] = useState(false);
  /**
   * 收起：点「第 x–y 轮」跳回对话时，卡片收成一行，把聊天面让出来看那一段（卡片展开时
   * 占掉输入卡上方的大半，留给对话的只剩几十像素——真机 800 高的窗口实测 50px）。点「展开清单」回来，
   * 编辑状态都在。
   */
  const [collapsed, setCollapsed] = useState(false);
  const [feedback, setFeedback] = useState("");
  const feedbackRef = useRef<HTMLTextAreaElement | null>(null);
  const dictation = useDictation({ value: feedback, onChange: setFeedback, textareaRef: feedbackRef });
  const dictating = dictation.phase !== "idle";
  const busy = revising !== null;
  const counts = confirmCounts(draft);

  const send = () => {
    const said = feedback.trim();
    if (said === "" || busy || dictating) return;
    const before = draft;
    setRevising(said);
    setReviseError(null);
    void props.onRevise(before, said).then((result) => {
      setRevising(null);
      if (!result.ok) {
        setReviseError(result.error === "unreadable" ? t.carryover.reviseUnreadable : t.carryover.reviseFailed(result.error));
        return;
      }
      setDraft(result.draft);
      setApplied({ before, summary: result.summary });
      setFeedback("");
    });
  };

  const commitEdit = () => {
    if (editing === null) return;
    setDraft((prev) => editTitle(prev, editing.group, editing.index, editing.value));
    setEditing(null);
  };

  const commitAdd = () => {
    if (adding === null) return;
    setDraft((prev) => addEntry(prev, adding.group, adding.value));
    setAdding(null);
  };

  const row = (group: WrapupGroup, entry: WrapupEntry, index: number) => {
    const isEditing = editing !== null && editing.group === group && editing.index === index;
    const totals = group === "done" ? entryTotals(props.plan.turns, entry) : null;
    const turns = entry.turns;
    const firstTurn = turns === null ? undefined : props.plan.turns.find((turn) => turn.n === turns[0]);
    return (
      <div key={`${group}-${index}`} className="wrapup-row" data-group={group}>
        <span className="wrapup-lead">
          <Icon name={group === "done" ? "circle-check" : "circle-dashed"} size={14} />
        </span>
        <div style={{ minWidth: 0 }}>
          {isEditing ? (
            <input
              autoFocus
              className="wrapup-edit"
              value={editing.value}
              onChange={(event) => setEditing({ ...editing, value: event.target.value })}
              onBlur={commitEdit}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitEdit();
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setEditing(null);
                }
              }}
            />
          ) : (
            <div className="wrapup-title">
              <button
                type="button"
                className="wrapup-title-btn"
                title={t.carryover.clickToEdit}
                onClick={() => setEditing({ group, index, value: entry.title })}
              >
                {entry.title}
              </button>
              <span aria-hidden className="wrapup-pencil">
                <Icon name="pencil-line" size={12} />
              </span>
              {entry.change !== undefined && <span className="wrapup-tag">{t.carryover.change[entry.change]}</span>}
            </div>
          )}
          {group === "done" ? (
            <div className="wrapup-meta">
              {turns === null ? (
                <span>{t.carryover.noTurns}</span>
              ) : (
                <button
                  type="button"
                  className="wrapup-turns"
                  title={t.carryover.jumpToTurns}
                  disabled={firstTurn === undefined || props.onJumpTurn === undefined}
                  onClick={() => {
                    if (firstTurn === undefined) return;
                    setCollapsed(true);
                    // 等收起后的布局落定再滚：聊天面要先长高，滚动的目标位置才算得对
                    requestAnimationFrame(() => requestAnimationFrame(() => props.onJumpTurn?.(firstTurn.userId)));
                  }}
                >
                  {t.carryover.turns(turns[0], turns[1])}
                </button>
              )}
              {totals !== null && totals.modelId !== null && (
                <>
                  <span>{props.nameOf(totals.modelId)}</span>
                  <span className="wrapup-mono">{formatTokens(wrapupTokenTotal(totals.tokens))} token</span>
                  {totals.officialCost !== null && totals.officialCost > 0 && (
                    <span className="wrapup-mono">≈ {formatCost(totals.officialCost)}</span>
                  )}
                </>
              )}
            </div>
          ) : (
            entry.detail !== "" && (
              <p className="wrapup-detail" title={entry.detail}>
                {entry.detail}
              </p>
            )
          )}
        </div>
        <span className="wrapup-trail">
          <IconButton
            label={group === "done" ? t.carryover.moveToLeft : t.carryover.moveToDone}
            size={26}
            onClick={() => setDraft((prev) => moveEntry(prev, group, index))}
          >
            <Icon name={group === "done" ? "arrow-down" : "arrow-up"} size={13} />
          </IconButton>
          <IconButton
            label={group === "done" ? t.carryover.removeDone : t.carryover.removeLeft}
            size={26}
            onClick={() => setDraft((prev) => removeEntry(prev, group, index))}
          >
            <Icon name="trash-2" size={13} />
          </IconButton>
        </span>
      </div>
    );
  };

  const addRow = (group: WrapupGroup) =>
    adding !== null && adding.group === group ? (
      <div className="wrapup-row" data-adding>
        <span className="wrapup-lead">
          <Icon name="plus" size={13} />
        </span>
        <input
          autoFocus
          className="wrapup-edit"
          placeholder={t.carryover.newItemPlaceholder}
          value={adding.value}
          onChange={(event) => setAdding({ group, value: event.target.value })}
          onBlur={commitAdd}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitAdd();
            if (event.key === "Escape") {
              event.stopPropagation();
              setAdding(null);
            }
          }}
        />
        <span />
      </div>
    ) : (
      <button type="button" className="wrapup-add" onClick={() => setAdding({ group, value: "" })}>
        <Icon name="plus" size={13} />
        {group === "done" ? t.carryover.addDone : t.carryover.addLeft}
      </button>
    );

  return (
    <section
      role="region"
      aria-label={t.carryover.wrapUp}
      className="glass-card glass-float wrapup-card"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || editing !== null || adding !== null || dictating) return;
        if (cancelArmed) props.onCancel();
        else setCancelArmed(true);
      }}
    >
      <div className="wrapup-head">
        <Icon name="list-todo" size={16} />
        <strong>{t.carryover.wrapUp}</strong>
        {collapsed && (
          <button type="button" className="wrapup-undo row-trailing" onClick={() => setCollapsed(false)}>
            <Icon name="chevron-up" size={12} />
            {t.carryover.expand}
          </button>
        )}
      </div>
      {!collapsed && <p className="wrapup-intro">{t.carryover.intro(counts.done, counts.left)}</p>}

      {!collapsed && (
        <>
      {revising !== null && (
        <>
          <div className="wrapup-said">
            <span className="wrapup-said-who">
              <Icon name="message-square" size={11} />
              {t.carryover.youSaid}
            </span>
            <span>{revising}</span>
          </div>
          <div className="wrapup-busy" role="status">
            <Icon name="loader-circle" size={13} spin />
            {t.carryover.revising}
          </div>
        </>
      )}
      {revising === null && applied !== null && (
        <div className="wrapup-applied">
          <Icon name="check" size={13} />
          <span style={{ minWidth: 0 }}>{t.carryover.revised(applied.summary)}</span>
          <button
            type="button"
            className="wrapup-undo row-trailing"
            onClick={() => {
              setDraft(applied.before);
              setApplied(null);
            }}
          >
            <Icon name="undo-2" size={12} />
            {t.carryover.undoRevise}
          </button>
        </div>
      )}
      {revising === null && reviseError !== null && (
        <div className="wrapup-applied" role="alert">
          <Icon name="triangle-alert" size={13} />
          <span style={{ minWidth: 0 }}>{reviseError}</span>
        </div>
      )}

      <div className={`wrapup-list scroll${busy ? " wrapup-busy-list" : ""}`} aria-busy={busy || undefined}>
        <div className="wrapup-group">
          <div className="wrapup-group-head">
            <Icon name="circle-check" size={13} />
            {t.carryover.doneGroup}
            <span className="wrapup-group-note">{t.carryover.doneGroupNote(draft.done.length)}</span>
          </div>
          {draft.done.map((entry, index) => row("done", entry, index))}
          {addRow("done")}
        </div>
        <div className="wrapup-sep" />
        <div className="wrapup-group">
          <div className="wrapup-group-head">
            <Icon name="list-todo" size={13} />
            {t.carryover.leftGroup}
            <span className="wrapup-group-note">{t.carryover.leftGroupNote(draft.left.length)}</span>
          </div>
          {draft.left.map((entry, index) => row("left", entry, index))}
          {addRow("left")}
        </div>
      </div>

      {(dictating || dictation.problem !== null) && (
        <DictationStatus phase={dictation.phase} problem={dictation.problem} provider={dictation.provider} />
      )}
      <div className="wrapup-feedback">
        <textarea
          ref={feedbackRef}
          rows={1}
          className="wrapup-feedback-input"
          placeholder={t.carryover.feedbackPlaceholder}
          aria-label={t.carryover.feedbackPlaceholder}
          value={feedback}
          readOnly={dictating}
          disabled={busy}
          onChange={(event) => {
            if (dictation.problem !== null) dictation.clearProblem();
            setFeedback(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (dictating) dictation.finish();
            else send();
          }}
        />
        <IconButton
          label={dictating ? t.voice.dictateFinish : t.voice.dictate}
          size={28}
          active={dictation.phase === "listening"}
          disabled={busy || dictation.phase === "finishing"}
          onClick={dictation.toggle}
        >
          {dictation.phase === "connecting" || dictation.phase === "finishing" ? (
            <Icon name="loader-circle" size={14} spin />
          ) : (
            <Icon name="mic" size={14} className={dictation.phase === "listening" ? "orbita-breath" : undefined} />
          )}
        </IconButton>
        <button
          type="button"
          className="wrapup-send"
          data-ready={feedback.trim() !== "" && !busy && !dictating ? "" : undefined}
          aria-label={t.carryover.feedbackSend}
          title={t.carryover.feedbackSend}
          disabled={feedback.trim() === "" || busy || dictating}
          onClick={send}
        >
          <Icon name="arrow-up" size={14} />
        </button>
      </div>

        </>
      )}

      <div className="wrapup-foot">
        {cancelArmed ? (
          <>
            <button type="button" className="wrapup-btn" onClick={props.onCancel}>
              {t.carryover.discardAndDone}
            </button>
            <button type="button" className="wrapup-btn" onClick={() => setCancelArmed(false)}>
              {t.carryover.keepOpen}
            </button>
          </>
        ) : (
          <button type="button" className="wrapup-btn" onClick={() => setCancelArmed(true)}>
            {t.common.cancel}
          </button>
        )}
        <button
          type="button"
          className="wrapup-btn wrapup-primary row-trailing"
          disabled={busy}
          onClick={() => props.onConfirm(draft)}
        >
          {t.carryover.confirm(counts.done, counts.left)}
        </button>
      </div>
    </section>
  );
}
