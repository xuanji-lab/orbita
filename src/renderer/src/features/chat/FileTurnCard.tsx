import { useState } from "react";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { api } from "../../api";
import type { FileTurnView, RevertRecord } from "@shared/revert";
import { splitPathTail } from "./tool-results";

/** 网页产物：浏览器能直接渲染、值得给「打开」动作的那几种（files.ts 同一张表）。 */
const WEB_ARTIFACT = /\.(?:html?|svg)$/i;

/**
 * 轮尾卡片家族 —— 每轮 assistant 结束后插在对话流的文件账（FileTurnRecord）与
 * 回退界碑的「还原卡」（RevertRecord）。同一个卡片配方（zcode 的改动卡参考）：
 * 头部一行（chevron + 「N 个文件已更改」 + +x −y + 撤销），展开是文件行。
 *
 * 卡片是**落盘事实的投影**（冷启动从 JSONL 重建，不依赖内存）——实时事件与盘上
 * 种子喂的是同一种记录。
 */

/** 路径的显示形：cwd 之内显示相对，之外显示绝对；再拆成 文件名（粗）+ 目录（淡）。 */
export function pathParts(path: string, cwd: string | null): { name: string; dir: string } {
  const display =
    cwd !== null && cwd !== "" && (path === cwd || path.startsWith(`${cwd}/`) || path.startsWith(`${cwd}\\`))
      ? path.slice(cwd.length + 1)
      : path;
  const tail = splitPathTail(display.replaceAll("\\", "/"));
  return { name: tail.name, dir: tail.dir.replace(/\/$/, "") };
}

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
  fontSize: "var(--font-size-caption)",
  color: "var(--color-text-tertiary)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  direction: "rtl",
  textAlign: "left",
};

/**
 * 轮尾文件账卡。头：chevron｜「N 个文件已更改」｜+x −y｜撤销；展开：每文件一行
 * （文件名粗 + 目录淡 + +N −M）。已撤销的轮：数字列表保留、加「已撤销」徽标、
 * 撤销按钮禁用（不做重新应用——重新应用等于重跑那轮，交给回退后重发）。
 */
export function FileTurnCard(props: {
  record: FileTurnView;
  cwd: string | null;
  undone: boolean;
  busy: boolean;
  onUndo: (turnId: string) => void;
  /** 点文件行 → 右侧审查面板打开并定位该文件的 diff */
  onOpenFile?: (path: string) => void;
  /** 产物打开按钮要按会话对账（主进程白名单：会话文件账里的路径才打得开） */
  sessionId: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const added = props.record.changes.reduce((sum, change) => sum + change.added, 0);
  const removed = props.record.changes.reduce((sum, change) => sum + change.removed, 0);
  return (
    <div
      className="file-turn-card"
      style={{
        display: "grid",
        gap: open ? "var(--space-1)" : 0,
        padding: "var(--space-2) var(--space-3)",
        background: "var(--color-chat-card-bg)",
        border: "1px solid var(--color-border-subtle)",
        borderRadius: "var(--radius-md)",
        fontSize: "var(--font-size-caption)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
        {/* 整个头部左段都是展开键（不是只有 13px 的 chevron）：zcode 同款，点哪都开 */}
        <button
          type="button"
          title={open ? t.chat.fileCardCollapse : t.chat.fileCardExpand}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--space-2)",
            flex: "1 1 auto",
            minWidth: 0,
            padding: 0,
            border: "none",
            background: "none",
            font: "inherit",
            color: "inherit",
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
          <span style={{ color: "var(--color-text-secondary)", fontWeight: 600 }}>
            {t.chat.fileCardChanged(props.record.changes.length)}
          </span>
          <Stats added={added} removed={removed} />
        </button>
        {props.undone ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "1px var(--space-2)",
              borderRadius: "var(--radius-pill)",
              background: "var(--color-bg-muted)",
              fontSize: "var(--font-size-caption)",
              color: "var(--color-text-tertiary)",
              flex: "0 0 auto",
            }}
          >
            <Icon name="check" size={11} strokeWidth={1.8} />
            {t.chat.fileCardUndone}
          </span>
        ) : (
          <button
            type="button"
            title={t.chat.fileCardUndoHint}
            aria-label={t.chat.fileCardUndoHint}
            disabled={props.busy}
            onClick={() => props.onUndo(props.record.id)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px var(--space-2)",
              border: "1px solid var(--color-border-subtle)",
              borderRadius: "var(--radius-sm)",
              background: "transparent",
              color: props.busy ? "var(--color-text-tertiary)" : "var(--color-text-secondary)",
              font: "inherit",
              fontSize: "var(--font-size-caption)",
              cursor: props.busy ? "default" : "pointer",
              flex: "0 0 auto",
            }}
          >
            <Icon name="undo-2" size={11} strokeWidth={1.8} />
            {t.chat.fileCardUndo}
          </button>
        )}
      </div>
      {open && (
        <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
          {props.record.changes.filter((change) => !WEB_ARTIFACT.test(change.path)).map((change) => {
            const parts = pathParts(change.path, props.cwd);
            const clickable = props.onOpenFile !== undefined;
            return (
              <button
                key={change.path}
                type="button"
                disabled={!clickable}
                title={clickable ? undefined : undefined}
                onClick={() => props.onOpenFile?.(change.path)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                  minWidth: 0,
                  width: "100%",
                  padding: "2px 0",
                  border: 0,
                  background: "transparent",
                  color: "inherit",
                  font: "inherit",
                  textAlign: "left",
                  cursor: clickable ? "pointer" : "default",
                }}
              >
                <span style={{ color: "var(--color-text-tertiary)", flex: "0 0 auto" }}>
                  <Icon name="file-text" size={12} strokeWidth={1.8} />
                </span>
                <span style={{ minWidth: 0, display: "flex", gap: "var(--space-1)", flex: "1 1 auto" }}>
                  <span style={{ fontWeight: 600, color: "var(--color-text-primary)", whiteSpace: "nowrap" }}>
                    {parts.name}
                  </span>
                  {parts.dir !== "" && <span style={SLOT_DIR}>{parts.dir}</span>}
                </span>
                <Stats added={change.added} removed={change.removed} />
              </button>
            );
          })}
          {props.record.changes.some((change) => WEB_ARTIFACT.test(change.path)) && (
            <div style={{ display: "grid", gap: 2, marginTop: "var(--space-1)", paddingTop: "var(--space-1)", borderTop: "1px solid var(--color-border-subtle)" }}>
              {props.record.changes
                .filter((change) => WEB_ARTIFACT.test(change.path))
                .map((change) => (
                  <ArtifactRow
                    key={change.path}
                    path={change.path}
                    cwd={props.cwd}
                    sessionId={props.sessionId}
                  />
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 轮尾产物行（.html / .htm / .svg）：左图标、名称 + 类型「网页」（zcode 参考的
 * 形态），末端两个按钮——「在 Orbita 浏览器打开」（网页产物的默认出口，沙盒里
 * 还能开着 DevTools 看）与「打开文件所在位置」。主进程按会话文件账白名单校验。
 */
function ArtifactRow(props: { path: string; cwd: string | null; sessionId: string }) {
  const t = useT();
  const parts = pathParts(props.path, props.cwd);
  const openInBrowser = () => {
    void api.session.openArtifactInBrowser(props.sessionId, props.path).catch((cause: unknown) => {
      console.error("[file-card] 内置浏览器打开失败", cause);
    });
  };
  const reveal = () => {
    void api.session.revealArtifact(props.sessionId, props.path).catch((cause: unknown) => {
      console.error("[file-card] 定位文件失败", cause);
    });
  };
  const button: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "2px var(--space-2)",
    border: "1px solid var(--color-border-subtle)",
    borderRadius: "var(--radius-sm)",
    background: "transparent",
    color: "var(--color-text-secondary)",
    font: "inherit",
    fontSize: "var(--font-size-caption)",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
      <span style={{ color: "var(--color-text-tertiary)", flex: "0 0 auto" }}>
        <Icon name="globe" size={12} strokeWidth={1.8} />
      </span>
      <span style={{ minWidth: 0, display: "flex", gap: "var(--space-1)", flex: "1 1 auto" }}>
        <span style={{ fontWeight: 600, color: "var(--color-text-primary)", whiteSpace: "nowrap" }}>
          {parts.name}
        </span>
        <span style={{ ...SLOT_DIR, flex: "0 0 auto" }}>{t.chat.fileCardWebPage}</span>
        {parts.dir !== "" && <span style={SLOT_DIR}>{parts.dir}</span>}
      </span>
      <button type="button" style={button} onClick={openInBrowser} title={t.chat.openInOrbita}>
        <Icon name="arrow-up-right" size={11} strokeWidth={1.8} />
        {t.chat.openInOrbita}
      </button>
      <button type="button" style={button} onClick={reveal} title={t.chat.revealArtifact}>
        <Icon name="folder-open" size={11} strokeWidth={1.8} />
        {t.chat.revealArtifact}
      </button>
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
          fontSize: "var(--font-size-caption)",
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
            background: "var(--color-chat-card-bg)",
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "var(--radius-md)",
            fontSize: "var(--font-size-caption)",
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
