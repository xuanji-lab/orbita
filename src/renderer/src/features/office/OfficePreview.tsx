import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../shell/Icon";
import { Chip } from "../../shell/Chip";
import { PanelButton, PanelLine } from "../../shell/RightPanel";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import type { FileListRequest } from "@shared/files";
import {
  officeDisplayPath,
  xlsxRangePath,
  type OfficeChanges,
  type OfficeFormat,
  type OfficeRenderResult,
  type OfficeStatus,
} from "@shared/office";
import type { TextQuote } from "@shared/quote";
import { officeDocumentHtml, officeValuePreview } from "./office-frame.ts";

/**
 * Office 指哪打哪的预览体：OfficeCLI 的 HTML 进 sandbox iframe，点带 `[data-path]` 的元素
 * 出标注 chip，chip 一点就把「哪份文件的哪个节点」放进输入框（TextQuote 的 office 字段）。
 *
 * **iframe 里跑不了任何脚本**：`sandbox="allow-same-origin"`（不给 allow-scripts），
 * 注入前的 HTML 已删掉脚本与 `on*=` 属性并加了 `default-src 'none'` 的 CSP；父窗口
 * 仍能读 `contentDocument` 挂监听（同源），所以切换工作表、缩放、点击标注都由我们自己
 * 的代码做，不信任文件里的任何一段代码。
 *
 * 单元格区间：点第一格记锚点，Shift + 点另一格 → `Sheet1!B2:D5`（同一张表才成立）。
 */
export function OfficePreview(props: {
  request: FileListRequest;
  format: OfficeFormat;
  reloadToken: number;
  /** 引用进输入框；缺席 = 不出标注 chip（例如没有聊天面的场景） */
  onQuote?: (quote: TextQuote) => void;
  /** 渲染失败 / 不可用时的出口：外层切回数据网格 / 大纲 */
  onFallback?: () => void;
}) {
  const t = useT();
  const { request, format } = props;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(720);
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: Extract<OfficeRenderResult, { kind: "html" }> } | { status: "unavailable"; detail: string }>(
    { status: "loading" },
  );
  const [picked, setPicked] = useState<{ path: string; preview: string } | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [captured, setCaptured] = useState<"idle" | "ok" | "fail">("idle");
  /** agent 改完这份文件（office:changed）→ 自增，重拉 HTML 与改动清单 */
  const [externalReload, setExternalReload] = useState(0);
  const token = useRef(0);

  // 面板宽高变了要重算 pptx 的缩放：量外层容器，不量 iframe（iframe 宽度跟着容器走）
  useEffect(() => {
    const node = shellRef.current;
    if (node === null) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(240, Math.round(node.clientWidth))));
    observer.observe(node);
    setWidth(Math.max(240, Math.round(node.clientWidth)));
    return () => observer.disconnect();
  }, []);

  // 渲染数据：文件 / 刷新 token 变就重拉（竞态按 token 丢弃过期响应）
  useEffect(() => {
    const id = ++token.current;
    setState({ status: "loading" });
    setPicked(null);
    setAnchor(null);
    api.office
      .render(request)
      .then((result) => {
        if (token.current !== id) return;
        setState(result.kind === "html" ? { status: "ready", data: result } : { status: "unavailable", detail: result.detail });
      })
      .catch((cause: unknown) => {
        if (token.current !== id) return;
        setState({ status: "error", message: cause instanceof Error ? cause.message : String(cause) });
      });
    // request 是每次渲染新建的对象，按它的字段列依赖（同 XlsxView 的写法）
  }, [request.sessionId, request.workspaceId, request.extraWorkspaceId, request.root, request.dir, props.reloadToken, externalReload]);

  // agent 改了这份文件（主进程广播）：自动重渲染，用户不用手动点刷新
  useOfficeChanged(request.dir, () => setExternalReload((value) => value + 1));

  const accent = useThemeColor("--color-accent", "currentColor");
  const documentHtml = useMemo(() => {
    if (state.status !== "ready") return "";
    return officeDocumentHtml({ html: state.data.html, format, width, accent });
  }, [state, format, width, accent]);

  /** iframe 里的点击：标注 / 切工作表 / 阻止链接跳转 */
  const wire = useCallback(() => {
    const doc = frameRef.current?.contentDocument ?? null;
    if (doc === null) return;
    // 切工作表：OfficeCLI 的标签原本靠自己的脚本，脚本删掉后由我们代劳
    for (const tab of Array.from(doc.querySelectorAll<HTMLElement>(".sheet-tab"))) {
      tab.addEventListener("click", () => {
        const index = tab.dataset["sheet"];
        for (const other of Array.from(doc.querySelectorAll<HTMLElement>(".sheet-tab"))) {
          other.classList.toggle("active", other.dataset["sheet"] === index);
        }
        for (const pane of Array.from(doc.querySelectorAll<HTMLElement>(".sheet-content"))) {
          pane.classList.toggle("active", pane.dataset["sheet"] === index);
        }
        setPicked(null);
        setAnchor(null);
      });
    }
    doc.addEventListener("click", (event) => {
      const target = event.target as Element | null;
      if (target === null) return;
      const link = target.closest("a");
      if (link !== null) event.preventDefault();
      const hit = target.closest<HTMLElement>("[data-path]");
      if (hit === null) return;
      const path = hit.dataset["path"] ?? "";
      if (path === "") return;
      // shift + 点第二格 = 区间（只对 xlsx 的同表单格路径成立；跨表就退化成单格）
      const range = event.shiftKey && format === "xlsx" && anchor !== null ? xlsxRangePath(anchor, path) : null;
      if (range === null) setAnchor(path);
      const next = range ?? path;
      for (const el of Array.from(doc.querySelectorAll<HTMLElement>(".office-picked"))) {
        el.classList.remove("office-picked");
      }
      highlightRange(doc, next);
      setPicked({ path: next, preview: officeValuePreview(hit.textContent) });
    });
  }, [anchor, format]);

  // iframe 每次换文档（srcDoc 变了）都会重新 load：监听在这里重挂
  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null || documentHtml === "") return;
    const onLoad = (): void => wire();
    frame.addEventListener("load", onLoad);
    // srcDoc 在 effect 之前可能已经 load 完：contentDocument 有内容就直接挂
    if (frame.contentDocument?.querySelector("[data-path]") !== null) wire();
    return () => frame.removeEventListener("load", onLoad);
  }, [documentHtml, wire]);

  const quote = (): void => {
    if (picked === null) return;
    props.onQuote?.({
      text: picked.preview === "" ? picked.path : picked.preview,
      messageId: "",
      role: "user",
      filePath: request.dir,
      office: { format, path: picked.path },
    });
  };

  const capture = (): void => {
    const node = frameRef.current;
    if (node === null) return;
    const rect = node.getBoundingClientRect();
    void api.office
      .capture({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
      .then((result) => {
        setCaptured(result.ok ? "ok" : "fail");
        window.setTimeout(() => setCaptured("idle"), 1800);
      })
      .catch(() => {
        setCaptured("fail");
        window.setTimeout(() => setCaptured("idle"), 1800);
      });
  };

  return (
    <div className="office-preview" ref={shellRef}>
      {state.status === "loading" && (
        <div className="file-preview-loading">
          <Icon name="loader-circle" size={14} spin />
          {t.common.loading}
        </div>
      )}
      {state.status === "error" && (
        <div className="file-preview-error">
          <PanelLine danger>{state.message}</PanelLine>
          {props.onFallback !== undefined && (
            <PanelButton onClick={props.onFallback}>{t.office.modeGrid}</PanelButton>
          )}
        </div>
      )}
      {state.status === "unavailable" && (
        <div className="file-preview-empty">
          <Icon name="file-spreadsheet" size={24} style={{ color: "var(--color-text-tertiary)" }} />
          <PanelLine>{t.office.renderUnavailable}</PanelLine>
          <p className="office-detail" title={state.detail}>
            {state.detail}
          </p>
          <div className="office-error-actions">
            <PanelButton onClick={() => setExternalReload((value) => value + 1)}>
              <Icon name="rotate-ccw" size={14} />
              {t.office.retry}
            </PanelButton>
            {props.onFallback !== undefined && (
              <PanelButton onClick={props.onFallback}>
                <Icon name="table" size={14} />
                {t.office.modeGrid}
              </PanelButton>
            )}
          </div>
        </div>
      )}
      {state.status === "ready" && (
        <>
          <iframe
            ref={frameRef}
            className="office-frame"
            title={request.dir}
            sandbox="allow-same-origin"
            srcDoc={documentHtml}
          />
          <div className="office-annotate">
            {picked === null ? (
              <span className="office-hint">
                <Icon name="hand" size={12} />
                {format === "xlsx" ? t.office.pickCell : t.office.pickElement}
              </span>
            ) : (
              <>
                <span className="office-annotate-path" title={picked.path}>
                  {officeDisplayPath(format, picked.path)}
                  {picked.preview !== "" && <span className="office-annotate-value"> · {picked.preview}</span>}
                </span>
                <div className="office-annotate-actions row-trailing">
                  {props.onQuote !== undefined && (
                    <PanelButton onClick={quote}>
                      <Icon name="quote" size={13} />
                      {t.office.quote}
                    </PanelButton>
                  )}
                  <PanelButton onClick={capture}>
                    <Icon name={captured === "ok" ? "check" : "image"} size={13} />
                    {captured === "ok" ? t.office.copied : t.office.copyImage}
                  </PanelButton>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** 设计系统的颜色取实际值（iframe 里读不到父窗口的 CSS 变量） */
function useThemeColor(variable: string, fallback: string): string {
  const [value, setValue] = useState(fallback);
  useEffect(() => {
    const read = (): void => {
      const next = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
      if (next !== "") setValue(next);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    return () => observer.disconnect();
  }, [variable]);
  return value;
}

/** 把选中的区间（或单格）画上 outline；区间按 A1 坐标逐格标（`/Sheet1/B2:D5`） */
function highlightRange(doc: Document, path: string): void {
  const range = /^\/([^/]+)\/([A-Za-z]{1,3})([0-9]+):([A-Za-z]{1,3})([0-9]+)$/.exec(path);
  if (range === null) {
    doc.querySelector(`[data-path="${cssEscape(path)}"]`)?.classList.add("office-picked");
    return;
  }
  const sheet = range[1] as string;
  const fromCol = (range[2] as string).toUpperCase();
  const fromRow = Number(range[3]);
  const toCol = (range[4] as string).toUpperCase();
  const toRow = Number(range[5]);
  const colIndex = (letters: string): number => {
    let index = 0;
    for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
    return index - 1;
  };
  const label = (index: number): string => {
    let n = index + 1;
    let out = "";
    while (n > 0) {
      const rem = (n - 1) % 26;
      out = String.fromCharCode(65 + rem) + out;
      n = Math.floor((n - 1) / 26);
    }
    return out;
  };
  for (let row = Math.min(fromRow, toRow); row <= Math.max(fromRow, toRow); row += 1) {
    for (let col = Math.min(colIndex(fromCol), colIndex(toCol)); col <= Math.max(colIndex(fromCol), colIndex(toCol)); col += 1) {
      doc.querySelector(`[data-path="${cssEscape(`/${sheet}/${label(col)}${row}`)}"]`)?.classList.add("office-picked");
    }
  }
}

/** 路径里的 `[` `]` `@` 在 CSS 选择器里要转义（不依赖 CSS.escape：老 Chromium 的差分） */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/** 一次改动清单：path / 旧值 / 新值 + 整批回退 */
export function OfficeChangesPanel(props: {
  request: FileListRequest;
  /** 回退成功后通知（外层重渲染 + 重读网格） */
  onReverted: () => void;
  reloadToken: number;
}) {
  const t = useT();
  const [changes, setChanges] = useState<OfficeChanges | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void api.office
      .changes(props.request)
      .then((next) => setChanges(next))
      .catch(() => setChanges(null));
    // 依赖按字段列（request 每渲染新建）
  }, [props.request.sessionId, props.request.workspaceId, props.request.root, props.request.dir]);

  useEffect(() => load(), [load, props.reloadToken]);
  // agent 改完这份文件：清单跟着刷新（用户不用先点一次刷新才看到新的一条）
  useOfficeChanged(props.request.dir, load);

  const revert = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void api.office
      .revert(props.request)
      .then((result) => {
        if (result.ok) {
          setChanges(null);
          props.onReverted();
        } else {
          setError(result.error ?? "failed");
        }
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  const items = changes?.items ?? [];
  if (items.length === 0) return null;
  return (
    <section className="office-changes">
      <button type="button" className="office-changes-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
        {t.office.changes(items.length)}
      </button>
      {open && (
        <div className="office-changes-body">
          <ul className="office-change-list">
            {items.map((item) => (
              <li key={item.id} className="office-change">
                <span className="office-change-command">{item.command}</span>
                <span className="office-change-path" title={item.path}>
                  {item.path}
                </span>
                <span className="office-change-values">
                  {item.before === null ? "∅" : item.before} → {item.after === null ? "∅" : item.after}
                </span>
              </li>
            ))}
          </ul>
          <div className="office-changes-actions">
            {error !== null && <span className="office-change-error">{error}</span>}
            <PanelButton onClick={revert} disabled={busy || changes?.backup === null}>
              <Icon name={busy ? "loader-circle" : "undo-2"} size={13} spin={busy} />
              {t.office.revert}
            </PanelButton>
          </div>
        </div>
      )}
    </section>
  );
}

/** 一行的「未启用 Office 渲染」说明：退回网格 / 大纲时要说清为什么（不弹错误条） */
export function OfficeUnavailableNotice(props: { status: OfficeStatus | null; fallback: "grid" | "outline" }) {
  const t = useT();
  const detail = props.status?.detail ?? null;
  return (
    <div className="office-notice" title={detail ?? undefined}>
      <Icon name="info" size={12} />
      <span className="office-notice-text">
        {props.fallback === "grid" ? t.office.noticeGrid : t.office.noticeOutline}
        {detail !== null && <span className="office-notice-detail"> · {detail}</span>}
      </span>
    </div>
  );
}

/**
 * 订阅「agent 改过这份文件」：主进程在 batch / 回退落盘后广播（office:changed）。
 * 回调走 ref，调用方不必用 useCallback 包一层——每次渲染新建的箭头函数不该重挂订阅。
 */
export function useOfficeChanged(path: string, onChange: () => void): void {
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    return api.office.onChanged((event) => {
      if (event.path === path) latest.current();
    });
  }, [path]);
}

/** Office 可用性（面板挂载时问一次；主进程缓存，重复问很便宜） */
export function useOfficeStatus(): OfficeStatus | null {
  const [status, setStatus] = useState<OfficeStatus | null>(null);
  useEffect(() => {
    let alive = true;
    void api.office
      .status()
      .then((next) => {
        if (alive) setStatus(next);
      })
      .catch(() => {
        if (alive) setStatus({ available: false, version: null, source: null, bin: null, detail: null });
      });
    return () => {
      alive = false;
    };
  }, []);
  return status;
}

/** 渲染 / 数据（大纲）两种视图的切换芯片；Office 不可用时整排不出现 */
export function OfficeModeChips(props: { mode: "render" | "data"; onChange: (mode: "render" | "data") => void; dataLabel: string }) {
  const t = useT();
  return (
    <div className="office-mode">
      <Chip active={props.mode === "render"} onClick={() => props.onChange("render")}>
        {t.office.modeRender}
      </Chip>
      <Chip active={props.mode === "data"} onClick={() => props.onChange("data")}>
        {props.dataLabel}
      </Chip>
    </div>
  );
}
