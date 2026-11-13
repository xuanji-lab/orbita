import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CANVAS_SIZE, newId, sanitizeRichHtml, type Deck, type LineElement, type Slide, type SlideElement } from "../../../../shared/slides.ts";
import { appendElements, newDrawnElement, removeElements, themeNewElement, updateElements, type DrawTool } from "../../../../shared/slides-ops.ts";
import { SLIDE_DEFAULT_TEXT } from "../../../../shared/slides-palette.ts";
import { footerElement } from "../../../../shared/slides-footer.ts";
import { renderElementInner, slideBackground, type RenderContext } from "../../../../shared/slides-render.ts";
import { ElementView, boxStyle } from "./ElementView";
import {
  HANDLES,
  boxFromPoints,
  constrainAngle,
  intersects,
  lineEnds,
  lineFromEnds,
  resizeBox,
  snapMove,
  unionBox,
  type Box,
  type Guides,
  type Handle,
} from "./geometry.ts";
import { TableEditor } from "./TableEditor";

export type { DrawTool };

type Drag =
  | { kind: "move"; sx: number; sy: number; ids: string[]; start: Map<string, Box>; moved: boolean }
  | { kind: "resize"; sx: number; sy: number; id: string; handle: Handle; start: Box; keep: boolean }
  | { kind: "endpoint"; id: string; index: 0 | 1; fixed: [number, number] }
  | { kind: "marquee"; ox: number; oy: number; additive: boolean; base: ReadonlySet<string> }
  | { kind: "draw"; tool: DrawTool; ox: number; oy: number };

/** 移动时 3px 以内不算拖（点选不该带出 1px 的位移） */
const DRAG_THRESHOLD = 3;
/** 吸附阈值（屏幕 px） */
const SNAP_PX = 6;

/**
 * 画布：一页的编辑面。点选 / 拖动 / 八向缩放 / 吸附对齐线 / 框选 / 画形状 / 双击编辑文字与表格。
 * 全部几何在 geometry.ts（纯函数）；这里只管指针事件与 DOM。拖动中的位置放在 `draft`（只让被拖的元素重画），
 * 松手才一次性写回 deck（一步撤销）。
 */
export function SlideStage(props: {
  deck: Deck;
  slide: Slide;
  ctx: RenderContext;
  scale: number;
  selection: ReadonlySet<string>;
  onSelect: (ids: ReadonlySet<string>) => void;
  commit: (next: Deck, coalesceKey?: string) => void;
  tool: DrawTool | null;
  onToolDone: () => void;
  editingId: string | null;
  onEditing: (id: string | null) => void;
  /** 拖入图片文件（画布坐标） */
  onDropImages: (files: File[], at: { x: number; y: number }) => void;
}) {
  const { deck, slide, ctx, scale, selection, tool } = props;
  const canvas = CANVAS_SIZE[deck.aspect];
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [draft, setDraft] = useState<ReadonlyMap<string, Box> | null>(null);
  const [lineDraft, setLineDraft] = useState<{ id: string; line: Pick<LineElement, "x" | "y" | "w" | "h" | "points"> } | null>(null);
  const [guides, setGuides] = useState<Guides>({ vertical: [], horizontal: [] });
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [drawBox, setDrawBox] = useState<{ tool: DrawTool; box: Box; a: [number, number]; b: [number, number] } | null>(null);
  const textColor = deck.theme?.color ?? SLIDE_DEFAULT_TEXT;
  // 页脚由主题统一画（不是元素，点不中、不进撤销栈）
  const footer = useMemo(() => footerElement(deck, slide, deck.slides.indexOf(slide)), [deck, slide]);

  const pointer = useCallback(
    (event: { clientX: number; clientY: number }): [number, number] => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (rect === undefined) return [0, 0];
      return [(event.clientX - rect.left) / scale, (event.clientY - rect.top) / scale];
    },
    [scale],
  );

  const byId = useMemo(() => new Map(slide.elements.map((element) => [element.id, element])), [slide.elements]);

  const boxOf = (element: SlideElement): Box => ({ x: element.x, y: element.y, w: element.w, h: element.h });

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    // 正在编辑文字 / 表格：里面的点击归编辑器自己
    if (target.closest("[data-editing]") !== null) return;
    wrapRef.current?.focus({ preventScroll: true });
    if (props.editingId !== null) props.onEditing(null);
    const [px, py] = pointer(event);
    wrapRef.current?.setPointerCapture(event.pointerId);

    if (tool !== null) {
      dragRef.current = { kind: "draw", tool, ox: px, oy: py };
      return;
    }
    const handle = target.closest<HTMLElement>("[data-handle]");
    if (handle !== null) {
      const id = handle.dataset["id"] ?? "";
      const element = byId.get(id);
      if (element === undefined) return;
      if (handle.dataset["handle"] === "end0" || handle.dataset["handle"] === "end1") {
        if (element.kind !== "line") return;
        const index = handle.dataset["handle"] === "end0" ? 0 : 1;
        const ends = lineEnds(element);
        dragRef.current = { kind: "endpoint", id, index, fixed: ends[index === 0 ? 1 : 0] };
        return;
      }
      dragRef.current = { kind: "resize", sx: px, sy: py, id, handle: handle.dataset["handle"] as Handle, start: boxOf(element), keep: event.shiftKey || element.kind === "image" };
      return;
    }
    const hit = target.closest<HTMLElement>(".sl-el");
    const hitId = hit?.dataset["id"];
    if (hitId !== undefined && byId.has(hitId)) {
      let next: ReadonlySet<string>;
      if (event.shiftKey) {
        const set = new Set(selection);
        if (set.has(hitId)) set.delete(hitId);
        else set.add(hitId);
        next = set;
      } else {
        next = selection.has(hitId) ? selection : new Set([hitId]);
      }
      props.onSelect(next);
      const ids = [...next];
      dragRef.current = {
        kind: "move",
        sx: px,
        sy: py,
        ids,
        start: new Map(ids.flatMap((id) => (byId.get(id) === undefined ? [] : [[id, boxOf(byId.get(id) as SlideElement)] as const]))),
        moved: false,
      };
      return;
    }
    // 空白处：框选（Shift 追加）；不拖 = 清空选择
    dragRef.current = { kind: "marquee", ox: px, oy: py, additive: event.shiftKey, base: event.shiftKey ? selection : new Set() };
    if (!event.shiftKey) props.onSelect(new Set());
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    const [px, py] = pointer(event);
    switch (drag.kind) {
      case "move": {
        let dx = px - drag.sx;
        let dy = py - drag.sy;
        if (!drag.moved) {
          if (Math.hypot(dx, dy) * scale < DRAG_THRESHOLD) return;
          drag.moved = true;
        }
        const startUnion = unionBox([...drag.start.values()]);
        if (startUnion === null) return;
        if (event.shiftKey) {
          // Shift：锁定一个轴
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        let moved: Box = { ...startUnion, x: startUnion.x + dx, y: startUnion.y + dy };
        if (!event.altKey) {
          const others = slide.elements.filter((element) => !drag.start.has(element.id)).map(boxOf);
          const snapped = snapMove(moved, others, canvas, SNAP_PX / scale);
          moved = snapped.box;
          setGuides(snapped.guides);
        } else setGuides({ vertical: [], horizontal: [] });
        const ox = moved.x - startUnion.x;
        const oy = moved.y - startUnion.y;
        setDraft(new Map([...drag.start].map(([id, box]) => [id, { ...box, x: box.x + ox, y: box.y + oy }])));
        break;
      }
      case "resize": {
        const next = resizeBox(drag.start, drag.handle, px - drag.sx, py - drag.sy, drag.keep || event.shiftKey);
        setDraft(new Map([[drag.id, next]]));
        break;
      }
      case "endpoint": {
        let moving: [number, number] = [px, py];
        if (event.shiftKey) moving = constrainAngle(drag.fixed, moving);
        const line = drag.index === 0 ? lineFromEnds(moving, drag.fixed) : lineFromEnds(drag.fixed, moving);
        setLineDraft({ id: drag.id, line });
        break;
      }
      case "marquee": {
        const box = boxFromPoints(drag.ox, drag.oy, px, py);
        setMarquee(box);
        const hits = slide.elements.filter((element) => intersects(box, boxOf(element))).map((element) => element.id);
        props.onSelect(new Set([...drag.base, ...hits]));
        break;
      }
      case "draw": {
        let b: [number, number] = [px, py];
        if ((drag.tool === "line" || drag.tool === "arrow") && event.shiftKey) b = constrainAngle([drag.ox, drag.oy], b);
        setDrawBox({ tool: drag.tool, box: boxFromPoints(drag.ox, drag.oy, b[0], b[1]), a: [drag.ox, drag.oy], b });
        break;
      }
    }
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (wrapRef.current?.hasPointerCapture(event.pointerId) === true) wrapRef.current.releasePointerCapture(event.pointerId);
    setGuides({ vertical: [], horizontal: [] });
    setMarquee(null);
    if (drag === null) return;
    switch (drag.kind) {
      case "move": {
        if (draft !== null && drag.moved) {
          props.commit(
            updateElements(deck, slide.id, (element) => {
              const box = draft.get(element.id);
              return box === undefined ? element : { ...element, x: box.x, y: box.y };
            }, new Set(draft.keys())),
          );
        }
        setDraft(null);
        break;
      }
      case "resize": {
        const box = draft?.get(drag.id);
        if (box !== undefined) {
          props.commit(updateElements(deck, slide.id, (element) => ({ ...element, ...box }), new Set([drag.id])));
        }
        setDraft(null);
        break;
      }
      case "endpoint": {
        if (lineDraft !== null) {
          props.commit(updateElements(deck, slide.id, (element) => ({ ...element, ...lineDraft.line }), new Set([drag.id])));
        }
        setLineDraft(null);
        break;
      }
      case "draw": {
        const dragged = drawBox !== null && Math.hypot(drawBox.b[0] - drawBox.a[0], drawBox.b[1] - drawBox.a[1]) * scale > 8;
        setDrawBox(null);
        const [px, py] = pointer(event);
        const box = dragged && drawBox !== null ? drawBox.box : { x: px - 0, y: py - 0, w: 0, h: 0 };
        let element: SlideElement;
        if (drag.tool === "line" || drag.tool === "arrow") {
          const a: [number, number] = [drag.ox, drag.oy];
          const b: [number, number] = dragged && drawBox !== null ? drawBox.b : [drag.ox + 320, drag.oy];
          element = { ...(themeNewElement(deck, newDrawnElement(drag.tool, boxFromPoints(a[0], a[1], b[0], b[1]), textColor, true)) as LineElement), ...lineFromEnds(a, b) };
        } else {
          const base = themeNewElement(deck, newDrawnElement(drag.tool, box, textColor, dragged));
          // 点一下插入：以点击处为中心
          element = dragged ? base : { ...base, x: base.x - base.w / 2, y: base.y - base.h / 2 };
        }
        element = clampIntoCanvas(element, canvas);
        props.commit(appendElements(deck, slide.id, [element]));
        props.onSelect(new Set([element.id]));
        props.onToolDone();
        if (element.kind === "text") props.onEditing(element.id);
        break;
      }
      case "marquee":
        break;
    }
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    // 指针被画布捕获后，click / dblclick 的 target 就是画布本身（不是点到的元素）：按坐标现找
    const hit = document
      .elementsFromPoint(event.clientX, event.clientY)
      .find((node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains("sl-el") && !node.classList.contains("se-editing"));
    const id = hit?.dataset["id"];
    if (id === undefined) return;
    const element = byId.get(id);
    if (element === undefined) return;
    if (element.kind === "text" || element.kind === "shape" || element.kind === "table") {
      props.onSelect(new Set([id]));
      props.onEditing(id);
    }
  };

  const onDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    const files = [...event.dataTransfer.files].filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    const [x, y] = pointer(event);
    props.onDropImages(files, { x, y });
  };

  const selectedElements = slide.elements.filter((element) => selection.has(element.id));
  const single = selectedElements.length === 1 && props.editingId === null ? (selectedElements[0] as SlideElement) : null;

  const editingElement = props.editingId === null ? null : (byId.get(props.editingId) ?? null);

  return (
    <div
      ref={wrapRef}
      className="se-canvas"
      data-tool={tool ?? undefined}
      tabIndex={0}
      style={{ width: canvas.w * scale, height: canvas.h * scale, "--se-scale": scale } as React.CSSProperties}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={onDrop}
      aria-label={deck.title}
    >
      <div className="se-canvas-inner" style={{ width: canvas.w, height: canvas.h, transform: `scale(${scale})` }}>
        <section className="sl" style={{ width: canvas.w, height: canvas.h, background: slideBackground(slide, deck) }}>
          {slide.elements.map((element) => {
            const lineOverride = lineDraft !== null && lineDraft.id === element.id ? lineDraft.line : null;
            const shown = lineOverride === null ? element : ({ ...element, ...lineOverride } as SlideElement);
            return (
              <ElementView
                key={element.id}
                element={shown}
                ctx={ctx}
                {...(draft?.get(element.id) === undefined ? {} : { override: draft.get(element.id) as Box })}
                hidden={props.editingId === element.id}
              />
            );
          })}
          {footer !== null && <div className="sl-el se-chrome" style={boxStyle(footer)} dangerouslySetInnerHTML={{ __html: renderElementInner(footer, ctx) }} />}
        </section>

        {/* 选中框与手柄（画布坐标；线宽 / 手柄大小除以缩放，屏幕上恒定） */}
        {selectedElements.map((element) => {
          const box = draft?.get(element.id) ?? boxOf(element);
          if (props.editingId === element.id) return null;
          return (
            <div
              key={element.id}
              className="se-selection"
              data-multi={selectedElements.length > 1 ? "true" : undefined}
              style={{
                left: box.x,
                top: box.y,
                width: box.w,
                height: box.h,
                ...(element.rotate === undefined ? {} : { transform: `rotate(${element.rotate}deg)` }),
              }}
            />
          );
        })}
        {single !== null && single.kind !== "line" &&
          HANDLES.map((handle) => {
            const box = draft?.get(single.id) ?? boxOf(single);
            const hx = handle.includes("w") ? 0 : handle.includes("e") ? 1 : 0.5;
            const hy = handle.includes("n") ? 0 : handle.includes("s") ? 1 : 0.5;
            return (
              <div
                key={handle}
                className="se-handle"
                data-handle={handle}
                data-id={single.id}
                style={{ left: box.x + box.w * hx, top: box.y + box.h * hy }}
              />
            );
          })}
        {single !== null && single.kind === "line" &&
          (() => {
            const shown = lineDraft !== null && lineDraft.id === single.id ? ({ ...single, ...lineDraft.line } as LineElement) : single;
            const ends = lineEnds(shown);
            return ends.map(([x, y], index) => (
              <div key={index} className="se-handle" data-handle={`end${index}`} data-id={single.id} style={{ left: x, top: y }} />
            ));
          })()}

        {guides.vertical.map((x) => (
          <div key={`v${x}`} className="se-guide" data-axis="v" style={{ left: x }} />
        ))}
        {guides.horizontal.map((y) => (
          <div key={`h${y}`} className="se-guide" data-axis="h" style={{ top: y }} />
        ))}
        {marquee !== null && <div className="se-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
        {drawBox !== null && (
          <div className="se-marquee" data-draw="true" style={{ left: drawBox.box.x, top: drawBox.box.y, width: drawBox.box.w, height: drawBox.box.h }} />
        )}

        {editingElement !== null && editingElement.kind === "table" && (
          <TableEditor
            key={editingElement.id}
            element={editingElement}
            scale={scale}
            onDone={(rows) => {
              props.onEditing(null);
              if (rows !== null) props.commit(updateElements(deck, slide.id, (el) => (el.kind === "table" ? { ...el, rows } : el), new Set([editingElement.id])));
            }}
          />
        )}
        {editingElement !== null && editingElement.kind !== "table" && (
          <InlineEditor
            key={editingElement.id}
            element={editingElement}
            ctx={ctx}
            onDone={(patch) => {
              props.onEditing(null);
              if (patch !== null) {
                props.commit(updateElements(deck, slide.id, (el) => ({ ...el, ...patch }) as SlideElement, new Set([editingElement.id])));
              }
            }}
            onEmpty={() => {
              // 新建的文字框什么都没写：不留一个空框
              props.onEditing(null);
              props.commit(removeElements(deck, slide.id, new Set([editingElement.id])));
              props.onSelect(new Set());
            }}
          />
        )}
      </div>
    </div>
  );
}

function clampIntoCanvas(element: SlideElement, canvas: { w: number; h: number }): SlideElement {
  if (element.kind === "line") return element;
  const x = Math.max(0, Math.min(element.x, canvas.w - Math.min(element.w, canvas.w)));
  const y = Math.max(0, Math.min(element.y, canvas.h - Math.min(element.h, canvas.h)));
  return { ...element, x, y };
}

/**
 * 文字 / 形状文字的就地编辑：复用 shared 渲染出的同一份 HTML，把里面的 `.sl-rich`（或形状的文字层）
 * 变成 contentEditable——所见即所得，字体字号换行与最终导出一致。输入法走浏览器原生（没有额外一层
 * 编辑器去抢首字）。粘贴一律转纯文字（不把别处的样式带进来）。失焦 / Esc 提交，内容经 sanitize 再写回。
 */
function InlineEditor(props: {
  element: Exclude<SlideElement, { kind: "table" }>;
  ctx: RenderContext;
  onDone: (patch: Record<string, unknown> | null) => void;
  onEmpty: () => void;
}) {
  const { element } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(false);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const editable = element.kind === "text" ? host.querySelector<HTMLElement>(".sl-rich") : host.querySelector<HTMLElement>(".sl-shape-edit");
    if (editable === null) return;
    editable.contentEditable = "true";
    editable.spellcheck = false;
    editable.focus();
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [element.kind]);

  const finish = (): void => {
    if (doneRef.current) return;
    doneRef.current = true;
    const host = hostRef.current;
    if (host === null) return props.onDone(null);
    if (element.kind === "text") {
      const rich = host.querySelector<HTMLElement>(".sl-rich");
      const html = sanitizeRichHtml(rich?.innerHTML ?? "");
      if (html === "" && element.html === "") return props.onEmpty();
      return props.onDone(html === element.html ? null : { html });
    }
    const field = host.querySelector<HTMLElement>(".sl-shape-edit");
    const text = (field?.innerText ?? "").replace(/\n+$/, "");
    const before = element.kind === "shape" ? (element.text ?? "") : "";
    props.onDone(text === before ? null : { text });
  };

  const inner =
    element.kind === "shape"
      ? `<div class="sl-shape-text sl-shape-edit" style="font-size:${element.fontSize}px;color:${element.color}">${escapeText(element.text ?? "")}</div>`
      : null;

  return (
    <div
      ref={hostRef}
      className="sl-el se-editing"
      data-editing="true"
      style={{
        left: element.x,
        top: element.y,
        width: element.w,
        height: element.h,
        ...(element.rotate === undefined ? {} : { transform: `rotate(${element.rotate}deg)` }),
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) finish();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          // 这一下 Esc 只结束编辑；不让它冒到 App 的「Esc 关右栏」
          event.preventDefault();
          event.stopPropagation();
          finish();
        }
      }}
      onPaste={(event) => {
        event.preventDefault();
        const text = event.clipboardData.getData("text/plain");
        if (text !== "") document.execCommand("insertText", false, text);
      }}
      dangerouslySetInnerHTML={{
        __html: inner === null ? textOnlyHtml(element, props.ctx) : `${shapeUnder(element, props.ctx)}${inner}`,
      }}
    />
  );
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function textOnlyHtml(element: SlideElement, ctx: RenderContext): string {
  return renderElementInner(element, ctx);
}

/** 形状本体（不含文字）：编辑形状文字时底下仍然画着形状 */
function shapeUnder(element: SlideElement, ctx: RenderContext): string {
  if (element.kind !== "shape") return "";
  const { text: _text, ...bare } = element;
  return renderElementInner(bare, ctx);
}
