/**
 * 「查找文献…」面板 —— 右键菜单打开的**在线检索**小面板。
 *
 * 为什么不是一个设置页 / 侧栏：用户是在写 `\cite{` 的那一刻发现自己缺一条文献，
 * 这时候该出现的是一行输入框，不是让他离开光标去另一块地方。所以它是浮层：
 * 开在右键的那个点旁边，Esc 就消失，取中的条目立刻落进 `.bib` 并在光标处插入
 * `\cite{key}`，光标不动、标签不换。
 *
 * 三条纪律：
 * - **联网只由这里的「查找」触发**（回车也算）：打开面板不请求、输入不请求、
 *   没有防抖自动搜索——`cite:search` 只会被一次明确的动作调用。
 * - **选择与写入分两次 IPC**：检索结果只是候选；写盘要走 `cite:save` 的白名单与
 *   expectedHash，冲突时界面必须说「没写入」，不能装作成功了。
 * - **键盘可用**：↑↓ 移动、Enter 取当前（没选过就是第一条）、Esc 关闭。鼠标只是
 *   另一条路，不是唯一的路。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  CiteCandidate,
  CiteFileContext,
  CiteSaveOutcome,
  CiteSearchOutcome,
} from "../../../../shared/cite.ts";
import { api } from "../../api.ts";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon.tsx";
import { placeMenu } from "../../shell/menu-position.ts";

/** 面板先按这个宽度量位置；内容再长也不会把它撑宽（标题走省略号） */
const PANEL_WIDTH = 420;

/** 一次动作在飞时锁住按钮：8 秒超时之内连点三次不该打三次网络 */
type Phase = "idle" | "searching" | "saving";

/** 底部那条状态：成功 / 提示 / 失败三档，颜色只是第二信号 */
interface Notice {
  tone: "ok" | "warn" | "error";
  text: string;
}

export function CiteSearchPanel(props: {
  /** 右键那一刻的视口坐标：面板开在下方，装不下翻上去（placeMenu 同一套） */
  position: { x: number; y: number };
  /** 当前文件上下文（授权与 fs:* 同一道；面板给不出项目目录） */
  context: CiteFileContext;
  /** 在光标处插入 `\cite{key}`；编辑器只读时返回 false（.bib 已经写了，界面要如实说） */
  onInsert: (key: string) => boolean;
  onClose: () => void;
}) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const [placed, setPlaced] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [results, setResults] = useState<CiteCandidate[]>([]);
  const [active, setActive] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 先按旧位置渲染但不可见，量到真实高度再定位（与 ContextMenu 同一拍，不闪）
  useLayoutEffect(() => {
    const box = panelRef.current?.getBoundingClientRect();
    if (box === undefined) return;
    const placement = placeMenu(
      {
        top: props.position.y,
        bottom: props.position.y,
        left: props.position.x,
        right: props.position.x,
        width: 0,
        height: 0,
      },
      { width: PANEL_WIDTH, height: box.height },
      "start",
      { width: window.innerWidth, height: window.innerHeight },
    );
    if (!placement.visible) {
      props.onClose();
      return;
    }
    setPlaced({ top: placement.top, left: placement.left, maxHeight: placement.maxHeight });
  }, [props.position.x, props.position.y, props.onClose]);

  /**
   * 定位完之后再抢焦点。**不能在第一帧就 focus**：那一帧面板还是 `visibility:
   * hidden`（先量高度再摆位），隐藏元素上的 focus 静默失败——验收实测：面板开了，
   * 打字却落在编辑器里。
   */
  useEffect(() => {
    if (placed !== null) inputRef.current?.focus();
  }, [placed]);

  // 点面板外面就关（与 ContextMenu 同一语义）；捕获阶段，先于别处的 pointerdown
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (panelRef.current?.contains(event.target as Node) === true) return;
      props.onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [props.onClose]);

  const search = useCallback((): void => {
    const text = query.trim();
    if (text === "" || phase === "searching") return;
    setPhase("searching");
    setNotice(null);
    setResults([]);
    setActive(0);
    void api.cite
      .search({ query: text })
      .then((outcome: CiteSearchOutcome) => {
        if (!mountedRef.current) return;
        setPhase("idle");
        if (!outcome.ok) {
          setNotice({ tone: "error", text: failedText(outcome) });
          return;
        }
        setResults(outcome.results);
        setActive(0);
        if (outcome.results.length === 0) setNotice({ tone: "warn", text: t.citeSearch.empty });
      })
      .catch((cause: unknown) => {
        if (!mountedRef.current) return;
        setPhase("idle");
        setNotice({ tone: "error", text: t.citeSearch.failed(failMessage(cause)) });
      });
  }, [phase, query, t]);

  const pick = useCallback(
    (candidate: CiteCandidate): void => {
      if (phase !== "idle") return;
      setPhase("saving");
      setNotice(null);
      void api.cite
        .save({ context: props.context, candidate })
        .then((outcome: CiteSaveOutcome) => {
          if (!mountedRef.current) return;
          setPhase("idle");
          if (!outcome.ok) {
            setNotice({ tone: "error", text: saveFailedText(outcome) });
            return;
          }
          const inserted = props.onInsert(outcome.key);
          setResults([]);
          setNotice({
            tone: inserted ? "ok" : "warn",
            text: inserted
              ? `${t.citeSearch.written(outcome.path)} · ${t.citeSearch.inserted(outcome.key)}`
              : `${t.citeSearch.written(outcome.path)} · ${t.citeSearch.insertBlocked}`,
          });
        })
        .catch((cause: unknown) => {
          if (!mountedRef.current) return;
          setPhase("idle");
          setNotice({ tone: "error", text: t.citeSearch.writeFailed(failMessage(cause)) });
        });
    },
    [phase, props, t],
  );

  const failedText = (outcome: Extract<CiteSearchOutcome, { ok: false }>): string => {
    switch (outcome.reason) {
      case "empty-query":
        return t.citeSearch.empty;
      case "timeout":
        return t.citeSearch.timeout;
      case "offline":
        return t.citeSearch.offline;
      case "rate-limited":
        return t.citeSearch.rateLimited;
      case "not-found":
        return t.citeSearch.notFound;
      case "failed":
        return t.citeSearch.failed(outcome.detail);
    }
  };

  const saveFailedText = (outcome: Extract<CiteSaveOutcome, { ok: false }>): string => {
    if (outcome.reason === "conflict") return t.citeSearch.conflict(outcome.detail);
    if (outcome.reason === "outside-project") return t.citeSearch.outside;
    return t.citeSearch.writeFailed(outcome.detail);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      // 拦在这里：App 的全局 Esc 会把文件面板也关掉，而用户只想关这个小面板
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (phase !== "idle") return;
      // 有结果就取当前那条（默认第一条），没有结果就把这次回车当「查找」
      const target = results[active] ?? results[0];
      if (target === undefined) search();
      else pick(target);
      return;
    }
    if (results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => (current + 1) % results.length);
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => (current - 1 + results.length) % results.length);
    }
  };

  const busy = phase !== "idle";

  /**
   * 输入一变，旧结果立刻作废。否则「搜完 A、改两个字、回车」会按 Enter 的「取当前
   * 那条」规则**选中上一次查询的第一条**——用户在回车前看到的是新词，落进 .bib 的
   * 却是另一篇文献（验收实测）。清空之后回车退化成「查找」，语义总是单义的。
   */
  const onQueryChange = (value: string): void => {
    setQuery(value);
    setResults([]);
    setNotice(null);
    setActive(0);
  };

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t.citeSearch.title}
      className="glass-card glass-float menu-panel cite-search"
      onKeyDown={onKeyDown}
      style={{
        position: "fixed",
        top: placed?.top ?? props.position.y,
        left: placed?.left ?? props.position.x,
        visibility: placed === null ? "hidden" : "visible",
        width: PANEL_WIDTH,
        maxHeight: placed?.maxHeight,
        zIndex: 40,
      }}
    >
      <div className="cite-search-head">
        <span className="cite-search-title">{t.citeSearch.title}</span>
        {busy && <Icon name="loader-circle" size={13} className="cite-search-spinner" />}
      </div>
      <div className="cite-search-form">
        <input
          ref={inputRef}
          className="text-field"
          value={query}
          placeholder={t.citeSearch.placeholder}
          aria-label={t.citeSearch.placeholder}
          disabled={phase === "saving"}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <button
          type="button"
          className="btn-accent cite-search-submit"
          disabled={query.trim() === "" || busy}
          onClick={search}
        >
          {phase === "searching" ? t.citeSearch.searching : t.citeSearch.search}
        </button>
      </div>
      {results.length > 0 && (
        <div className="cite-search-results" role="listbox" aria-label={t.citeSearch.title}>
          {results.map((candidate, index) => (
            <button
              key={`${candidate.source}:${candidate.doi ?? candidate.arxivId ?? candidate.title}:${String(index)}`}
              type="button"
              role="option"
              aria-selected={index === active}
              className="option-row cite-search-row"
              data-cursor={index === active}
              disabled={phase === "saving"}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(candidate)}
            >
              <span className="cite-search-row-main">
                <span className="cite-search-row-title">{candidate.title}</span>
                <span className="cite-search-row-meta">{metaLine(candidate)}</span>
              </span>
              <span className="cite-search-row-source">
                {candidate.source === "arxiv" ? t.citeSearch.arxiv : t.citeSearch.crossref}
              </span>
            </button>
          ))}
        </div>
      )}
      {notice !== null && (
        <div className="cite-search-notice" data-tone={notice.tone} role="status">
          <Icon
            name={notice.tone === "ok" ? "circle-check" : notice.tone === "error" ? "triangle-alert" : "search"}
            size={13}
            className="cite-search-notice-icon"
          />
          <span className="cite-search-notice-text">{notice.text}</span>
        </div>
      )}
    </div>,
    document.body,
  );
}

/** 一行「作者 · 年 · 刊物」：缺哪项就少哪项，不补占位符 */
function metaLine(candidate: CiteCandidate): string {
  const authors =
    candidate.authors.length > 3
      ? `${candidate.authors.slice(0, 3).join(", ")} +${String(candidate.authors.length - 3)}`
      : candidate.authors.join(", ");
  return [authors, candidate.year ?? "", candidate.venue ?? ""].filter((part) => part !== "").join(" · ");
}

function failMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
