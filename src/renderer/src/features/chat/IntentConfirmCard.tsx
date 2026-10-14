/**
 * 回答前确认卡（实验功能 intent-system，2026-10-14 逐条版重写）—— recall 判定
 * 「有待确认的连接」后浮在输入框上方，与 ApprovalBar / CarryoverChecklist 同位。
 *
 * 一次只看一条（confirm-card-v2.html 的方案 2 + 用户 10/14 20:27 的改动）：
 * - 大字陈述只有一句：「如果对，这次回答会…」（S3 写的 prediction 剥掉开头的
 *   「回答会」；join 不到 /edges 的边时退回 ask.statement，标签换成「我的假设」）。
 *   原来的「我的假设 + 如果对」两块重复，砍掉假设块是刻意的——用户点「对」接受的
 *   就是这句预测。**改字 = 表态**：改过的说法同「对」（shared/intent-confirm.ts），
 *   提交时 statement 与 edited 都填用户的字。
 * - 往下按「判断要用的顺序」：为什么连上（边的 connection，灰盒）→ 为什么拿不准
 *   （warning 色竖条）→ 当时那段对话（Q/A 经 MarkdownBlock 渲染，用来连上的摘句
 *   高亮成 mark；能滚动；「在辅助对话打开」用的就是 App 的 openInSideChat，来源
 *   会话不在本机时禁用并就地说明）。
 * - 键盘：Y / N 表态并自动翻下一条（再按同一个撤掉就不翻），← → 翻页，E 改字；
 *   焦点在任何文本框里或听写进行中时快捷键全停。点顶部进度条跳到任意一条。
 * - 听写：背景框与大字陈述（改字态）各一个麦克风按钮，行为与输入框同款（再点或
 *   回车结束留字、Esc 取消、听写中只读、失败一行提示）。
 *
 * 卡片出现时拉本问的 /edges（那时它已写好）按 qaId + 岗 join 出 connection /
 * prediction / evidence / assistant / qa 原文；join 不到只显示 ask 自带的字段，不崩。
 *
 * 不做 Esc 退出整卡——两个出口（不确认直接回答 / 确认并回答）都是继续回答，没有
 * 「取消」语义。草稿（表态 / 改字 / 背景）不跨刷新（实验功能：内存态即可）。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../shell/Icon.tsx";
import { IconButton } from "../../shell/IconButton.tsx";
import { useT } from "../../locale.ts";
import { api } from "../../api.ts";
import type { IntentAskView } from "../../../../shared/intent-recall.ts";
import { findAskEdge, type ExcerptWindow, type IntentEdges } from "../../../../shared/intent-edges.ts";
import {
  buildConfirmAnswers,
  buildSkipAllAnswers,
  confirmDraftDiffers,
  editConfirmRow,
  initialConfirmRows,
  predictionStatement,
  toggleConfirmVerdict,
} from "../../../../shared/intent-confirm.ts";
import type { IntentConfirmDecision, IntentConfirmDraft } from "../../../../shared/intent-confirm.ts";
import { MarkdownBlock } from "./MarkdownBlock.tsx";
import { locateQuote } from "./quote-select.ts";
import { closeOpenFence, markScrollTop, windowCounts } from "./conv-window.ts";
import { useDictation } from "../voice/useDictation.ts";
import { DictationStatus } from "../voice/DictationStatus.tsx";

/**
 * 键盘快捷键只属于最新挂载的那张确认卡（主槽与抽屉同开一条会话时，两张卡都在，
 * 后挂载的接键盘——它多半是用户正在看的那张）。
 */
let confirmCardSeq = 0;
let latestConfirmCard = 0;

/** auto-height textarea：随内容长高（量 scrollHeight 现算，同 Composer 的做法）。 */
function autofit(el: HTMLTextAreaElement | null): void {
  if (el === null) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/**
 * 把摘句在渲染好的 markdown 里高亮成 <mark>：locateQuote 忽略空白差异找到起止。
 * 起止在同一块级元素里（段落 / 列表项）：extractContents 整个抽出来包**一个** mark
 * （跨 strong/em 边界也行——部分选中的行内元素被克隆进片段），一个摘句一个高亮；
 * 跨块（段落边界）包一个会出非法嵌套，退回逐文本节点分段包。
 * 摘句逐字对不上渲染文本（markdown 改写、服务端摘句本身带省略）就不高亮——不硬凑。
 * 返回是否标上了（调用方据此决定要不要滚动定位）。
 */
const BLOCK_SEL = "p, li, pre, td, th, blockquote, h1, h2, h3, h4, h5, h6";
function markExcerpt(root: HTMLElement | null, excerpt: string): boolean {
  if (root === null || excerpt.trim() === "") return false;
  // 幂等：同一份 DOM 上再跑一次（effect 重跑）不叠第二层
  if (root.querySelector("mark.intent-mark") !== null) return true;
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node as Text);
  const at = locateQuote(nodes.map((node) => node.data), excerpt);
  if (at === null) return false;
  const startNode = nodes[at.start.node];
  const endNode = nodes[at.end.node];
  if (startNode === undefined || endNode === undefined || !root.contains(startNode) || !root.contains(endNode)) {
    return false;
  }
  const range = document.createRange();
  range.setStart(startNode, at.start.offset);
  range.setEnd(endNode, at.end.offset);
  const sameBlock =
    (startNode.parentElement?.closest(BLOCK_SEL) ?? null) === (endNode.parentElement?.closest(BLOCK_SEL) ?? null);
  if (sameBlock) {
    const frag = range.extractContents();
    const mark = document.createElement("mark");
    mark.className = "intent-mark";
    mark.appendChild(frag);
    range.insertNode(mark);
    return true;
  }
  for (let i = at.start.node; i <= at.end.node; i += 1) {
    const node = nodes[i];
    if (node === undefined || !root.contains(node)) continue;
    const start = i === at.start.node ? at.start.offset : 0;
    const end = i === at.end.node ? at.end.offset : node.data.length;
    if (end <= start) continue;
    const seg = document.createRange();
    seg.setStart(node, start);
    seg.setEnd(node, end);
    const mark = document.createElement("mark");
    mark.className = "intent-mark";
    seg.surroundContents(mark);
  }
  return true;
}

/**
 * 「当时那段对话」的一个滚动区（Q 或 A，2026-10-14 用户裁决拆成两个各自滚动）：
 * max-height 160px，挂载 / 翻页 / 宽度变化时把这个区的摘句高亮滚到居中（摘句比可视区
 * 高则开头顶上）；用户自己滚过就不再拉回来（wheel / touch 落闩，翻页重挂复位）。
 *
 * 窗口元数据（qWindow / aWindow，契约 2026-10-14 增补）：
 * - cutBefore / cutAfter：区首 / 区尾一行小字「… 前面还有 N 字」，点了 = 在辅助对话打开；
 * - located=false：摘句不是逐字原文——不高亮、从头显示、加一行说明；
 * - fallback=true 或摘句为空：从头显示、不高亮、不说话（A 的摘句经常是空的，正常）；
 * - 没有窗口元数据（旧服务端）：退回旧行为——全文里逐字找摘句，找到才高亮。
 */
function ConvArea(props: {
  who: string;
  /** 原文（窗口或全文）；渲染前过 closeOpenFence（截断可能劈开代码块） */
  text: string;
  /** 要高亮的摘句（Q 用 evidence、A 用 assistant 摘句） */
  excerpt: string;
  window: ExcerptWindow | undefined;
  variant: "bubble" | "full";
  /** 「前面 / 后面还有 N 字」能不能点（来源会话在本机）；点了打开辅助对话 */
  openable: boolean;
  onOpen?: () => void;
}) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // 用户手动滚过的闩：一旦自己动手，宽度变化 / effect 重跑都不再拉回高亮处
  const userScrolled = useRef(false);
  const counts = windowCounts(props.window, props.text.length);
  const notLocated = props.window?.located === false;
  const noMark = props.excerpt.trim() === "" || props.window?.fallback === true || notLocated;

  // 标高亮 + 滚到位（useLayoutEffect：绘制前摆好，不闪）
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const scroller = scrollRef.current;
    if (body === null || scroller === null) return;
    const marked = noMark ? false : markExcerpt(body, props.excerpt);
    if (userScrolled.current) return;
    if (!marked) {
      scroller.scrollTop = 0;
      return;
    }
    const marks = [...body.querySelectorAll("mark.intent-mark")];
    const first = marks[0];
    const last = marks[marks.length - 1];
    if (first === undefined || last === undefined) return;
    const cbox = scroller.getBoundingClientRect();
    const top = first.getBoundingClientRect().top - cbox.top + scroller.scrollTop;
    const bottom = last.getBoundingClientRect().bottom - cbox.top + scroller.scrollTop;
    scroller.scrollTop = markScrollTop(top, bottom, scroller.clientHeight);
  }, [props.text, props.excerpt, noMark]);

  // 宽度变化（栏拖宽 / 窗口缩放）重排后重摆高亮；用户滚过就不动
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    const observer = new ResizeObserver(() => {
      if (userScrolled.current) return;
      const body = bodyRef.current;
      const first = body?.querySelector("mark.intent-mark");
      if (body === undefined || body === null || first === null || first === undefined) return;
      const marks = [...body.querySelectorAll("mark.intent-mark")];
      const last = marks[marks.length - 1] ?? first;
      const cbox = scroller.getBoundingClientRect();
      const top = first.getBoundingClientRect().top - cbox.top + scroller.scrollTop;
      const bottom = last.getBoundingClientRect().bottom - cbox.top + scroller.scrollTop;
      scroller.scrollTop = markScrollTop(top, bottom, scroller.clientHeight);
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  const cutHint = (n: number, label: string) =>
    props.openable && props.onOpen !== undefined ? (
      <button type="button" className="intent-conv-cut openable" onClick={props.onOpen}>
        {label}
      </button>
    ) : (
      <span className="intent-conv-cut">{label}</span>
    );

  return (
    <div className="intent-conv-turn">
      <div className="intent-conv-who">{props.who}</div>
      {notLocated && <div className="intent-conv-located-note">{t.chat.recall.confirm.excerptNotLocated}</div>}
      <div
        ref={scrollRef}
        className="intent-conv-scroll scroll"
        onWheel={() => (userScrolled.current = true)}
        onTouchMove={() => (userScrolled.current = true)}
      >
        {counts !== null && counts.before > 0 && cutHint(counts.before, t.chat.recall.confirm.moreBefore(counts.before))}
        <div ref={bodyRef} className="intent-conv-md">
          <MarkdownBlock text={closeOpenFence(props.text)} variant={props.variant} />
        </div>
        {counts !== null && counts.after > 0 && cutHint(counts.after, t.chat.recall.confirm.moreAfter(counts.after))}
      </div>
    </div>
  );
}

export function IntentConfirmCard(props: {
  ask: IntentAskView[];
  requestId: string;
  /** 拉本问 /edges 用（intentAsk 事件随身带） */
  sessionId: string;
  turnId: string;
  /** 未提交草稿（切会话 / 刷新恢复）；null = 没编辑过 */
  draft: IntentConfirmDraft | null;
  onDraftChange: (draft: IntentConfirmDraft) => void;
  onAnswer: (requestId: string, decision: IntentConfirmDecision) => void;
  /** 「在辅助对话打开」（主槽才有）；不传时入口禁用 */
  onOpenSideChat?: (sessionId: string) => void;
  /** 本机存在的会话 id 集：渲染时就判定「打开」能不能点（不让用户点了才知道） */
  openableSessionIds?: ReadonlySet<string>;
}) {
  const t = useT();
  const [rows, setRows] = useState(() =>
    props.draft !== null && props.draft.requestId === props.requestId ? props.draft.rows : initialConfirmRows(props.ask),
  );
  const [note, setNote] = useState(
    props.draft !== null && props.draft.requestId === props.requestId ? props.draft.note : "",
  );
  /** 当前条的下标与改字态（不进草稿——位置不是表态） */
  const [cur, setCur] = useState(0);
  const [editing, setEditing] = useState(false);
  /** 本问的 /edges；null = 还没拉到或拉失败（join 不到的条目只显示 ask 自带的字段） */
  const [edges, setEdges] = useState<IntentEdges | null>(null);

  /*
   * P0（2026-09-27 真机：确认卡「对 / 不对」没反应，138 秒 1,552 次 Maximum update
   * depth）：上层回调身份不稳时草稿上抛 effect 会死循环。两个护栏把数据流改成单向——
   * 上抛只依赖内容（回调经 ref 取最新）；下行同步只在「同卡、内容真的不同、且用户
   * 还没动过」时重置（dirty 后本地是真源）。
   */
  const dirtyRef = useRef(false);
  const onDraftChangeRef = useRef(props.onDraftChange);
  onDraftChangeRef.current = props.onDraftChange;
  useEffect(() => {
    onDraftChangeRef.current({ requestId: props.requestId, rows, note });
  }, [rows, note, props.requestId]);
  useEffect(() => {
    if (
      !dirtyRef.current &&
      props.draft !== null &&
      confirmDraftDiffers(props.draft, props.requestId, rows, note)
    ) {
      setRows(props.draft.rows);
      setNote(props.draft.note);
    }
  }, [props.draft, props.requestId, rows, note]);

  // 拉本问的 /edges（卡片出现时它已写好）；失败就 null——join 不到的条目照显示
  useEffect(() => {
    let alive = true;
    api.intent
      .edges(props.sessionId, props.turnId)
      .catch(() => null)
      .then((result) => {
        if (!alive) return;
        setEdges(result);
      });
    return () => {
      alive = false;
    };
  }, [props.sessionId, props.turnId]);

  const item = props.ask[cur];
  const row = rows[cur];
  const edge = useMemo(() => (edges === null || item === undefined ? null : findAskEdge(edges, item)), [edges, item]);
  const bigLabel = edge !== null ? t.chat.recall.confirm.ifRight : t.chat.recall.confirm.hypothesis;
  const bigText = edge !== null ? predictionStatement(edge.prediction) : (item?.statement ?? "");
  const stmtText = row?.edited ?? bigText;

  // ── 听写 ×2：背景框与大字陈述（改字态）。行为与输入框同款 ─────────────
  const stmtRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const stmtDictation = useDictation({
    value: stmtText,
    onChange: (text) => {
      if (item === undefined) return;
      dirtyRef.current = true;
      setRows((prev) => editConfirmRow(prev, item.askId, text));
    },
    textareaRef: stmtRef,
  });
  const noteDictation = useDictation({
    value: note,
    onChange: (text) => {
      dirtyRef.current = true;
      setNote(text);
    },
    textareaRef: noteRef,
  });
  const dictating = stmtDictation.phase !== "idle" || noteDictation.phase !== "idle";

  // 两个输入框随内容长高
  useLayoutEffect(() => autofit(stmtRef.current), [stmtText, editing]);
  useLayoutEffect(() => autofit(noteRef.current), [note]);

  // 当时那段对话的原文与摘句（Q 用 evidence、A 用 assistant 摘句）；滚动区是 ConvArea
  // （各自滚动、自动把高亮滚到居中），按 askId 作 key——翻条重挂一份干净 DOM
  const qText = edge?.qa.q ?? "";
  const aText = edge?.qa.a ?? "";
  const evidence = edge?.evidence ?? "";
  const assistantExcerpt = edge?.assistant ?? "";

  const answered = useMemo(() => buildConfirmAnswers(rows, props.ask), [rows, props.ask]);
  const taken = rows.filter((r) => r.verdict !== "skip").length;

  const go = (next: number): void => {
    setCur(Math.max(0, Math.min(props.ask.length - 1, next)));
    setEditing(false);
  };
  /** 表态：点已选中的撤掉（不翻页）；新选中的自动翻下一条（示意交互）。 */
  const vote = (verdict: "yes" | "no"): void => {
    if (item === undefined || row === undefined) return;
    dirtyRef.current = true;
    const wasSelected = row.verdict === verdict;
    setRows((prev) => toggleConfirmVerdict(prev, item.askId, verdict));
    setEditing(false);
    if (!wasSelected && cur < props.ask.length - 1) setCur(cur + 1);
  };
  const startEditing = (): void => {
    setEditing(true);
    const el = stmtRef.current;
    if (el !== null) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  };

  // 键盘：Y / N 表态并翻页，← → 翻页，E 改字；焦点在文本框或听写中全停。
  // 监听只挂一次：状态与动作都经 ref 取最新（vote/go 闭包着当帧的 cur/row）。
  const stateRef = useRef({ cur, dictating });
  stateRef.current = { cur, dictating };
  const actionsRef = useRef({ vote, go, startEditing });
  actionsRef.current = { vote, go, startEditing };
  const cardIdRef = useRef(0);
  if (cardIdRef.current === 0) {
    confirmCardSeq += 1;
    cardIdRef.current = confirmCardSeq;
  }
  useEffect(() => {
    const id = cardIdRef.current;
    latestConfirmCard = id;
    return () => {
      if (latestConfirmCard === id) latestConfirmCard = 0;
    };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      if (latestConfirmCard !== cardIdRef.current) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)
      ) {
        return;
      }
      if (stateRef.current.dictating) return;
      const { vote: doVote, go: doGo, startEditing: doEdit } = actionsRef.current;
      if (event.key === "y" || event.key === "Y") doVote("yes");
      else if (event.key === "n" || event.key === "N") doVote("no");
      else if (event.key === "ArrowLeft") doGo(stateRef.current.cur - 1);
      else if (event.key === "ArrowRight") doGo(stateRef.current.cur + 1);
      else if (event.key === "e" || event.key === "E") {
        event.preventDefault();
        doEdit();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const submit = (action: "confirm" | "skip-all"): void => {
    const trimmed = note.trim();
    props.onAnswer(props.requestId, {
      action,
      answers: action === "confirm" ? answered : buildSkipAllAnswers(props.ask),
      note: trimmed,
    });
  };

  if (item === undefined || row === undefined) return null;
  const openable =
    edge !== null && props.onOpenSideChat !== undefined && props.openableSessionIds?.has(edge.qa.sessionId) === true;

  return (
    <section role="region" aria-label={t.chat.recall.confirm.title} className="intent-confirm">
      {/* 顶行：标题 + 进度（可点跳）+ 岗胶囊与分数 */}
      <div className="intent-confirm-top">
        <strong className="intent-confirm-title">{t.chat.recall.confirm.title}</strong>
        <span className="intent-confirm-pos">
          {cur + 1} / {props.ask.length}
        </span>
        <span className="intent-dots" role="tablist" aria-label={t.chat.recall.confirm.title}>
          {props.ask.map((askItem, index) => {
            const r = rows[index];
            const state =
              index === cur ? "cur" : r !== undefined && r.verdict !== "skip" ? r.verdict : "open";
            return (
              <button
                key={askItem.askId}
                type="button"
                role="tab"
                aria-selected={index === cur}
                aria-label={`${index + 1}`}
                className="intent-dot"
                data-state={state}
                onClick={() => go(index)}
              />
            );
          })}
        </span>
        <span style={{ flex: 1 }} />
        <span className="intent-slot-pill">{item.slot}</span>
        {edge !== null && <span className="intent-confirm-pos">{edge.score.toFixed(2)}</span>}
      </div>

      <div className="intent-confirm-main">
        {/* 大字陈述：「如果对，这次回答会…」（join 不到边退回假设原文）。点它或按 E 改字 */}
        <div>
          <div className="intent-kick">{bigLabel}</div>
          <div className="intent-stmt-wrap">
            <textarea
              ref={stmtRef}
              className={`intent-stmt${row.verdict === "no" ? " no" : ""}${editing ? " editing" : ""}`}
              value={stmtText}
              readOnly={!editing || stmtDictation.phase !== "idle"}
              aria-label={t.chat.recall.confirm.statementLabel}
              rows={1}
              onChange={(event) => {
                dirtyRef.current = true;
                setRows((prev) => editConfirmRow(prev, item.askId, event.target.value));
              }}
              onClick={() => {
                if (!editing) startEditing();
              }}
              onKeyDown={(event) => {
                // 回车：听写中结束听写（字留下），否则结束改字；Esc 收改字态
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (stmtDictation.phase !== "idle") stmtDictation.finish();
                  else setEditing(false);
                } else if (event.key === "Escape" && stmtDictation.phase === "idle") {
                  setEditing(false);
                }
              }}
            />
            {editing && (
              <IconButton
                label={stmtDictation.phase !== "idle" ? t.voice.dictateFinish : t.voice.dictate}
                size={26}
                active={stmtDictation.phase === "listening"}
                disabled={stmtDictation.phase === "finishing"}
                onClick={stmtDictation.toggle}
                className="intent-stmt-mic"
              >
                {stmtDictation.phase === "connecting" || stmtDictation.phase === "finishing" ? (
                  <Icon name="loader-circle" size={13} spin />
                ) : (
                  <Icon
                    name="mic"
                    size={13}
                    strokeWidth={1.8}
                    className={stmtDictation.phase === "listening" ? "orbita-breath" : undefined}
                  />
                )}
              </IconButton>
            )}
          </div>
          {(stmtDictation.phase !== "idle" || stmtDictation.problem !== null) && (
            <DictationStatus
              phase={stmtDictation.phase}
              problem={stmtDictation.problem}
              provider={stmtDictation.provider}
            />
          )}
        </div>

        {/* 为什么连上（边的 connection；join 不到就不画这格） */}
        {edge !== null && (
          <div className="intent-box">
            <div className="intent-kick">{t.chat.recall.confirm.whyConnected}</div>
            {edge.connection}
          </div>
        )}

        {/* 为什么拿不准：warning 色竖条 */}
        <div className="intent-why">
          <span className="intent-kick">{t.chat.recall.confirm.whyUncertainLabel}</span>
          <br />
          {item.whyUncertain}
        </div>

        {/* 当时那段对话：Q/A 经 markdown 渲染，用来连上的摘句高亮；能滚动。
            join 不到边时退回 ask 自带的标题 / 时间 / 摘句（纯文本） */}
        <div className="intent-conv">
          <div className="intent-conv-h">
            <Icon name="history" size={12} />
            <b>{edge?.qa.title ?? item.title}</b>
            <span className="intent-confirm-pos">{item.when}</span>
            {edge !== null && ` · ${edge.qa.source}`}
            {edge !== null && edge.dupCount > 1 && (
              <span className="intent-conv-dup">{t.chat.recall.confirm.askedTimes(edge.dupCount)}</span>
            )}
            <span style={{ flex: 1 }} />
            {edge !== null && (
              <>
                {!openable && <span className="intent-conv-note">{t.intentPanel.sessionNotLocal}</span>}
                <button
                  type="button"
                  className="intent-conv-open"
                  disabled={!openable}
                  onClick={() => {
                    if (edge !== null && openable) props.onOpenSideChat?.(edge.qa.sessionId);
                  }}
                >
                  <Icon name="external-link" size={11} /> {t.chat.recall.confirm.openInSideChat}
                </button>
              </>
            )}
          </div>
          {edge !== null ? (
            <div className="intent-conv-areas">
              <ConvArea
                key={`q:${item.askId}`}
                who={t.chat.recall.confirm.youSaid}
                text={qText}
                excerpt={evidence}
                window={edge.qa.qWindow}
                variant="bubble"
                openable={openable}
                onOpen={openable && props.onOpenSideChat !== undefined ? () => props.onOpenSideChat?.(edge.qa.sessionId) : undefined}
              />
              <ConvArea
                key={`a:${item.askId}`}
                who={t.chat.recall.confirm.assistantSaid}
                text={aText}
                excerpt={assistantExcerpt}
                window={edge.qa.aWindow}
                variant="full"
                openable={openable}
                onOpen={openable && props.onOpenSideChat !== undefined ? () => props.onOpenSideChat?.(edge.qa.sessionId) : undefined}
              />
            </div>
          ) : (
            <div className="intent-conv-turn">
              <div className="intent-conv-who">{t.chat.recall.confirm.youSaid}</div>
              <div className="intent-conv-quote">“{item.quote}”</div>
            </div>
          )}
        </div>
      </div>

      {/* 表态行：← / 不对 N / 对 Y / 改字 E / → */}
      <div className="intent-acts">
        <button
          type="button"
          className="quiet-control intent-sq"
          title={t.chat.recall.confirm.prevItem}
          aria-label={t.chat.recall.confirm.prevItem}
          disabled={cur === 0}
          onClick={() => go(cur - 1)}
        >
          <Icon name="arrow-left" size={14} />
        </button>
        <button
          type="button"
          className={`intent-big no${row.verdict === "no" ? " on" : ""}`}
          aria-pressed={row.verdict === "no"}
          onClick={() => vote("no")}
        >
          <Icon name="x" size={13} /> {t.chat.recall.confirm.verdictNo} <kbd className="intent-kbd">N</kbd>
        </button>
        <button
          type="button"
          className={`intent-big yes${row.verdict === "yes" ? " on" : ""}`}
          aria-pressed={row.verdict === "yes"}
          onClick={() => vote("yes")}
        >
          <Icon name="check" size={13} /> {t.chat.recall.confirm.verdictYes} <kbd className="intent-kbd">Y</kbd>
        </button>
        <button
          type="button"
          className={`quiet-control intent-sq${editing ? " on" : ""}`}
          title={`${t.chat.recall.confirm.editStatement} E`}
          aria-label={t.chat.recall.confirm.editStatement}
          aria-pressed={editing}
          onClick={() => (editing ? setEditing(false) : startEditing())}
        >
          <Icon name="pencil-line" size={13} />
        </button>
        <button
          type="button"
          className="quiet-control intent-sq"
          title={t.chat.recall.confirm.nextItem}
          aria-label={t.chat.recall.confirm.nextItem}
          disabled={cur >= props.ask.length - 1}
          onClick={() => go(cur + 1)}
        >
          <Icon name="arrow-right" size={14} />
        </button>
      </div>

      {/* 底行：背景补充（带麦克风）+ 两个出口同一行；听写状态行在框下 */}
      <div className="intent-foot">
        <div className="intent-foot-row">
          <div className="intent-note-wrap">
            <textarea
              ref={noteRef}
              className="text-field intent-note"
              value={note}
              placeholder={t.chat.recall.confirm.notePlaceholder}
              aria-label={t.chat.recall.confirm.noteLabel}
              rows={1}
              readOnly={noteDictation.phase !== "idle"}
              onChange={(event) => {
                dirtyRef.current = true;
                setNote(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                // 听写中回车 = 结束听写（字留下）；平时回车照常换行
                if (event.key === "Enter" && noteDictation.phase !== "idle") {
                  event.preventDefault();
                  noteDictation.finish();
                }
              }}
            />
            <IconButton
              label={noteDictation.phase !== "idle" ? t.voice.dictateFinish : t.voice.dictate}
              size={26}
              active={noteDictation.phase === "listening"}
              disabled={noteDictation.phase === "finishing"}
              onClick={noteDictation.toggle}
              className="intent-note-mic"
            >
              {noteDictation.phase === "connecting" || noteDictation.phase === "finishing" ? (
                <Icon name="loader-circle" size={13} spin />
              ) : (
                <Icon
                  name="mic"
                  size={13}
                  strokeWidth={1.8}
                  className={noteDictation.phase === "listening" ? "orbita-breath" : undefined}
                />
              )}
            </IconButton>
          </div>
          <button type="button" className="quiet-control intent-foot-quiet" onClick={() => submit("skip-all")}>
            {t.chat.recall.confirm.answerWithoutConfirming}
          </button>
          <button type="button" className="btn-accent intent-foot-accent" onClick={() => submit("confirm")}>
            {t.chat.recall.confirm.confirmAndAnswerCount(taken, props.ask.length)}
          </button>
        </div>
        {(noteDictation.phase !== "idle" || noteDictation.problem !== null) && (
          <DictationStatus
            phase={noteDictation.phase}
            problem={noteDictation.problem}
            provider={noteDictation.provider}
          />
        )}
      </div>
    </section>
  );
}
