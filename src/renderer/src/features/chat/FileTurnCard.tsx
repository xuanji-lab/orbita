import { useContext, useState, type ReactNode } from "react";
import { Icon } from "../../shell/Icon";
import { RowHoverAction } from "../../shell/RowHoverAction";
import { useT } from "../../locale.ts";
import { api } from "../../api";
import type { FileTurnView, RevertRecord } from "@shared/revert";
import { isWebArtifactFile } from "@shared/files";
import { pathParts } from "./path-parts.ts";
import { RevertPreviewContext } from "./revert-preview.ts";

/**
 * 轮尾卡片家族 —— 每轮 assistant 结束后插在对话流的文件账（FileTurnRecord）与
 * 回退界碑的「还原卡」（RevertRecord）。同一个卡片配方（zcode 的改动卡参考）：
 * 头部一行（chevron + 「N 个文件已更改」 + +x −y + 撤销），展开是文件行。
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
 * 轮尾文件账（2026-11-17 对话流降噪）：挂在产出它的那段回复下面，**一行一个文件**，不套卡片框。
 * 用户 2026-11-16 截图里这里是一张带框的「生成了 2 个网页」卡，每行常显两个按钮；定稿图（mock-bgstrip 8-stream-busy-after）
 * 是一行一个：图标 · 文件名 · 灰字尾巴（改了几行 / 脚本生成），动作只在悬停或键盘聚焦时出（行尾血线 .row-trailing）。
 *
 * - 点文件名：改过的文件去审查面板看 diff，网页在 Orbita 浏览器里打开；
 * - 悬停动作：网页「打开文件位置」；改过的文件「撤销这一轮的文件改动」（整轮撤，对话不动；只对文件账有意义）；
 * - 已撤销：尾巴写「已撤销」；撤销预演中的那一轮：行字加深，底部确认栏说的就是这几行；
 * - 多于 FILE_ROWS_SHOWN 个时，其余收成一行「还有 N 个文件」，点开再列。
 * 旁路网页产物（脚本生成）不参与撤销，只能打开。
 */
const FILE_ROWS_SHOWN = 5;

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
  const previewing = preview?.kind === "undo" && preview.turnId === props.record.id;
  const [more, setMore] = useState(false);
  const scripted = props.record.webArtifacts ?? [];
  const batch = props.record.webArtifactsBatch;
  const undo = props.undone || props.busy ? null : () => props.onUndo(props.record.id);
  const rows: ReactNode[] = [
    ...props.record.changes.map((change) =>
      isWebArtifactFile(change.path) ? (
        <ArtifactRow key={change.path} path={change.path} cwd={props.cwd} sessionId={props.sessionId} undone={props.undone} onUndo={undo} />
      ) : (
        <ChangedRow key={change.path} change={change} cwd={props.cwd} undone={props.undone} onOpenFile={props.onOpenFile} onUndo={undo} />
      ),
    ),
    ...scripted.map((path) => <ArtifactRow key={path} path={path} cwd={props.cwd} sessionId={props.sessionId} scripted undone={false} onUndo={null} />),
  ];
  const shown = more || previewing ? rows : rows.slice(0, FILE_ROWS_SHOWN);
  return (
    <div className={previewing ? "ft-rows previewing" : "ft-rows"}>
      {shown}
      {shown.length < rows.length && (
        <button type="button" className="ft-row ft-more" aria-expanded={false} onClick={() => setMore(true)}>
          <span className="ft-icon">
            <Icon name="chevron-right" size={12} strokeWidth={1.8} />
          </span>
          <span className="ft-name">{t.chat.fileRowsMore(rows.length - shown.length)}</span>
        </button>
      )}
      {batch !== undefined && <WebBatchRow count={batch} />}
    </div>
  );
}

/** 灰字尾巴：改了几行（不上色——颜色只给「等你」）；已撤销的写「已撤销」 */
function ChangeTail(props: { added: number; removed: number; undone: boolean }) {
  const t = useT();
  if (props.undone) return <span className="ft-tail">{t.chat.fileCardUndone}</span>;
  const parts = [props.added > 0 ? `+${props.added}` : "", props.removed > 0 ? `−${props.removed}` : ""].filter((part) => part !== "");
  return parts.length === 0 ? null : <span className="ft-tail">{parts.join(" ")}</span>;
}

/** 改过的文件一行：点名字去审查面板看 diff；悬停出「撤销这一轮的文件改动」 */
function ChangedRow(props: {
  change: FileTurnView["changes"][number];
  cwd: string | null;
  undone: boolean;
  onOpenFile?: (path: string) => void;
  onUndo: (() => void) | null;
}) {
  const t = useT();
  const parts = pathParts(props.change.path, props.cwd);
  const open = props.onOpenFile;
  return (
    <div className="ft-row">
      <span className="ft-icon">
        <Icon name="file-text" size={12} strokeWidth={1.8} />
      </span>
      <button type="button" className="ft-name" disabled={open === undefined} title={props.change.path} onClick={() => open?.(props.change.path)}>
        {parts.name}
      </button>
      <span className="ft-trail row-trailing">
        <ChangeTail added={props.change.added} removed={props.change.removed} undone={props.undone} />
        {props.onUndo !== null && <RowHoverAction icon="undo-2" title={t.chat.fileCardUndoHint} onClick={props.onUndo} className="row-hover-act ft-act" />}
      </span>
    </div>
  );
}

/**
 * 网页一行（.html / .htm / .svg）：点名字在 Orbita 浏览器打开（网页产物的默认出口，沙盒里还能开 DevTools）；
 * 悬停出「打开文件位置」。主进程按会话文件账白名单校验（changes 与旁路 webArtifacts 都算）。
 * scripted = 旁路产物（脚本生成）：尾巴写「脚本生成」——它不在文件账里、不参与撤销。
 * 打不开时（不在本会话的目录里、文件已不在……）行下一行说清楚原因，不让用户点了没反应。
 */
function ArtifactRow(props: {
  path: string;
  cwd: string | null;
  sessionId: string;
  scripted?: boolean;
  undone: boolean;
  onUndo: (() => void) | null;
}) {
  const t = useT();
  const parts = pathParts(props.path, props.cwd);
  const [refusal, setRefusal] = useState<string | null>(null);
  const openInBrowser = () => {
    setRefusal(null);
    void api.session.openArtifactInBrowser(props.sessionId, props.path).then(
      (result) => {
        if (!result.ok) setRefusal(t.chat.openInOrbitaRefused(result.reason));
      },
      (cause: unknown) => {
        console.error("[file-card] 内置浏览器打开失败", cause);
        setRefusal(t.chat.openInOrbitaFailed);
      },
    );
  };
  const reveal = () => {
    void api.session.revealArtifact(props.sessionId, props.path).catch((cause: unknown) => {
      console.error("[file-card] 定位文件失败", cause);
    });
  };
  return (
    <>
      <div className="ft-row">
        <span className="ft-icon">
          <Icon name="globe" size={12} strokeWidth={1.8} />
        </span>
        <button type="button" className="ft-name" title={`${t.chat.openInOrbita} · ${props.path}`} onClick={openInBrowser}>
          {parts.name}
        </button>
          <span className="ft-trail row-trailing">
          {props.scripted === true ? <span className="ft-tail">{t.chat.fileCardScripted}</span> : props.undone && <span className="ft-tail">{t.chat.fileCardUndone}</span>}
          <RowHoverAction icon="folder-open" title={t.chat.revealArtifact} onClick={reveal} className="row-hover-act ft-act" />
          {props.onUndo !== null && <RowHoverAction icon="undo-2" title={t.chat.fileCardUndoHint} onClick={props.onUndo} className="row-hover-act ft-act" />}
        </span>
      </div>
      {refusal !== null && (
        <div role="status" className="ft-refusal">
          <Icon name="triangle-alert" size={11} strokeWidth={2} />
          <span>{refusal}</span>
        </div>
      )}
    </>
  );
}

/**
 * 批量折叠行：本轮网页文件变动超过上限（git checkout / 解压归档这类批量操作）
 * 时不逐个列，只报一行计数。与 ArtifactRow 同款行风格（左图标 + 说明），但
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
            background: "var(--color-chat-card-bg)",
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
