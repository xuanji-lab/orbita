import { useState } from "react";
import type { MemoryEntryType, MemoryEntryView } from "@shared/memory";
import { Icon, type IconName } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { formatMemoryDate, isRevertMuted, memoryUndoActions } from "./memory-view.ts";
import { mutateMemory } from "./useMemory.ts";
import "./memory.css";

/** 三类各自的图标：偏好 = 调节杆（你定的规矩）、经验 = 灯泡、事实 = 卷轴。 */
export const MEMORY_TYPE_ICON: Record<MemoryEntryType, IconName> = {
  preference: "sliders",
  insight: "lightbulb",
  fact: "scroll-text",
};

/**
 * 一条记忆（原型 orbita-proto.html 的记忆库，2026-10-30「一条记忆 = 一行」）。记忆库页与
 * 审查 › 记忆页签共用：
 * - 收起：一行——正文 + 行尾「用过 N 次 · 最近一次」（注入账本现算，从没用过的标橙）；
 *   过时 / 停用的条目行尾写状态。别的标签（范围、改正、演变、出处、日期）都收进展开。
 * - 点一行**就地变成编辑态**：正文就是输入框，保存 / 收起 / 别再用 / 删除都在眼前（删除要再点
 *   一次确认）；下面一行出处「来自 会话 · 第几轮 · 日期 · 用过」，一行「为什么」（理由、依据、
 *   改的原因统一这一个前缀），有演变链就列链与撤销入口。Esc 收起不存，⌘/Ctrl+Enter 保存。
 * - 日期只有一种写法（formatMemoryDate）：今天写时间，今年写月日，更早带年份。
 *
 * 没有「待你确认」（2026-10-29 用户：「我不想去确认记忆，agent 应该自己有判断力吧」）：
 * agent 判断的结果直接生效，这里只负责让人看得出发生了什么、错了能一键撤。
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
  /** 行首类型图标：记忆库按类型分好了组（组头有图标），行里不再重复；审查页签按轮分组，要它 */
  showTypeIcon?: boolean;
}) {
  const t = useT();
  const { entry, token } = props.view;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(entry.text);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const state = entry.status ?? "active";
  // 随对话回退停用：状态说清楚为什么，不把保留值当「停用原因」原文印出来
  const revertMuted = isRevertMuted(entry);
  const evolution = props.view.evolution;
  const now = Date.now();
  const day = (at: number): string => formatMemoryDate(at, now, t.memory);

  const run = async (mutation: Parameters<typeof mutateMemory>[0]): Promise<boolean> => {
    setBusy(true);
    setProblem(null);
    const outcome = await mutateMemory(mutation);
    setBusy(false);
    if (!outcome.ok) setProblem(t.memory.failed(outcome.error));
    return outcome.ok;
  };

  const expand = (): void => {
    setDraft(entry.text);
    setConfirming(false);
    setProblem(null);
    setOpen(true);
  };
  const collapse = (): void => {
    setOpen(false);
    setConfirming(false);
    setProblem(null);
  };
  const save = async (): Promise<void> => {
    const text = draft.trim();
    if (text === "" || text === entry.text) {
      collapse();
      return;
    }
    if (await run({ op: "edit", token, entryId: entry.id, text })) collapse();
  };

  const mutedReason = state === "muted" && entry.mutedReason !== undefined && !revertMuted ? entry.mutedReason : null;
  const status = revertMuted
    ? t.memory.revertMuted
    : state === "stale"
      ? t.memory.statusStale
      : state === "muted"
        ? t.memory.statusMuted
        : null;
  // 行尾：在用的写「用过几次 · 最近一次」，从没用过的标橙；过时 / 停用的写状态；视图没算用量就写日期
  const usage = props.view.usage;
  const usageText =
    usage === undefined
      ? null
      : usage.count === 0
        ? t.memory.neverUsed
        : `${t.memory.usedTimes(usage.count)} · ${day(usage.lastAt ?? entry.at)}`;
  const tail = status ?? usageText ?? day(entry.at);
  const neverUsed = status === null && usage !== undefined && usage.count === 0;
  const icon =
    props.showTypeIcon !== false ? (
      <span className="mem-entry-icon" title={t.memory.typeOne(entry.type)}>
        <Icon name={MEMORY_TYPE_ICON[entry.type]} size={14} strokeWidth={1.8} />
      </span>
    ) : null;

  if (!open) {
    return (
      <li className="mem-entry" data-icon={icon !== null || undefined} data-state={state === "active" ? undefined : state}>
        {icon}
        <button type="button" className="mem-entry-row" aria-expanded={false} onClick={expand}>
          <span className="mem-entry-text">{entry.text}</span>
          <span className="mem-entry-tail" data-tone={neverUsed ? "warn" : undefined}>
            {tail}
          </span>
        </button>
      </li>
    );
  }

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
  const reason = entry.reason !== undefined && entry.reason !== "" ? entry.reason : null;
  // 出处一行：来自 · 日期 · 用过 · （范围 · 改正 · 已记到所有工作区 · 状态）——纯文字，段间「·」
  const provenance: { key: string; node: React.ReactNode; grow?: boolean; title?: string }[] = [];
  if (props.showOrigin) {
    provenance.push({
      key: "origin",
      grow: true,
      title: origin,
      node: jumpable ? (
        <button type="button" className="mem-link" onClick={() => props.onJump?.(props.view)}>
          <span className="mem-link-label">
            {t.memory.from} {origin}
          </span>
        </button>
      ) : (
        origin
      ),
    });
  }
  provenance.push({ key: "day", node: day(entry.at) });
  if (usageText !== null) provenance.push({ key: "usage", node: usageText });
  if (undo.returnToWorkspace) {
    provenance.push({ key: "promoted", node: t.memory.autoPromoted, title: t.memory.autoPromotedHint });
  } else if (props.scopeName !== null) {
    provenance.push({ key: "scope", node: props.scopeName });
  }
  if (entry.source === "agent") provenance.push({ key: "agent", node: t.memory.agentRevised, title: t.memory.agentRevisedHint });
  if (status !== null) {
    provenance.push({
      key: "status",
      node: mutedReason !== null ? t.memory.mutedBecause(mutedReason) : status,
      ...(revertMuted ? { title: t.memory.revertMutedHint } : {}),
    });
  }

  return (
    <li
      className="mem-entry"
      data-open="true"
      data-icon={icon !== null || undefined}
      data-state={state === "active" ? undefined : state}
    >
      {icon}
      <div className="mem-entry-body">
        <textarea
          className="mem-edit"
          value={draft}
          aria-label={t.memory.edit}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              collapse();
            }
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void save();
          }}
        />
        <span className="mem-edit-row">
          <button type="button" className="mem-btn primary" disabled={busy} onClick={() => void save()}>
            {busy && !confirming && <Icon name="loader-circle" size={12} spin />}
            {t.memory.save}
          </button>
          <button type="button" className="mem-btn quiet" onClick={collapse}>
            {t.memory.collapse}
          </button>
          <span className="row-trailing mem-edit-row">
            {state !== "stale" && !confirming && (
              <button
                type="button"
                className="mem-btn"
                disabled={busy}
                onClick={() =>
                  void run({ op: "setStatus", token, entryId: entry.id, status: state === "muted" ? "active" : "muted" })
                }
              >
                {state === "muted" ? t.memory.unmute : t.memory.mute}
              </button>
            )}
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
              <button type="button" className="mem-btn" data-tone="danger" disabled={busy} onClick={() => setConfirming(true)}>
                {t.memory.remove}
              </button>
            )}
          </span>
        </span>
        {problem !== null && <p className="mem-error">{problem}</p>}
        <div className="mem-detail">
          <span className="mem-entry-meta">
            {provenance.map((part) => (
              <span key={part.key} className={part.grow === true ? "grow" : undefined} title={part.title}>
                {part.node}
              </span>
            ))}
          </span>
          {reason !== null && (
            <p className="mem-entry-reason">
              <span className="mem-detail-label">{t.memory.why}</span> {reason}
            </p>
          )}
          {props.view.quote !== null && (
            <>
              <span className="mem-detail-label">{t.memory.quoteLabel}</span>
              <p className="mem-quote">{props.view.quote}</p>
            </>
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
                    <span className="mem-chain-date">{day(node.at)}</span>
                    <span>
                      <span className="mem-chain-text">{node.text}</span>
                      {node.source === "agent" && <span className="mem-chain-note"> · {t.memory.agentRevised}</span>}
                      {node.status === "stale" && <span className="mem-chain-note warn"> · {t.memory.statusStale}</span>}
                      {node.status === "muted" && <span className="mem-chain-note"> · {t.memory.statusMuted}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
          {(undo.restorePrevious || undo.returnToWorkspace) && (
            <span className="mem-edit-row">
              {undo.restorePrevious && (
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
              {undo.returnToWorkspace && (
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
      </div>
    </li>
  );
}
