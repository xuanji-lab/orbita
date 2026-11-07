import { useContext } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { CapCompletion, CapSessionId, CapTitle, type CapCompletionState } from "./SessionCapsule";
import { PanelIconButton } from "./RightPanel";
import { ToolbarPanelSlotContext } from "./Toolbar";
import { useHScroll } from "./h-scroll.ts";
import type { DockedTab } from "./drawer-state.ts";
import { useT } from "../locale.ts";
import "./h-scroll.css";

/**
 * 辅助对话在顶部右栏胶囊里的页头（2026-11-07 用户：「session 名字和加号应该放在顶部那个
 * bubble 里的」）：与文件 / 能力 / 选择器同一个思路——页头住胶囊，面板里只剩对话。
 *
 * 左段 = 当前激活的那条会话，写法与主会话胶囊同一套（CapTitle / CapSessionId /
 * CapCompletion，改名、复制 id、完成键的行为只有一份）；右段 = 其它停靠的标签（灰、可 ×）
 * + 「+」进选择器。标签多了在胶囊里横向滚动（h-scroll.ts：Shift+滚轮与普通竖滚轮都转横向、
 * 被裁的一侧淡出）。激活的标签住在左段当标题，所以它不在右段里——点右段一枚标签 = 与
 * 当前激活的互换位置。窄到放不下时：左段标题先省略号，标签区封顶占一半宽，「+」永远可见。
 */
export function DrawerCap(props: {
  /** 当前激活标签的信息：标题、短 id、改名、完成键；新任务占位没有 id（短 id / 改名 / 完成都不摆） */
  active: {
    title: string;
    shortId: string | null;
    onRename?: ((title: string) => void) | undefined;
    completion: CapCompletionState | null;
  };
  /** 右段的其它标签（已排除激活的），按停靠顺序 */
  others: { tab: DockedTab; label: string }[];
  /** 刚从左段换下去的那枚标签：在右段里滚进视野，用户换了一下还能一眼看到它去了哪 */
  revealTab: DockedTab | null;
  onActivate: (tab: DockedTab) => void;
  onClose: (tab: DockedTab) => void;
  /** 关掉当前激活的这条：悬停胶囊才显形的小 ×，住在左段（右段的标签自带 ×，激活的住在左段，要有自己的出口） */
  onCloseActive: () => void;
  /** 「+」：进选择器再开一个 */
  onAdd: () => void;
}) {
  const t = useT();
  const slot = useContext(ToolbarPanelSlotContext);
  const scroll = useHScroll('[data-reveal="true"]', [props.others.map((entry) => entry.tab).join("\n"), props.revealTab]);
  if (slot === null) return null;
  return createPortal(
    <div className="cap-panel-content cap-dcap" key="drawer-chat">
      <div className="cap-dseg no-drag">
        <CapTitle
          title={props.active.title}
          onRename={props.active.onRename}
          leading={<Icon name="message-square" size={16} strokeWidth={1.8} className="cap-dseg-icon" />}
        />
        <CapSessionId shortId={props.active.shortId} />
        {/* 关掉当前这条：悬停才显形，且和铅笔 / 复制一样住在左段里——它显形时只吃左段（标题）
            的宽，不挤右边的完成键 / 标签区 / 「+」，右段的位置悬停前后一个像素不动 */}
        <button
          type="button"
          className="quiet-control cap-mini cap-hov cap-dclose"
          title={t.drawer.closeTab}
          aria-label={t.drawer.closeTab}
          onClick={props.onCloseActive}
        >
          <Icon name="x" size={14} strokeWidth={1.8} />
        </button>
      </div>
      <span className="cap-grow" aria-hidden="true" />
      {props.active.completion !== null && <CapCompletion completion={props.active.completion} />}
      {props.others.length > 0 && <span className="cap-vsep" />}
      {props.others.length > 0 && (
        <div
          ref={scroll.ref}
          className="cap-dtabs h-scroll no-drag"
          role="tablist"
          data-fade-start={scroll.fade.start || undefined}
          data-fade-end={scroll.fade.end || undefined}
          onScroll={scroll.onScroll}
        >
          {props.others.map((entry) => (
            <span key={entry.tab} className="cap-dtab" data-reveal={entry.tab === props.revealTab || undefined}>
              <button
                type="button"
                role="tab"
                aria-selected={false}
                className="cap-dtab-main"
                title={entry.label}
                onClick={() => props.onActivate(entry.tab)}
              >
                <span className="cap-dtab-name">{entry.label}</span>
              </button>
              <button
                type="button"
                className="cap-dtab-x"
                title={t.drawer.closeTab}
                aria-label={t.drawer.closeTab}
                onClick={() => props.onClose(entry.tab)}
              >
                <Icon name="x" size={12} strokeWidth={2} />
              </button>
            </span>
          ))}
        </div>
      )}
      <PanelIconButton title={t.drawer.newTab} onClick={props.onAdd}>
        <Icon name="plus" size={16} strokeWidth={2} />
      </PanelIconButton>
    </div>,
    slot,
  );
}
