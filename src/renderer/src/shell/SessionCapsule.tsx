import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { InlineName } from "./InlineName";
import { useT } from "../locale.ts";

/**
 * 会话胶囊（工具栏里的会话信息，2026-11-22 改左对齐，用户：「右侧面板……顶部名字都是居左的，我们的名字也可以居左」）：
 * [父会话面包屑] [标题] [短 id] [复制]，成组靠左——和右栏面板标题同一条规矩。胶囊本身的左缘由工具栏几何
 * 给（window-tools.ts 的 sessionCapsule）：侧栏展开时在对话列左缘，侧栏收起时紧跟左胶囊的专注键。
 * 子会话数量不在这里（右栏「状态」面板里看），完成键已随会话「完成」一起删除。
 * 复制键与改名铅笔悬停才显形（visibility 占位，不挤标题）；复制后按钮变对勾、胶囊下方浮「已复制 a3f9c1」
 * 约 1.2s；重命名时标题就地变输入框，外框不动。
 */
export function SessionCapsule(props: {
  title: string;
  /** 短 id（前 6 位）；null = 会话还没落盘（首条消息未发），id 与复制键不摆 */
  shortId: string | null;
  onRename?: (title: string) => void;
  /** 左端面包屑「↑ 父标题」（子会话被 Open as main 时才有） */
  crumb: { title: string; onClick: () => void } | null;
}) {
  const t = useT();

  return (
    <div className="cap-sess" style={{ width: "100%", height: "100%" }}>
      {/* 左端：父会话面包屑；没有就留空（不占位） */}
      <div className="cap-sl">
        {props.crumb !== null && (
          <button
            type="button"
            className="cap-crumb"
            onClick={props.crumb.onClick}
            title={t.chat.backToParent(props.crumb.title)}
          >
            <Icon name="arrow-up" size={11} strokeWidth={1.8} />
            <span>{props.crumb.title}</span>
          </button>
        )}
      </div>

      {/* 标题（重命名就地变输入框，外框不动）；铅笔悬停显形 */}
      <div className="cap-sc">
        <CapTitle title={props.title} onRename={props.onRename} />
      </div>

      {/* 短 id · 复制（悬停显形） */}
      <div className="cap-sr">
        <CapSessionId shortId={props.shortId} />
      </div>
    </div>
  );
}

/**
 * 会话标题：双击或点铅笔就地改名（InlineName，外框不动）。会话胶囊与辅助对话胶囊共用，
 * 改名的手势、悬停显形的铅笔都只有这一份。
 */
export function CapTitle(props: {
  title: string;
  onRename?: ((title: string) => void) | undefined;
  /** 标题前的小图标（辅助对话用会话图标与主会话的分支图标区分），可选 */
  leading?: React.ReactNode;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  return (
    <>
      {props.leading}
      <InlineName
        editing={editing}
        value={props.title}
        onCommit={(value) => {
          setEditing(false);
          props.onRename?.(value);
        }}
        onCancel={() => setEditing(false)}
      >
        <strong
          className="cap-title"
          onDoubleClick={() => props.onRename !== undefined && setEditing(true)}
        >
          {props.title}
        </strong>
      </InlineName>
      {props.onRename !== undefined && !editing && (
        <button
          type="button"
          className="quiet-control cap-mini cap-hov"
          title={t.chat.renameTask}
          aria-label={t.chat.renameTask}
          onClick={() => setEditing(true)}
        >
          <Icon name="pencil-line" size={14} strokeWidth={1.8} />
        </button>
      )}
    </>
  );
}

/**
 * 短 id（等宽 · xs · 三级墨）+ 悬停显形的复制键；复制后按钮变对勾、下方浮「已复制 a3f9c1」约 1.2s。
 * shortId 为 null（会话还没落盘）什么都不摆。
 */
export function CapSessionId(props: { shortId: string | null }) {
  const t = useT();
  /** 复制成功的对勾 + 轻提示（1.2s 淡出） */
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);
  if (props.shortId === null) return null;
  const shortId = props.shortId;
  const copyId = (): void => {
    void navigator.clipboard.writeText(shortId);
    setCopied(true);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <>
      <span className="cap-sid">{shortId}</span>
      <button
        type="button"
        className="quiet-control cap-mini cap-hov"
        title={copied ? t.toolbar.copiedId(shortId) : t.toolbar.copyId}
        aria-label={t.toolbar.copyId}
        onClick={copyId}
      >
        <Icon name={copied ? "check" : "copy"} size={13} strokeWidth={1.9} />
      </button>
      {copied && (
        <span className="cap-toast">
          <Icon name="check" size={12} strokeWidth={2.4} />
          {t.toolbar.copiedId(shortId)}
        </span>
      )}
    </>
  );
}
