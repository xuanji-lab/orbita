import { useEffect, useRef, useState } from "react";
import { Icon } from "../../shell/Icon";
import { PanelButton, PanelLine } from "../../shell/RightPanel";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import { formatSize } from "../files/tree-view";
import type { FileListRequest } from "@shared/files";
import { PPTX_SLIDE_TEXT_LIMIT, type PptxParagraph, type PptxPreview, type PptxSlide } from "@shared/pptx";

/**
 * `.pptx` 只读大纲（契约在 `shared/pptx.ts`）。
 *
 * **不画幻灯片**：没有可靠的纯 JS 渲染器，照 HTML 硬画一版（版式错、字体错、图没有）
 * 用户会以为原文件坏了。这里只回答「这份演示文稿有哪几页、每页讲了什么」：左边页列表
 * （第 N 页 · 版式名），右边该页的大纲（标题 / 多级要点 / 表格 / 备注）。真正的排版
 * 交给 PowerPoint / WPS —— 顶部那个「用默认应用打开」。
 *
 * 没有任何编辑入口：主进程那条通道只有读，这里也没有输入控件。
 */
export function PptxView(props: {
  request: FileListRequest;
  /** 面板头部的刷新按钮：同一个文件重读（agent 可能刚改过它） */
  reloadToken: number;
  /** 用系统默认应用打开（与空态那个按钮同一个动作，由 FilePreviewPane 给） */
  onOpenDefault: () => void;
}) {
  const t = useT();
  const { request } = props;
  const state = usePptxPreview(request, props.reloadToken);
  const [active, setActive] = useState(0);

  // 换文件：回到第一页（页号对另一份演示文稿没有意义）
  useEffect(() => setActive(0), [request.root, request.dir]);

  if (state.status === "loading") {
    return (
      <div className="file-preview-loading">
        <Icon name="loader-circle" size={14} spin />
        {t.common.loading}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="file-preview-error">
        <PanelLine danger>{state.message}</PanelLine>
      </div>
    );
  }

  const data = state.data;
  if (data.kind === "too-large") {
    return (
      <div className="file-preview-empty">
        <Icon name="presentation" size={24} style={{ color: "var(--color-text-tertiary)" }} />
        <PanelLine>{t.files.tooLarge(formatSize(data.size), formatSize(data.limit))}</PanelLine>
        <OpenDefaultButton onClick={props.onOpenDefault} />
      </div>
    );
  }
  if (data.kind === "unreadable") {
    return (
      <div className="file-preview-empty">
        <Icon name="presentation" size={24} style={{ color: "var(--color-text-tertiary)" }} />
        <PanelLine>{data.reason === "password" ? t.files.pptxPassword : t.files.pptxBroken}</PanelLine>
        {/* 技术副行：解压 / 解析失败的原文，读得懂的人据此判断是不是文件本身坏了 */}
        <p className="pptx-detail" title={data.detail}>
          {data.detail}
        </p>
        <OpenDefaultButton onClick={props.onOpenDefault} />
      </div>
    );
  }
  if (data.slides.length === 0) {
    return (
      <div className="file-preview-empty">
        <Icon name="presentation" size={24} style={{ color: "var(--color-text-tertiary)" }} />
        <PanelLine>{t.files.pptxEmpty}</PanelLine>
        <OpenDefaultButton onClick={props.onOpenDefault} />
      </div>
    );
  }

  const index = Math.min(active, data.slides.length - 1);
  const slide = data.slides[index];
  if (slide === undefined) return null;

  return (
    <div className="pptx-view">
      <div className="pptx-toolbar">
        <span className="pptx-toolbar-title">
          {t.files.pptxSlides}
          <span className="pptx-count">{data.slideCount}</span>
        </span>
        <div className="pptx-toolbar-actions">
          <PanelButton onClick={props.onOpenDefault}>
            <Icon name="external-link" size={14} />
            {t.files.openDefault}
          </PanelButton>
        </div>
      </div>
      <div className="pptx-split">
        {/* 页列表：页码 + 版式名是定位用的坐标，标题是「这页在讲什么」 */}
        <nav className="pptx-slide-list" aria-label={t.files.pptxSlides}>
          {data.slides.map((item, itemIndex) => (
            <button
              key={`${item.number}:${itemIndex}`}
              type="button"
              className="option-row pptx-slide-row"
              aria-pressed={itemIndex === index}
              onClick={() => setActive(itemIndex)}
            >
              <span className="pptx-slide-label">{t.files.pptxSlideLabel(item.number, item.layoutName)}</span>
              <span className="pptx-slide-title">{item.title === "" ? t.files.pptxUntitled : item.title}</span>
            </button>
          ))}
        </nav>
        <section className="pptx-outline" aria-label={t.files.pptxOutline}>
          <h2 className="pptx-outline-title">
            {slide.title === "" ? t.files.pptxUntitled : slide.title}
          </h2>
          <OutlineBody slide={slide} />
          {slide.pictureCount > 0 && (
            <p className="pptx-note">
              <Icon name="image" size={12} />
              {t.files.pptxPictures(slide.pictureCount)}
            </p>
          )}
          {slide.truncated && (
            <p className="pptx-note">
              <Icon name="info" size={12} />
              {t.files.pptxTextTruncated(PPTX_SLIDE_TEXT_LIMIT)}
            </p>
          )}
        </section>
      </div>
      <div className="pptx-footer">
        <span className="pptx-notice">
          <Icon name="lock" size={11} />
          {t.files.pptxReadOnly}
        </span>
        {data.truncated && (
          <span className="pptx-notice">
            {t.files.pptxDeckTruncated(data.slides.length, data.slideCount)}
          </span>
        )}
      </div>
    </div>
  );
}

function OpenDefaultButton(props: { onClick: () => void }) {
  const t = useT();
  return (
    <PanelButton onClick={props.onClick}>
      <Icon name="external-link" size={14} />
      {t.files.openDefault}
    </PanelButton>
  );
}

/**
 * 正文 / 表格 / 备注三个分区。要点按 `level` 缩进（PowerPoint 的九级），项目符号
 * 由 `bullet` 决定——**不替原稿补符号**：纯文本框里的段落本来就没有点。
 */
function OutlineBody(props: { slide: PptxSlide }) {
  const t = useT();
  const { slide } = props;
  const empty =
    slide.title === "" && slide.body.length === 0 && slide.tables.length === 0 && slide.notes === "";
  return (
    <>
      {slide.body.length > 0 && (
        <div className="pptx-body">
          {slide.body.map((paragraph, index) => (
            <BodyLine key={index} paragraph={paragraph} />
          ))}
        </div>
      )}
      {slide.tables.map((table, tableIndex) => (
        <section className="pptx-section" key={tableIndex}>
          <h3 className="pptx-section-label">
            <Icon name="layout-grid" size={12} />
            {t.files.pptxTables}
          </h3>
          <div className="pptx-table-wrap">
            <table className="pptx-table">
              <tbody>
                {table.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      {slide.notes !== "" && (
        <section className="pptx-section">
          <h3 className="pptx-section-label">
            <Icon name="notebook-pen" size={12} />
            {t.files.pptxNotes}
          </h3>
          <p className="pptx-notes">{slide.notes}</p>
        </section>
      )}
      {empty && <p className="pptx-empty-line">{t.files.pptxEmptySlide}</p>}
    </>
  );
}

function BodyLine(props: { paragraph: PptxParagraph }) {
  const { paragraph } = props;
  return (
    <div
      className="pptx-line"
      data-level={paragraph.level}
      style={paragraph.level === 0 ? undefined : { paddingLeft: `${paragraph.level * 16}px` }}
    >
      {paragraph.bullet && <span className="pptx-bullet" aria-hidden="true" />}
      <span className="pptx-line-text">{paragraph.text}</span>
    </div>
  );
}

type PptxState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: PptxPreview };

const failMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * 预览的数据半边：文件 / 刷新 token 变就重拉。竞态按 token 丢弃过期响应——切换两个
 * 文件时，先发的晚回也不会盖掉后发的结果。
 */
function usePptxPreview(request: FileListRequest, reloadToken: number): PptxState {
  const [state, setState] = useState<PptxState>({ status: "loading" });
  const token = useRef(0);
  const { sessionId, workspaceId, extraWorkspaceId, root, dir } = request;
  const extra = extraWorkspaceId ?? null;
  useEffect(() => {
    const id = ++token.current;
    setState({ status: "loading" });
    api.files
      .readPptx({ sessionId, workspaceId, ...(extra === null ? {} : { extraWorkspaceId: extra }), root, dir })
      .then((data) => {
        if (token.current === id) setState({ status: "ready", data });
      })
      .catch((cause: unknown) => {
        if (token.current === id) setState({ status: "error", message: failMessage(cause) });
      });
  }, [sessionId, workspaceId, extra, root, dir, reloadToken]);
  return state;
}
