import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { FilePreview, WebThumb } from "@shared/files";
import { Icon } from "../../shell/Icon";
import { FileTypeIcon } from "../../shell/FileTypeIcon";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { BoardThumb } from "../board/BoardThumb.tsx";
import { MarkdownBlock } from "../chat/MarkdownBlock";
import { readChatFile, readChatPdf, readChatWebThumb, type ChatFileScope } from "../chat/chat-file-scope.ts";
import { SLIDE_CSS } from "../../../../shared/slides-render.ts";
import { SlideStatic } from "../slides-editor/ElementView";
import { parseDeckSafe } from "../slides-editor/use-deck-editor.ts";
import type { StatusOutput } from "./chat-status.ts";
import { createThumbCache } from "./thumb-cache.ts";
// 静态页的外框样式（.se-static）在编辑器的样式表里：编辑器没打开过时它不在页面上
import "../slides-editor/slides-editor.css";

// 同 PdfView：pdf.js 的解析跑在 worker 里
GlobalWorkerOptions.workerSrc = workerUrl;

/** 文档缩略图：按这个倍数缩小渲染正文（开头一屏看得出是哪份） */
const DOC_SCALE = 0.7;

/**
 * 状态面板产物行里的一张大缩略图（用户 2026-11-22：「我想找汇报 PPT，看名字我又不知道里面内容是啥，我需要看到预览图」）。
 * 每种类型怎么画：演示文稿 = 第一页（SlideStatic，与缩略条同一份渲染）；文档 = MarkdownBlock 渲染开头再缩小；
 * 图片 = 原图（contain）；网页 = 主进程隐藏窗口真跑起来截的一张图（fs:web-thumb；renderer 里不放能跑脚本的 iframe）；PDF = pdf.js 画第一页；
 * 视频 / PPTX / Word / 看板 / 画布 = 画不出来，大图标卡（视频：renderer 的 CSP 不放行本地媒体地址，取不到首帧）。
 * 读文件走文件面板同一道白名单（readChatFile / readChatPdf）；读不到也落成图标卡。
 */
type ThumbData = FilePreview | Uint8Array | WebThumb | null;

/** 跨挂载缓存：切回会话时第一帧就用上次读到的，后台再校验（见 thumb-cache.ts） */
const thumbCache = createThumbCache<ThumbData>();
/** PDF 字节大的不进缓存（几十 MB 常驻内存不值） */
const PDF_CACHE_LIMIT = 3 * 1024 * 1024;

function stampOf(data: ThumbData): number {
  if (data === null) return -1;
  if (data instanceof Uint8Array) return data.byteLength;
  return data.modifiedAt;
}

function readThumbData(kind: StatusOutput["kind"], scope: ChatFileScope, path: string): Promise<ThumbData> {
  if (kind === "pdf") return readChatPdf(scope, path);
  if (kind === "web") return readChatWebThumb(scope, path);
  return readChatFile(scope, path);
}

export function OutputThumb(props: { output: StatusOutput; scope: ChatFileScope }) {
  const { output } = props;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const width = useBoxWidth(boxRef);
  const renderable = output.kind === "slides" || output.kind === "doc" || output.kind === "web" || output.kind === "image" || output.kind === "pdf";
  const cacheKey = thumbCache.key(props.scope.sessionId, output.path);
  const [data, setData] = useState<ThumbData | undefined>(() => (renderable ? thumbCache.get(cacheKey)?.data : null));
  useEffect(() => {
    if (!renderable) return undefined;
    let alive = true;
    // 路径变了（同一格复用）先换成这条路径缓存里的（没有就回到「读取中」）
    const cached = thumbCache.get(cacheKey);
    setData(cached?.data);
    void readThumbData(output.kind, props.scope, output.path).then((value) => {
      if (!alive) return;
      const stamp = stampOf(value);
      // 读不到（null）不覆盖缓存里的好图：网页截图超时之类偶发失败，不该把已有的缩略图换成图标
      if (value === null && cached !== undefined && cached.data !== null) return;
      if (!thumbCache.changed(cached, stamp)) return;
      if (!(value instanceof Uint8Array) || value.byteLength <= PDF_CACHE_LIMIT) thumbCache.set(cacheKey, { data: value, stamp });
      setData(value);
    });
    return () => {
      alive = false;
    };
  }, [output.path, cacheKey]);
  let body: React.ReactNode = null;
  if (data === undefined || width === 0) body = null;
  else if (data instanceof Uint8Array) body = <PdfFirstPage data={data} width={width} />;
  else if (data !== null && "mime" in data && data.mime === "image/jpeg" && !("kind" in data)) body = <img className="cs-thumb-img cs-thumb-shot" alt="" src={`data:${data.mime};base64,${data.base64}`} />;
  else if (data !== null && "kind" in data && data.kind === "image") body = <img className="cs-thumb-img" alt="" src={`data:${data.mime};base64,${data.base64}`} />;
  else if (data !== null && "kind" in data && data.kind === "text" && output.kind === "slides") body = <DeckFirstPage text={data.text} width={width} />;
  else if (data !== null && "kind" in data && data.kind === "text" && output.kind === "doc") body = <DocHead text={data.text} width={width} />;
  else body = <IconCard output={output} />;
  return (
    <div className="cs-thumb-box" ref={boxRef} data-kind={output.kind} data-loading={data === undefined || undefined}>
      {body}
    </div>
  );
}

function useBoxWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return undefined;
    const measure = () => setWidth((prev) => {
      const next = Math.floor(node.clientWidth);
      return Math.abs(prev - next) >= 2 ? next : prev;
    });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return width;
}

function IconCard(props: { output: StatusOutput }) {
  const { output } = props;
  return (
    <div className="cs-thumb-icon">
      {output.kind === "board" ? (
        output.boardCall === null ? <Icon name={FEATURE_ICON.board} size={32} strokeWidth={1.4} /> : <BoardThumb call={output.boardCall} />
      ) : (
        <FileTypeIcon name={output.path.split(/[\\/]/).pop() ?? ""} size={40} />
      )}
    </div>
  );
}

function DeckFirstPage(props: { text: string; width: number }) {
  const deck = useMemo(() => parseDeckSafe(props.text).deck, [props.text]);
  const first = deck.slides[0];
  if (first === undefined) return null;
  return <SlideStatic slide={first} aspect={deck.aspect} ctx={{ deck, imageUrl: () => null }} width={props.width} index={0} />;
}

/**
 * 幻灯片页内的版式（.sl 及其元素）是编辑器渲染时用一个 <style> 带进来的（SlidesEditor 里同一份 SLIDE_CSS）：
 * 编辑器没打开时页面上没有它，缩略图会排成一团（第一版的预览浮层同样中招）。产物里有演示文稿时挂一份。
 */
export function SlideStyles() {
  return <style>{SLIDE_CSS}</style>;
}

function DocHead(props: { text: string; width: number }) {
  // 只渲染开头一段：缩略图里看得见的不过十来行，整份交给 MarkdownBlock 是白花工夫
  const head = useMemo(() => props.text.split("\n").slice(0, 40).join("\n"), [props.text]);
  return (
    <div className="cs-thumb-doc" style={{ width: props.width / DOC_SCALE, transform: `scale(${DOC_SCALE})` }}>
      <MarkdownBlock text={head} />
    </div>
  );
}

function PdfFirstPage(props: { data: Uint8Array; width: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    // pdf.js 会把传进去的 buffer 转给 worker：给它一份拷贝，原件留着宽度变了重画
    const loading = getDocument({ data: props.data.slice() });
    void (async () => {
      try {
        const doc = await loading.promise;
        const page = await doc.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: props.width / base.width });
        const canvas = ref.current;
        if (!alive || canvas === null) return;
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        await page.render({ canvas, viewport, ...(ratio === 1 ? {} : { transform: [ratio, 0, 0, ratio, 0, 0] }) }).promise;
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
      void loading.destroy();
    };
  }, [props.data, props.width]);
  if (failed) return null;
  return <canvas ref={ref} className="cs-thumb-pdf" />;
}
