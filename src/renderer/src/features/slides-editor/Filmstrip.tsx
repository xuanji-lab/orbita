import { useEffect, useRef, useState } from "react";
import type { Deck } from "../../../../shared/slides.ts";
import type { RenderContext } from "../../../../shared/slides-render.ts";
import { Icon } from "../../shell/Icon";
import { ContextMenu } from "../../shell/ContextMenu";
import { useT } from "../../locale.ts";
import { SlideStatic } from "./ElementView";
import { thumbWidthFor } from "./filmstrip-layout.ts";

/**
 * 底部缩略条：每页一张（与画布同一份渲染）、点选、拖动排序、右键 复制 / 删除 / 其后新建、末尾「+」加页。
 * 缩略图是 memo 的：只有被改的那页（引用变了）重画。
 */
export function Filmstrip(props: {
  deck: Deck;
  ctx: RenderContext;
  currentId: string | null;
  /** agent 刚改过的页 id：缩略图标绿边一会儿 */
  flashIds: ReadonlySet<string>;
  onSelect: (index: number) => void;
  onAdd: (afterIndex: number | null) => void;
  onMove: (from: number, to: number) => void;
  onDuplicate: (index: number) => void;
  onDelete: (index: number) => void;
  notesOpen: boolean;
  onToggleNotes: () => void;
  /** 缩略条右侧的页级动作（页背景 / 引用这一页） */
  extra?: React.ReactNode;
}) {
  const t = useT();
  const { deck, ctx, currentId } = props;
  const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const currentRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [listWidth, setListWidth] = useState(0);
  const thumbWidth = thumbWidthFor(listWidth);

  // 缩略图宽度跟列表可用宽度走（面板宽度变了重算）
  useEffect(() => {
    const list = listRef.current;
    if (list === null || typeof ResizeObserver === "undefined") return undefined;
    setListWidth(list.clientWidth);
    const observer = new ResizeObserver(() => setListWidth(list.clientWidth));
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  // 当前页始终在视野里：换页、或缩略图宽度变了（面板被拖宽 / 拖窄）都重新对齐
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [currentId, thumbWidth]);

  const total = deck.slides.length;
  return (
    <div className="se-strip">
      <div
        ref={listRef}
        className="se-strip-list"
        role="listbox"
        aria-label={t.slides.pagesAria}
        onKeyDown={(event) => {
          const index = deck.slides.findIndex((slide) => slide.id === currentId);
          if (event.key === "ArrowRight" || event.key === "ArrowDown") {
            event.preventDefault();
            props.onSelect(Math.min(total - 1, index + 1));
          } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
            event.preventDefault();
            props.onSelect(Math.max(0, index - 1));
          }
        }}
      >
        {deck.slides.map((slide, index) => (
          <button
            key={slide.id}
            ref={slide.id === currentId ? currentRef : undefined}
            type="button"
            role="option"
            aria-selected={slide.id === currentId}
            aria-label={t.slides.pageLabel(index + 1)}
            className="se-thumb"
            data-current={slide.id === currentId ? "true" : undefined}
            data-new={props.flashIds.has(slide.id) ? "true" : undefined}
            data-drop={dropAt === index && dragFrom !== null && dragFrom !== index ? (dragFrom < index ? "after" : "before") : undefined}
            draggable
            onDragStart={(event) => {
              setDragFrom(index);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", String(index));
            }}
            onDragOver={(event) => {
              if (dragFrom === null) return;
              event.preventDefault();
              setDropAt(index);
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragFrom !== null && dragFrom !== index) props.onMove(dragFrom, index);
              setDragFrom(null);
              setDropAt(null);
            }}
            onDragEnd={() => {
              setDragFrom(null);
              setDropAt(null);
            }}
            onClick={() => props.onSelect(index)}
            onContextMenu={(event) => {
              event.preventDefault();
              props.onSelect(index);
              setMenu({ x: event.clientX, y: event.clientY, index });
            }}
          >
            <SlideStatic slide={slide} aspect={deck.aspect} ctx={ctx} width={thumbWidth} />
            <span className="se-thumb-n">{index + 1}</span>
          </button>
        ))}
        <button type="button" className="se-thumb-add" onClick={() => props.onAdd(total === 0 ? null : deck.slides.findIndex((s) => s.id === currentId))} aria-label={t.slides.addPage} title={t.slides.addPage}>
          <Icon name="plus" size={16} strokeWidth={1.8} />
        </button>
      </div>
      {/* 页级动作单独一行、靠右：不挤占缩略图的横向空间（窄面板里缩略图要留够 3 张） */}
      <div className="se-strip-actions">
        {props.extra}
        <button type="button" className="se-notes-toggle" aria-pressed={props.notesOpen} onClick={props.onToggleNotes}>
          <Icon name="notebook-pen" size={14} strokeWidth={1.8} />
          {t.slides.notes}
        </button>
      </div>
      <ContextMenu
        position={menu === null ? null : { x: menu.x, y: menu.y }}
        onClose={() => setMenu(null)}
        items={
          menu === null
            ? []
            : [
                { id: "add", label: t.slides.addPageAfter, icon: "plus", onSelect: () => props.onAdd(menu.index) },
                { id: "dup", label: t.slides.duplicatePage, icon: "copy", onSelect: () => props.onDuplicate(menu.index) },
                { id: "del", label: t.slides.deletePage, icon: "trash-2", danger: true, disabled: total <= 1, onSelect: () => props.onDelete(menu.index) },
              ]
        }
      />
    </div>
  );
}
