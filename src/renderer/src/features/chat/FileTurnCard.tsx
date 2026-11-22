import { useContext, useState } from "react";
import { Icon } from "../../shell/Icon";
import { FileTypeIcon } from "../../shell/FileTypeIcon";
import { useT } from "../../locale.ts";
import type { FileTurnView, RevertRecord } from "@shared/revert";
import { pathParts } from "./path-parts.ts";
import { RevertPreviewContext } from "./revert-preview.ts";

/**
 * 轮尾卡片家族 —— 每轮 assistant 结束后插在对话流的文件账（FileTurnRecord）与
 * 回退界碑的「还原卡」（RevertRecord）。头部一行，展开是文件行（文件账卡的样子见 FileTurnCard）。
 *
 * 卡片是**落盘事实的投影**（冷启动从 JSONL 重建，不依赖内存）——实时事件与盘上
 * 种子喂的是同一种记录。
 */

/**
 * 一行增删统计（git stat 读法：+ 绿 − 红）。**为零的一侧不画**（zcode 同款）：
 * 新建文件写成「+12 −0」，那个红色的 −0 是没有信息量的噪音，还把红色用在了非失败上。
 */
export function Stats(props: { added: number; removed: number }) {
  if (props.added === 0 && props.removed === 0) return null;
  return (
    <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", display: "inline-flex", gap: 6 }}>
      {props.added > 0 && <span style={{ color: "var(--color-success)" }}>+{props.added}</span>}
      {props.removed > 0 && <span style={{ color: "var(--color-danger)" }}>−{props.removed}</span>}
    </span>
  );
}

const SLOT_DIR: React.CSSProperties = {
  fontSize: "var(--font-size-sm)",
  color: "var(--color-text-tertiary)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  direction: "rtl",
  textAlign: "left",
};

/**
 * 轮尾文件账卡（2026-11-22 照 Kimi）：只说「这一轮改了哪些文件」，能撤销、能审核；做出来要预览的东西（网页、演示文稿、
 * 文档、导出的文件）不在这里，各占一张产物卡（ChatView 的 TurnOutputsBlock）——用户：「一个是说你编辑了哪些东西，然后可以
 * 审查，可以撤销。另一个的话就是纯预览你的产出结果」。
 *
 * 头：笔 ｜「已编辑 N 个文件」+x −y ｜ 撤销 ｜ 审核（打开审查面板看 diff）。点头部展开逐文件一行（名字 · 目录 · 增删），
 * 点一行在审查面板定位到它；展开后底下一行「收起」。白底淡边，与产物卡同宽同骨架。
 * 已撤销的轮：数字保留、加「已撤销」徽标、撤销按钮换掉（不做重新应用——那等于重跑那轮，交给回退后重发）。
 * 只有网页产物、没有文件改动的轮不出这张卡（网页去产物卡）；批量网页变动只剩一句说明。
 */
export function FileTurnCard(props: {
  record: FileTurnView;
  cwd: string | null;
  undone: boolean;
  busy: boolean;
  onUndo: (turnId: string) => void;
  /** 点文件行 / 审核 → 右侧审查面板打开并定位该文件的 diff */
  onOpenFile?: (path: string) => void;
  sessionId: string;
}) {
  const t = useT();
  const preview = useContext(RevertPreviewContext);
  // 撤销预演中的那一轮：描边加重 + 自动展开，底部确认栏说的就是这张卡里的文件
  const previewing = preview?.kind === "undo" && preview.turnId === props.record.id;
  const [open, setOpen] = useState(false);
  const shown = open || previewing;
  const changes = props.record.changes;
  const added = changes.reduce((sum, change) => sum + change.added, 0);
  const removed = changes.reduce((sum, change) => sum + change.removed, 0);
  const batch = props.record.webArtifactsBatch;
  if (changes.length === 0) {
    return batch === undefined ? null : (
      <div className="file-turn-card" data-previewing={previewing || undefined}>
        <WebBatchRow count={batch} />
      </div>
    );
  }
  const review = props.onOpenFile;
  return (
    <div className="file-turn-card" data-previewing={previewing || undefined}>
      <div className="ftc-head">
        <button
          type="button"
          className="ftc-toggle"
          aria-expanded={shown}
          title={shown ? t.chat.fileCardCollapse : t.chat.fileCardExpand}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="ftc-icon">
            <Icon name="pencil-line" size={18} strokeWidth={1.6} />
          </span>
          <span className="ftc-title">
            <span className="ftc-label">{t.chat.fileCardChanged(changes.length)}</span>
            <Stats added={added} removed={removed} />
          </span>
        </button>
        {props.undone ? (
          <span className="ftc-undone">
            <Icon name="check" size={11} strokeWidth={1.8} />
            {t.chat.fileCardUndone}
          </span>
        ) : (
          <button
            type="button"
            className="ftc-btn"
            title={t.chat.fileCardUndoHint}
            disabled={props.busy}
            onClick={() => props.onUndo(props.record.id)}
          >
            {t.chat.fileCardUndo}
          </button>
        )}
        {review !== undefined && (
          <button type="button" className="ftc-btn" title={t.chat.fileCardReviewHint} onClick={() => review(changes[0]?.path ?? "")}>
            {t.chat.fileCardReview}
          </button>
        )}
      </div>
      {shown && (
        <>
          <div className="ftc-list">
            {changes.map((change) => {
              const parts = pathParts(change.path, props.cwd);
              return (
                <button
                  key={change.path}
                  type="button"
                  className="ftc-row"
                  disabled={review === undefined}
                  onClick={() => review?.(change.path)}
                >
                  <FileTypeIcon name={parts.name} size={16} />
                  <span className="ftc-name">{parts.name}</span>
                  {parts.dir !== "" && <span className="ftc-dir">{parts.dir}</span>}
                  <span className="ftc-stats">
                    <Stats added={change.added} removed={change.removed} />
                  </span>
                </button>
              );
            })}
            {batch !== undefined && <WebBatchRow count={batch} />}
          </div>
          <button type="button" className="ftc-fold" onClick={() => setOpen(false)}>
            {t.chat.fileCardFold}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * 批量折叠行：本轮网页文件变动超过上限（git checkout / 解压归档这类批量操作）
 * 时不逐个列，只报一行计数。行风格是左图标 + 说明，但
 * **不带任何按钮**——没有具体路径可打开，给了按钮就是空承诺。
 */
function WebBatchRow(props: { count: number }) {
  const t = useT();
  return (
    <div
      className="web-batch-row"
      style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0, padding: "2px 0" }}
    >
      <span style={{ color: "var(--color-text-tertiary)", flex: "0 0 auto", display: "inline-flex" }}>
        <Icon name="layers" size={12} strokeWidth={1.8} />
      </span>
      <span style={{ minWidth: 0, color: "var(--color-text-secondary)" }}>{t.chat.fileCardWebBatch(props.count)}</span>
    </div>
  );
}

/**
 * 回退界碑：「已回退」一行 + 同款卡片的还原摘要（还原了 N 个文件 / 删除了 M 个）。
 * 卡与被撤轮次的卡一起消失的是对话；这里留的是回退发生过、以及盘被动过什么的凭据。
 * 卡片可展开：逐文件列出结果（恢复 / 删除 / 未还原），点行去审查面板看现状。
 */
export function RevertMarkView(props: {
  record: RevertRecord;
  cwd: string | null;
  onOpenFile?: (path: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const files = props.record.restored;
  const restored = files.filter((entry) => entry.outcome === "restored").length;
  const deleted = files.filter((entry) => entry.outcome === "deleted").length;
  const skipped = files.filter((entry) => entry.outcome === "skipped").length;
  const parts = [
    restored > 0 ? t.chat.revertRestored(restored) : null,
    deleted > 0 ? t.chat.revertDeleted(deleted) : null,
    skipped > 0 ? t.chat.revertSkipped(skipped) : null,
  ].filter((part): part is string => part !== null);
  return (
    <div style={{ display: "grid", gap: "var(--space-2)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          fontSize: "var(--font-size-sm)",
          color: "var(--color-text-tertiary)",
        }}
      >
        <span style={{ width: 18, height: 1, background: "var(--color-border-subtle)", flex: "0 0 auto" }} />
        <Icon name="rotate-ccw" size={11} strokeWidth={1.8} />
        {t.chat.revertedHere}
        <span style={{ flex: 1, height: 1, background: "var(--color-border-subtle)" }} />
      </div>
      {parts.length > 0 && (
        <div
          style={{
            display: "grid",
            gap: open ? "var(--space-1)" : 0,
            padding: "var(--space-2) var(--space-3)",
            background: "var(--color-bg-panel)",
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "var(--radius-md)",
            fontSize: "var(--font-size-sm)",
          }}
        >
          <button
            type="button"
            aria-expanded={open}
            title={open ? t.chat.fileCardCollapse : t.chat.fileCardExpand}
            onClick={() => setOpen((value) => !value)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              padding: 0,
              border: "none",
              background: "none",
              font: "inherit",
              color: "var(--color-text-secondary)",
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            <span
              style={{
                display: "inline-flex",
                color: "var(--color-text-tertiary)",
                transition: "transform var(--duration-fast) var(--ease-out-quint)",
                transform: open ? "rotate(90deg)" : "none",
              }}
            >
              <Icon name="chevron-right" size={13} strokeWidth={1.8} />
            </span>
            <span style={{ fontWeight: 600 }}>{parts.join(" · ")}</span>
          </button>
          {open &&
            files.map((entry) => {
              const name = pathParts(entry.path, props.cwd);
              const clickable = props.onOpenFile !== undefined && entry.outcome !== "skipped";
              return (
                <button
                  key={entry.path}
                  type="button"
                  disabled={!clickable}
                  onClick={() => props.onOpenFile?.(entry.path)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-2)",
                    minWidth: 0,
                    padding: "2px 0 2px 21px",
                    border: 0,
                    background: "transparent",
                    color: "inherit",
                    font: "inherit",
                    textAlign: "left",
                    cursor: clickable ? "pointer" : "default",
                  }}
                >
                  <span style={{ color: "var(--color-text-tertiary)", flex: "0 0 auto", display: "inline-flex" }}>
                    <Icon
                      name={entry.outcome === "deleted" ? "trash-2" : entry.outcome === "skipped" ? "info" : "rotate-ccw"}
                      size={12}
                      strokeWidth={1.8}
                    />
                  </span>
                  <span style={{ minWidth: 0, display: "flex", gap: "var(--space-1)", flex: "1 1 auto" }}>
                    <span style={{ fontWeight: 600, color: "var(--color-text-primary)", whiteSpace: "nowrap" }}>{name.name}</span>
                    {name.dir !== "" && <span style={SLOT_DIR}>{name.dir}</span>}
                  </span>
                  <span style={{ flex: "0 0 auto", color: "var(--color-text-tertiary)" }}>
                    {t.chat.revertOutcome(entry.outcome)}
                  </span>
                </button>
              );
            })}
        </div>
      )}
    </div>
  );
}
