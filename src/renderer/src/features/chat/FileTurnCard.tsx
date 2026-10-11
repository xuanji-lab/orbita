import { useContext, useState } from "react";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { api } from "../../api";
import type { FileTurnView, RevertRecord } from "@shared/revert";
import { isWebArtifactFile } from "@shared/files";
import { splitPathTail } from "./tool-results";
import { RevertPreviewContext } from "./revert-preview.ts";

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
 * 轮尾文件账卡。头：chevron｜「N 个文件已更改」（· 生成了 M 个网页）｜+x −y｜撤销。
 * **收起态也直接露出网页行**（文件账里的与旁路的都算）——网页产物是这一轮最
 * 常被点开的东西，不该藏在展开里；其余文件行仍要展开才见。已撤销的轮：数字
 * 列表保留、加「已撤销」徽标、撤销按钮禁用（不做重新应用——重新应用等于重跑
 * 那轮，交给回退后重发）。
 *
 * 只有旁路网页产物、没有文件改动的轮也出卡（头部「生成了 N 个网页」，无 chevron、
 * 无撤销——旁路产物开轮没拍内容快照，不参与撤销）。
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
  const preview = useContext(RevertPreviewContext);
  // 撤销预演中的那一轮：描边加重 + 自动展开，底部确认栏说的就是这张卡里的文件
  const previewing = preview?.kind === "undo" && preview.turnId === props.record.id;
  const [open, setOpen] = useState(false);
  const shown = open || previewing;
  const added = props.record.changes.reduce((sum, change) => sum + change.added, 0);
  const removed = props.record.changes.reduce((sum, change) => sum + change.removed, 0);
  // 网页行两处来源：文件账里命中的（write / edit 写的，可撤销）与旁路（脚本生成，仅可打开）
  const webFromAccount = props.record.changes.filter((change) => isWebArtifactFile(change.path));
  const scripted = props.record.webArtifacts ?? [];
  const fileRows = props.record.changes.filter((change) => !isWebArtifactFile(change.path));
  const hasWeb = webFromAccount.length + scripted.length > 0;
  // 展开键只在确有藏着的文件行时才给：网页行收起态就可见，chevron 展不出新东西就是噪音
  const expandable = fileRows.length > 0;
  // 撤销 / 已撤销只对文件账有意义：旁路产物撤不回去，没账的轮不给撤销按钮
  const undoable = props.record.changes.length > 0;
  const label = undoable
    ? t.chat.fileCardChanged(props.record.changes.length) +
      (scripted.length > 0 ? ` · ${t.chat.fileCardWebMade(scripted.length)}` : "")
    : t.chat.fileCardWebMade(scripted.length);
  const webSection = (bordered: boolean) => (
    <div
      style={{
        display: "grid",
        gap: 2,
        ...(bordered
          ? { marginTop: "var(--space-1)", paddingTop: "var(--space-1)", borderTop: "1px solid var(--color-border-subtle)" }
          : null),
      }}
    >
      {webFromAccount.map((change) => (
        <ArtifactRow key={change.path} path={change.path} cwd={props.cwd} sessionId={props.sessionId} />
      ))}
      {scripted.map((path) => (
        <ArtifactRow key={path} path={path} cwd={props.cwd} sessionId={props.sessionId} scripted />
      ))}
    </div>
  );
  return (
    <div
      className="file-turn-card"
      style={{
        display: "grid",
        gap: shown || hasWeb ? "var(--space-1)" : 0,
        padding: "var(--space-2) var(--space-3)",
        background: "var(--color-chat-card-bg)",
        border: `1px solid ${previewing ? "var(--color-border-strong)" : "var(--color-border-subtle)"}`,
        boxShadow: previewing ? "0 0 0 1px var(--color-border-strong)" : "none",
        borderRadius: "var(--radius-md)",
        fontSize: "var(--font-size-caption)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
        {/* 整个头部左段都是展开键（不是只有 13px 的 chevron）：zcode 同款，点哪都开 */}
        {expandable ? (
          <button
            type="button"
            title={shown ? t.chat.fileCardCollapse : t.chat.fileCardExpand}
            aria-expanded={shown}
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
                transform: shown ? "rotate(90deg)" : "none",
              }}
            >
              <Icon name="chevron-right" size={13} strokeWidth={1.8} />
            </span>
            <span style={{ color: "var(--color-text-secondary)", fontWeight: 600 }}>{label}</span>
            <Stats added={added} removed={removed} />
          </button>
        ) : (
          // 没有藏着的行（只有网页行）：头部是静态的，不装展开键
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-2)",
              flex: "1 1 auto",
              minWidth: 0,
              color: "var(--color-text-secondary)",
              fontWeight: 600,
            }}
          >
            {label}
            <Stats added={added} removed={removed} />
          </span>
        )}
        {undoable &&
          (props.undone ? (
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
          ))}
      </div>
      {/* 收起态也露出网页行（用户裁决）：文件账里的与旁路的都直接可见、可点 */}
      {hasWeb && !shown && webSection(false)}
      {shown && (
        <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
          {fileRows.map((change) => {
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
          {hasWeb && webSection(true)}
        </div>
      )}
    </div>
  );
}

/** 旁路标记的槽位：小字、三级灰，不参与 rtl 折叠（它是固定文案，不是路径）。 */
const SLOT_MARK: React.CSSProperties = {
  fontSize: "var(--font-size-caption)",
  color: "var(--color-text-tertiary)",
  whiteSpace: "nowrap",
  flex: "0 0 auto",
};

/**
 * 轮尾产物行（.html / .htm / .svg）：左图标、名称 + 类型「网页」（zcode 参考的
 * 形态），末端两个按钮——「在 Orbita 浏览器打开」（网页产物的默认出口，沙盒里
 * 还能开着 DevTools 看）与「打开文件所在位置」。主进程按会话文件账白名单校验
 * （changes 与旁路 webArtifacts 都算）。
 *
 * scripted = 旁路产物（脚本生成）：行内标「脚本生成 · 仅可打开」——它不在文件
 * 账里、不参与撤销，这是卡片上如实交代的两件事。
 */
function ArtifactRow(props: { path: string; cwd: string | null; sessionId: string; scripted?: boolean }) {
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
        {props.scripted === true && <span style={SLOT_MARK}>{t.chat.fileCardScripted}</span>}
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
