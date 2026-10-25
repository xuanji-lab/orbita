import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../shell/Icon";
import { Chip } from "../../shell/Chip";
import { PanelButton, PanelLine } from "../../shell/RightPanel";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import { formatSize } from "../files/tree-view";
import { xlsxColumnLabel, xlsxColumnWidths, xlsxGridRows, type XlsxGridSlot } from "./xlsx-grid.ts";
import type { FileListRequest } from "@shared/files";
import type { XlsxPreview, XlsxSheet } from "@shared/xlsx";

/**
 * `.xlsx` 只读预览（契约在 `shared/xlsx.ts`）。
 *
 * **不画 Excel**：列宽、字体、底色、条件格式读不全，照 HTML 表画出来用户会以为原文件
 * 坏了。这里只给「结构化数据预览 + 用默认应用打开」：多表用标签切、列头 A/B/C、行号
 * 从 1 起、数值右对齐等宽、合并区按跨行跨列画成一个格、公式显示缓存值（原文进 tooltip）、
 * 底部如实写「只显示前 2000 行 × 50 列」。冻结窗格**只作提示**——预览不冻结滚动。
 *
 * 没有任何编辑入口：主进程那条通道只有读，这里也没有输入控件。
 */
export function XlsxView(props: {
  request: FileListRequest;
  /** 面板头部的刷新按钮：同一个文件重读（agent 可能刚改过它） */
  reloadToken: number;
  /** 用系统默认应用打开（与空态那个按钮同一个动作，由 FilePreviewPane 给） */
  onOpenDefault: () => void;
}) {
  const t = useT();
  const { request } = props;
  const [sheet, setSheet] = useState(0);
  // 换文件：回到第一张表（与 FilePreviewPane 的「换文件一律先看 Rendered」同一理由）
  useEffect(() => setSheet(0), [request.root, request.dir]);
  const state = useXlsxPreview(request, sheet, props.reloadToken);

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
        <Icon name="file-spreadsheet" size={24} style={{ color: "var(--color-text-tertiary)" }} />
        <PanelLine>{t.files.tooLarge(formatSize(data.size), formatSize(data.limit))}</PanelLine>
        <OpenDefaultButton onClick={props.onOpenDefault} />
      </div>
    );
  }
  if (data.kind === "unreadable") {
    return (
      <div className="file-preview-empty">
        <Icon name="file-spreadsheet" size={24} style={{ color: "var(--color-text-tertiary)" }} />
        <PanelLine>{data.reason === "password" ? t.files.xlsxPassword : t.files.xlsxBroken}</PanelLine>
        {/* 技术副行：解压 / 解析失败的原文，读得懂的人据此判断是不是文件本身坏了 */}
        <p className="xlsx-detail" title={data.detail}>
          {data.detail}
        </p>
        <OpenDefaultButton onClick={props.onOpenDefault} />
      </div>
    );
  }

  return (
    <div className="xlsx-view">
      <div className="xlsx-toolbar">
        {data.sheets.length > 1 && (
          <div className="xlsx-sheets" role="tablist" aria-label={t.files.xlsxSheets}>
            {data.sheets.map((tab, index) => (
              <Chip
                key={`${index}:${tab.name}`}
                active={index === data.active}
                title={tab.name}
                onClick={() => setSheet(index)}
              >
                {tab.name}
              </Chip>
            ))}
          </div>
        )}
        <div className="xlsx-toolbar-actions">
          <PanelButton onClick={props.onOpenDefault}>
            <Icon name="external-link" size={14} />
            {t.files.openDefault}
          </PanelButton>
        </div>
      </div>
      <XlsxGrid sheet={data.sheet} />
      <XlsxFooter sheet={data.sheet} />
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

/** 行高：与 styles.css 的 `--xlsx-row-height` 成对改（TS 算滚动窗口，CSS 定行高） */
const ROW_HEIGHT = 24;
/** 可见区上下各多画这么多行：快速滚动时不留白，重排的开销仍是一小段 */
const OVERSCAN = 12;
/** 首屏先画这么多行（还没量到面板高度前的估计值；量到后立刻校正） */
const FIRST_PAINT_ROWS = 40;

/**
 * 数据网格。行号 + 列标让用户能对着原文件定位（「B17 那格」）；合并区按跨行跨列画成
 * 一个格——被盖住的格子在主进程里已经是 null，这里再由 xlsxGridRows 标成 covered 不画，
 * 否则同一段文字会出现两遍。`title` 带公式原文：数值是缓存值，公式才是文件里写的东西。
 *
 * **只画可见的几十行**（窗口化）：2000 行 × 50 列 = 10 万个 <td>，实测在 Chromium 里
 * 建 DOM + 首帧要好几秒（这就是「打开大表卡死」的根因），而预览面板一屏只看得见 ~30 行。
 * 上下各多画 OVERSCAN 行避免滚动时露白；没画的行用两根占位行把总高度撑住，滚动条长度
 * 与滚动位置都与整张表一致。列宽走 colgroup + `table-layout: fixed`：固定列宽后换窗口
 * 不必重算整表宽度（auto 布局下的重排会把首帧那笔账再付一遍）。
 */

function XlsxGrid(props: { sheet: XlsxSheet }) {
  const t = useT();
  const columns = props.sheet.rows[0]?.length ?? 0;
  const total = props.sheet.rows.length;
  const labels = useMemo(
    () => Array.from({ length: columns }, (_, index) => xlsxColumnLabel(index)),
    [columns],
  );
  // 列宽按数据估（见 xlsxColumnWidths）：固定列宽既让 50 列的表挤得下，也让换窗口
  // 不必重算整表宽度
  const widths = useMemo(() => xlsxColumnWidths(props.sheet), [props.sheet]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [rowWindow, setRowWindow] = useState({ start: 0, end: Math.min(total, FIRST_PAINT_ROWS + OVERSCAN * 2) });

  const updateWindow = useCallback(() => {
    const node = scrollRef.current;
    if (node === null) return;
    const visible = Math.max(1, Math.ceil(node.clientHeight / ROW_HEIGHT));
    const first = Math.max(0, Math.floor(node.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(total, first + visible + OVERSCAN * 2);
    setRowWindow((prev) => (prev.start === first && prev.end === last ? prev : { start: first, end: last }));
  }, [total]);

  // 换表：滚动回左上角，窗口回到开头（上一张表滚到的位置对这张表没有意义）
  useEffect(() => {
    const node = scrollRef.current;
    if (node !== null) node.scrollTo({ top: 0, left: 0 });
    setRowWindow({ start: 0, end: Math.min(total, FIRST_PAINT_ROWS + OVERSCAN * 2) });
    updateWindow();
  }, [props.sheet, total, updateWindow]);

  // 面板拖宽 / 拖窄：可见行数变了，窗口跟着重算
  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    const observer = new ResizeObserver(updateWindow);
    observer.observe(node);
    return () => observer.disconnect();
  }, [updateWindow]);

  const rows = useMemo(
    () => xlsxGridRows(props.sheet, rowWindow.start, rowWindow.end),
    [props.sheet, rowWindow.start, rowWindow.end],
  );

  if (columns === 0 || total === 0) {
    return (
      <div className="xlsx-empty">
        <PanelLine>{t.files.xlsxEmpty}</PanelLine>
      </div>
    );
  }

  return (
    <div className="xlsx-scroll" ref={scrollRef} onScroll={updateWindow}>
      <table className="xlsx-table">
        <colgroup>
          <col style={{ width: "var(--xlsx-gutter-width)" }} />
          {labels.map((_, index) => (
            <col key={index} style={{ width: widths[index] ?? 64 }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="xlsx-gutter" scope="col" />
            {labels.map((label, index) => (
              <th key={index} className="xlsx-colhead" scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowWindow.start > 0 && <SpacerRow rows={rowWindow.start} span={labels.length + 1} />}
          {rows.map((slots, index) => (
            <tr key={rowWindow.start + index}>
              <th className="xlsx-gutter" scope="row">
                {rowWindow.start + index + 1}
              </th>
              {slots.map((slot, colIndex) => (
                <GridCell key={colIndex} slot={slot} firstRenderedRow={rowWindow.start} />
              ))}
            </tr>
          ))}
          {rowWindow.end < total && <SpacerRow rows={total - rowWindow.end} span={labels.length + 1} />}
        </tbody>
      </table>
    </div>
  );
}

/** 占位行：把没画的那些行的高度撑起来，滚动条长度与真实表一致。不带边框、不响应指针 */
function SpacerRow(props: { rows: number; span: number }) {
  return (
    <tr className="xlsx-spacer" aria-hidden="true">
      <td colSpan={props.span} style={{ height: props.rows * ROW_HEIGHT }} />
    </tr>
  );
}

function GridCell(props: { slot: XlsxGridSlot; firstRenderedRow: number }) {
  const slot = props.slot;
  if (slot.kind === "covered") {
    // 锚点在本段里：整格不画，位置由锚点那格的 colSpan / rowSpan 占掉
    if (slot.anchorRow >= props.firstRenderedRow) return null;
    // 合并区跨过了窗口上边界（锚点在上方没画）：画个空格子占位，否则这一行会左移
    return <td className="xlsx-cell" />;
  }
  if (slot.kind === "empty") return <td className="xlsx-cell" />;
  const cell = slot.cell;
  return (
    <td
      className="xlsx-cell"
      // 数值右对齐 + 等宽数字；错误值是坏掉的公式，用危险色（颜色是第二信号，文字本身已经写着 #DIV/0!）
      data-num={cell.numeric === true ? "true" : undefined}
      data-error={cell.error === true ? "true" : undefined}
      // 公式原文走 tooltip：格子里显示的是缓存值，与 Excel 打开时一致
      data-formula={cell.formula === undefined ? undefined : "true"}
      title={cell.formula === undefined ? cell.text : `=${cell.formula}`}
      colSpan={slot.colSpan === 1 ? undefined : slot.colSpan}
      rowSpan={slot.rowSpan === 1 ? undefined : slot.rowSpan}
    >
      <span className="xlsx-cell-text">{cell.text}</span>
    </td>
  );
}

/**
 * 底部提示条：裁剪（只给了前 N 行 × M 列）+ 冻结窗格（原文件冻了，这里不冻）。
 * 两件事都是「与你看到的原文件不一样」的地方，必须显式说出来——不说，用户会以为
 * 预览少读了数据 / 滚动不对劲。
 */
function XlsxFooter(props: { sheet: XlsxSheet }) {
  const t = useT();
  const shownRows = props.sheet.rows.length;
  const shownCols = props.sheet.rows[0]?.length ?? 0;
  const truncated = props.sheet.rowCount > shownRows || props.sheet.colCount > shownCols;
  const frozen = props.sheet.frozen;
  const frozenRows = Math.min(frozen.rows, shownRows);
  const frozenCols = Math.min(frozen.cols, shownCols);
  return (
    <div className="xlsx-footer">
      {truncated && (
        <span className="xlsx-notice">
          {t.files.xlsxTruncated(shownRows, shownCols, props.sheet.rowCount, props.sheet.colCount)}
        </span>
      )}
      {frozenRows > 0 || frozenCols > 0 ? (
        <span className="xlsx-notice">
          <Icon name="lock" size={11} />
          {t.files.xlsxFrozen(frozenRows, frozenCols)}
        </span>
      ) : null}
    </div>
  );
}

type XlsxState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: XlsxPreview };

const failMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * 预览的数据半边：文件 / 表号 / 刷新 token 变就重拉。竞态按 token 丢弃过期响应——
 * 快速连点工作表标签时，后发的先回也只有它落账。
 */
function useXlsxPreview(request: FileListRequest, sheet: number, reloadToken: number): XlsxState {
  const [state, setState] = useState<XlsxState>({ status: "loading" });
  const token = useRef(0);
  const { sessionId, workspaceId, extraWorkspaceId, root, dir } = request;
  const extra = extraWorkspaceId ?? null;
  useEffect(() => {
    const id = ++token.current;
    setState({ status: "loading" });
    api.files
      .readXlsx({ sessionId, workspaceId, ...(extra === null ? {} : { extraWorkspaceId: extra }), root, dir, sheet })
      .then((data) => {
        if (token.current === id) setState({ status: "ready", data });
      })
      .catch((cause: unknown) => {
        if (token.current === id) setState({ status: "error", message: failMessage(cause) });
      });
  }, [sessionId, workspaceId, extra, root, dir, sheet, reloadToken]);
  return state;
}
