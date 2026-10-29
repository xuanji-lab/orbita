import { useState } from "react";
import type { MemoryEntryType, MemoryEntryView } from "@shared/memory";
import { Icon, type IconName } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { formatDay } from "../settings/migration-groups.ts";
import { memoryUndoActions } from "./memory-view.ts";
import { mutateMemory } from "./useMemory.ts";
import "./memory.css";

/** 三类各自的图标：偏好 = 调节杆（你定的规矩）、经验 = 灯泡、事实 = 卷轴。 */
export const MEMORY_TYPE_ICON: Record<MemoryEntryType, IconName> = {
  preference: "sliders",
  insight: "lightbulb",
  fact: "scroll-text",
};

/**
 * 一条记忆。记忆库页与审查 › 记忆页签共用：
 * - 点正文展开：原话（出处那一轮的用户话）、「回到原文」、演变链，以及撤销入口；
 * - 悬停右上角出编辑 / 别再用 / 删除（删除要再点一次确认）；
 * - 不再使用 / 已过时的条目正文退成次要色，元信息里写明状态——颜色只是第二信号。
 *
 * 没有「待你确认」（2026-10-29 用户：「我不想去确认记忆，agent 应该自己有判断力吧」）：
 * agent 判断的结果直接生效，这里只负责让人看得出发生了什么、错了能一键撤——
 * - agent 在对话里按用户的话改写的条目，元信息带「agent 修订」；
 * - 顶掉了旧说法的条目（演变链里前一条已过时）给「恢复旧说法」；
 * - 自动记到所有工作区的条目给「只留在原工作区」。
 *
 * 写操作结果以服务回执为准：失败就地一句话；成功不用管，memoryChanged 会让列表重拉。
 */
export function MemoryEntryCard(props: {
  view: MemoryEntryView;
  /** 范围标签（记忆库「全部」视图里显示它在哪一层）；null = 不显示 */
  scopeName: string | null;
  /** 出处（会话标题 · 第几轮）要不要显示：审查页签按轮分好组了，不用再说 */
  showOrigin: boolean;
  /** 「回到原文」；undefined = 不给（会话已删 / 手动添加） */
  onJump?: (view: MemoryEntryView) => void;
}) {
  const t = useT();
  const { entry, token } = props.view;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const state = entry.status ?? "active";
  const evolution = props.view.evolution;
  const now = Date.now();

  const run = async (mutation: Parameters<typeof mutateMemory>[0]): Promise<boolean> => {
    setBusy(true);
    setProblem(null);
    const outcome = await mutateMemory(mutation);
    setBusy(false);
    if (!outcome.ok) setProblem(t.memory.failed(outcome.error));
    return outcome.ok;
  };

  const saveEdit = async (): Promise<void> => {
    if (editing === null) return;
    const text = editing.trim();
    if (text === "" || text === entry.text) {
      setEditing(null);
      return;
    }
    if (await run({ op: "edit", token, entryId: entry.id, text })) setEditing(null);
  };

  const jumpable = props.onJump !== undefined && entry.source !== "manual" && props.view.sessionTitle !== null;
  const latestTurn = entry.turns[entry.turns.length - 1];
  const origin =
    entry.source === "manual"
      ? t.memory.originManual
      : props.view.sessionTitle === null
        ? t.memory.originDeleted
        : latestTurn === undefined
          ? props.view.sessionTitle
          : t.memory.origin(props.view.sessionTitle, latestTurn);
  // 撤销入口：只在当前确实可撤时给（口径见 memoryUndoActions）
  const undo = memoryUndoActions(props.view);
  const restorable = undo.restorePrevious;
  const returnable = undo.returnToWorkspace;
  const undoable = restorable || returnable;

  return (
    <li
      className="mem-entry"
      data-open={open || undefined}
      data-busy={busy || confirming || editing !== null || undefined}
      data-state={state === "active" ? undefined : state}
    >
      <span className="mem-entry-icon" title={t.memory.typeOne(entry.type)}>
        <Icon name={MEMORY_TYPE_ICON[entry.type]} size={14} strokeWidth={1.8} />
      </span>
      <div className="mem-entry-body">
        {editing !== null ? (
          <>
            <textarea
              className="mem-edit"
              value={editing}
              aria-label={t.memory.edit}
              autoFocus
              onChange={(event) => setEditing(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setEditing(null);
                }
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void saveEdit();
              }}
            />
            <span className="mem-edit-row">
              <button type="button" className="mem-btn primary" disabled={busy} onClick={() => void saveEdit()}>
                {busy && <Icon name="loader-circle" size={12} spin />}
                {t.memory.save}
              </button>
              <button type="button" className="mem-btn quiet" onClick={() => setEditing(null)}>
                {t.memory.cancel}
              </button>
            </span>
          </>
        ) : (
          <button
            type="button"
            className="mem-entry-text"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {entry.text}
          </button>
        )}
        {entry.reason !== undefined && entry.reason !== "" && (
          <p className="mem-entry-reason">
            {entry.source === "agent" ? t.memory.reviseReasonLabel : t.memory.reasonLabel(entry.type)}
            {entry.reason}
          </p>
        )}
        {state === "muted" && entry.mutedReason !== undefined && (
          <p className="mem-entry-reason">
            {t.memory.retireReasonLabel}
            {entry.mutedReason}
          </p>
        )}
        <span className="mem-entry-meta">
          {state !== "active" && (
            <span className="mem-tag" data-tone={state === "stale" ? "warn" : undefined}>
              <Icon name={state === "muted" ? "eye-off" : "history"} size={11} strokeWidth={1.8} />
              {state === "muted" ? t.memory.statusMuted : t.memory.statusStale}
            </span>
          )}
          {entry.source === "agent" && (
            <button type="button" className="mem-tag" title={t.memory.agentRevisedHint} onClick={() => setOpen(true)}>
              <Icon name="bot" size={11} strokeWidth={1.8} />
              {t.memory.agentRevised}
            </button>
          )}
          {returnable && (
            <button type="button" className="mem-tag" title={t.memory.autoPromotedHint} onClick={() => setOpen(true)}>
              <Icon name="user" size={11} strokeWidth={1.8} />
              {t.memory.autoPromoted}
            </button>
          )}
          {/* 自动升层的条目已有「已记到所有工作区」，不再重复一个「所有工作区」范围标签 */}
          {props.scopeName !== null && !returnable && (
            <span className="mem-tag">
              <Icon name={entry.layer === "user" ? "user" : "folder"} size={11} strokeWidth={1.8} />
              {props.scopeName}
            </span>
          )}
          {evolution.length > 1 && (
            <button type="button" className="mem-tag" onClick={() => setOpen(true)}>
              <Icon name="history" size={11} strokeWidth={1.8} />
              {t.memory.evolution(evolution.length)}
            </button>
          )}
          {props.showOrigin && (
            <span className="mem-entry-origin" title={origin}>
              {origin}
            </span>
          )}
          <span className="mem-entry-date">{formatDay(entry.at, now)}</span>
        </span>
        {problem !== null && <p className="mem-error">{problem}</p>}
        {open && (props.view.quote !== null || evolution.length > 1 || jumpable || undoable) && (
          <div className="mem-detail">
            {props.view.quote !== null && (
              <>
                <span className="mem-detail-label">{t.memory.quoteLabel}</span>
                <p className="mem-quote">{props.view.quote}</p>
              </>
            )}
            {jumpable && (
              <button type="button" className="mem-link" onClick={() => props.onJump?.(props.view)}>
                <Icon name="external-link" size={12} strokeWidth={1.8} />
                <span className="mem-link-label">
                  {t.memory.jumpSource} · {origin}
                </span>
              </button>
            )}
            {evolution.length > 1 && (
              <>
                <span className="mem-detail-label">{t.memory.evolutionTitle}</span>
                <ol className="mem-chain">
                  {evolution.map((node) => (
                    <li
                      key={node.id}
                      data-current={node.id === entry.id || undefined}
                      data-stale={node.status === "stale" || undefined}
                    >
                      <span className="mono">{formatDay(node.at, now)}</span>
                      <span>
                        <span className="mem-chain-text">{node.text}</span>
                        {node.source === "agent" && (
                          <span className="mem-tag">
                            <Icon name="bot" size={11} strokeWidth={1.8} />
                            {t.memory.agentRevised}
                          </span>
                        )}
                        {node.status === "stale" && (
                          <span className="mem-tag" data-tone="warn">
                            {t.memory.statusStale}
                          </span>
                        )}
                        {node.status === "muted" && <span className="mem-tag">{t.memory.statusMuted}</span>}
                      </span>
                    </li>
                  ))}
                </ol>
              </>
            )}
            {undoable && (
              <span className="mem-edit-row">
                {restorable && (
                  <button
                    type="button"
                    className="mem-btn"
                    disabled={busy}
                    title={t.memory.restorePreviousHint}
                    onClick={() => void run({ op: "restorePrevious", token, entryId: entry.id })}
                  >
                    <Icon name="undo-2" size={12} strokeWidth={1.8} />
                    {t.memory.restorePrevious}
                  </button>
                )}
                {returnable && (
                  <button
                    type="button"
                    className="mem-btn"
                    disabled={busy}
                    title={t.memory.returnToWorkspaceHint}
                    onClick={() => void run({ op: "returnToWorkspace", token, entryId: entry.id })}
                  >
                    <Icon name="folder" size={12} strokeWidth={1.8} />
                    {t.memory.returnToWorkspace}
                  </button>
                )}
              </span>
            )}
          </div>
        )}
      </div>
      {editing === null && (
        <span className="mem-acts" data-confirming={confirming || undefined}>
          {confirming ? (
            <>
              <button
                type="button"
                className="mem-btn danger"
                disabled={busy}
                onClick={() => void run({ op: "remove", token, entryId: entry.id }).then(() => setConfirming(false))}
              >
                {busy && <Icon name="loader-circle" size={12} spin />}
                {t.memory.confirmRemove}
              </button>
              <button type="button" className="mem-btn quiet" onClick={() => setConfirming(false)}>
                {t.memory.cancel}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="mem-icon-btn"
                title={t.memory.edit}
                aria-label={t.memory.edit}
                disabled={busy}
                onClick={() => setEditing(entry.text)}
              >
                <Icon name="pencil-line" size={12} strokeWidth={1.8} />
              </button>
              {state !== "stale" && (
                <button
                  type="button"
                  className="mem-icon-btn"
                  title={state === "muted" ? t.memory.unmute : t.memory.mute}
                  aria-label={state === "muted" ? t.memory.unmute : t.memory.mute}
                  disabled={busy}
                  onClick={() =>
                    void run({
                      op: "setStatus",
                      token,
                      entryId: entry.id,
                      status: state === "muted" ? "active" : "muted",
                    })
                  }
                >
                  <Icon name={state === "muted" ? "eye" : "eye-off"} size={12} strokeWidth={1.8} />
                </button>
              )}
              <button
                type="button"
                className="mem-icon-btn danger"
                title={t.memory.remove}
                aria-label={t.memory.remove}
                disabled={busy}
                onClick={() => setConfirming(true)}
              >
                <Icon name="trash-2" size={12} strokeWidth={1.8} />
              </button>
            </>
          )}
        </span>
      )}
    </li>
  );
}
