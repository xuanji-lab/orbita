import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { FilePreview } from "@shared/files";
import { Icon } from "../../shell/Icon";
import { FileTypeIcon } from "../../shell/FileTypeIcon";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { MarkdownBlock } from "../chat/MarkdownBlock";
import { readChatFile, readChatPdf, type ChatFileScope } from "../chat/chat-file-scope.ts";
import { SLIDE_CSS } from "../../../../shared/slides-render.ts";
import { SlideStatic } from "../slides-editor/ElementView";
import { parseDeckSafe } from "../slides-editor/use-deck-editor.ts";
import type { StatusOutput } from "./chat-status.ts";
// 静态页的外框样式（.se-static）在编辑器的样式表里：编辑器没打开过时它不在页面上
import "../slides-editor/slides-editor.css";

// 同 PdfView：pdf.js 的解析跑在 worker 里
GlobalWorkerOptions.workerSrc = workerUrl;

/** 网页缩略图按这个视口宽排版再整体缩小（像一张桌面浏览器的截图） */
const WEB_VIEWPORT = 1280;
/** 文档缩略图：按这个倍数缩小渲染正文（开头一屏看得出是哪份） */
const DOC_SCALE = 0.7;

/**
 * 状态面板产物行里的一张大缩略图（用户 2026-11-22：「我想找汇报 PPT，看名字我又不知道里面内容是啥，我需要看到预览图」）。
 * 每种类型怎么画：演示文稿 = 第一页（SlideStatic，与缩略条同一份渲染）；文档 = MarkdownBlock 渲染开头再缩小；
 * 图片 = 原图（contain）；网页 = 沙箱 iframe（不跑脚本）按 1280 宽排版后缩小；PDF = pdf.js 画第一页；
 * 视频 / PPTX / Word / 看板 / 画布 = 画不出来，大图标卡（视频：renderer 的 CSP 不放行本地媒体地址，取不到首帧）。
 * 读文件走文件面板同一道白名单（readChatFile / readChatPdf）；读不到也落成图标卡。
 */
export function OutputThumb(props: { output: StatusOutput; scope: ChatFileScope }) {
  const { output } = props;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const width = useBoxWidth(boxRef);
  const renderable = output.kind === "slides" || output.kind === "doc" || output.kind === "web" || output.kind === "image" || output.kind === "pdf";
  const [data, setData] = useState<FilePreview | Uint8Array | null | undefined>(renderable ? undefined : null);
  useEffect(() => {
    if (!renderable) return undefined;
    let alive = true;
    const read = output.kind === "pdf" ? readChatPdf(props.scope, output.path) : readChatFile(props.scope, output.path);
    void read.then((value) => {
      if (alive) setData(value);
    });
    return () => {
      alive = false;
    };
  }, [output.path]);
  let body: React.ReactNode = null;
  if (data === undefined || width === 0) body = null;
  else if (data instanceof Uint8Array) body = <PdfFirstPage data={data} width={width} />;
  else if (data !== null && data.kind === "image") body = <img className="cs-thumb-img" alt="" src={`data:${data.mime};base64,${data.base64}`} />;
  else if (data !== null && data.kind === "text" && output.kind === "slides") body = <DeckFirstPage text={data.text} width={width} />;
  else if (data !== null && data.kind === "text" && output.kind === "doc") body = <DocHead text={data.text} width={width} />;
  else if (data !== null && data.kind === "text" && output.kind === "web") body = <WebShot html={data.text} width={width} />;
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
        <Icon name={FEATURE_ICON.board} size={32} strokeWidth={1.4} />
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

function WebShot(props: { html: string; width: number }) {
  const scale = props.width / WEB_VIEWPORT;
  return (
    <iframe
      className="cs-thumb-web"
      title=""
      tabIndex={-1}
      aria-hidden
      // 空 sandbox：不跑脚本、不提交表单、不导航——只排版成一张「截图」
      sandbox=""
      srcDoc={props.html}
      style={{ width: WEB_VIEWPORT, height: WEB_VIEWPORT / 1.6, transform: `scale(${scale})` }}
    />
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
