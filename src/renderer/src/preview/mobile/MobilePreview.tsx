import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { effectiveLanguage } from "@shared/settings";
import { LocaleContext, htmlLang, useT } from "../../locale.ts";
import { Icon, type IconName } from "../../shell/Icon";
import { IconButton } from "../../shell/IconButton";
import { InlineMarks } from "../../shell/InlineMarks";
import { PanelEmpty } from "../../shell/PanelEmpty";
import { StatusPie } from "../../shell/StatusPie";
import type { PieFill } from "../../shell/status-pie.ts";
import { sessionAgeLabel } from "../../shell/relative-time.ts";
import { MarkdownBlock } from "../../features/chat/MarkdownBlock";
import { ChatFileScopeContext } from "../../features/chat/chat-file-scope.ts";
import {
  HOST,
  MOBILE_CLOCK,
  MOBILE_NOW,
  MOBILE_PAGE,
  MOBILE_TAIL,
  PAIR_CODE,
  REPLY_DRAFT,
  REPLY_QUEUED,
  allSessions,
  mobileChat,
  mobileList,
  type MobileChat,
  type MobileEntry,
  type MobileHost,
  type MobileListData,
  type MobileSession,
  type MobileWorkspace,
} from "./fixture.ts";
import {
  CHAT_STATES,
  MOBILE_SCENES,
  PAIR_STATES,
  type ChatState,
  type MobileDevice,
  type MobileOptions,
  type PairState,
} from "./options.ts";
import "./mobile.css";

/**
 * 手机端「看与回」第一刀的设计稿（2026-11-25）。跑在 preview.html 上（`surface=mobile`），
 * 用桌面同一套 token、图标、空态、状态饼和 Markdown 正文——手机上的消息正文以后用 WebView 跑的
 * 正是这里的 MarkdownBlock；外壳（清单、顶栏、输入台）将来由 React Native 照这份稿子实现。
 *
 * 为什么不直接挂桌面的 Sidebar / ChatView：两者绑着 App 的会话槽、IPC 与桌面几何（工具栏胶囊、
 * 右栏、索引边栏），没法放进 412 宽的手机框；这里只复用叶子组件与配方类（.option-row、.btn-accent、
 * .text-field、.user-bubble、.assistant-prose、.proc-*、.run-agg、.panel-empty），手机特有的只是版式。
 *
 * 手机上能做的只有四件事：列会话、读尾部、回一句、停止。没有审批、语音、文件、终端。
 */
export function MobilePreview(props: { options: MobileOptions }) {
  const { options } = props;
  const locale = effectiveLanguage(options.language);
  useLayoutEffect(() => {
    document.documentElement.dataset["theme"] = options.theme;
    document.documentElement.lang = htmlLang(locale);
    document.documentElement.dataset["previewSurface"] = "mobile";
  }, [options.theme, locale]);
  return (
    <LocaleContext.Provider value={locale}>
      {/* 对话里引用的截图按 ws-orbita 的虚拟文件树解析（fixture 的 files.read） */}
      <ChatFileScopeContext.Provider value={{ sessionId: null, workspaceId: "ws-orbita", cwd: "/fixtures/ws-orbita" }}>
        <Stage options={options} />
      </ChatFileScopeContext.Provider>
    </LocaleContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// 舞台：画框、标注、同屏对照（预览用的外框，不是手机界面本身）
// ---------------------------------------------------------------------------

type Shown =
  | { screen: "pair"; state: PairState }
  | { screen: "list"; scene: MobileOptions["scene"] }
  | { screen: "chat"; state: ChatState };

function Stage(props: { options: MobileOptions }) {
  const { options } = props;
  if (options.screen === "overview") {
    return (
      <main className="m-stage" data-screen="overview">
        <Overview />
      </main>
    );
  }
  const shown: Shown[] =
    options.screen === "sheet"
      ? options.sheetOf === "pair"
        ? PAIR_STATES.map((state) => ({ screen: "pair" as const, state }))
        : options.sheetOf === "chat"
          ? CHAT_STATES.map((state) => ({ screen: "chat" as const, state }))
          : MOBILE_SCENES.map((scene) => ({ screen: "list" as const, scene }))
      : [
          options.screen === "pair"
            ? { screen: "pair" as const, state: options.pairState }
            : options.screen === "chat"
              ? { screen: "chat" as const, state: options.chatState }
              : { screen: "list" as const, scene: options.scene },
        ];
  return (
    <main className="m-stage">
      {shown.map((item) => (
        <Figure key={JSON.stringify(item)} device={options.device} shown={item} tall={options.tall} />
      ))}
      {options.compare && (
        <DesktopFigure theme={options.theme} openSession={shown[0]?.screen === "chat"} />
      )}
    </main>
  );
}

function Figure(props: { device: MobileDevice; shown: Shown; tall: boolean }) {
  const t = useT();
  const { shown } = props;
  const size = props.device === "android" ? "412 × 915" : "744 × 1133";
  const state =
    shown.screen === "pair"
      ? t.mobile.stage.pairState[shown.state]
      : shown.screen === "chat"
        ? t.mobile.stage.chatState[shown.state]
        : t.mobile.stage.scene[shown.scene];
  const tall = props.tall && shown.screen === "list";
  return (
    <figure className="m-figure">
      <figcaption className="m-caption">
        {t.mobile.stage[props.device]} {size} · {t.mobile.stage.screen[shown.screen]} · {state}
        {tall && ` · ${t.mobile.stage.tall}`}
      </figcaption>
      <Device device={props.device} tall={tall}>
        <PhoneApp device={props.device} shown={shown} />
      </Device>
    </figure>
  );
}

/** 手机外框：状态栏（刘海安全区）+ 屏幕 + 手势条安全区。外框本身是预览道具，不是界面 */
function Device(props: { device: MobileDevice; tall: boolean; children: React.ReactNode }) {
  return (
    <div className="m-device" data-device={props.device} data-tall={props.tall || undefined}>
      <div className="m-statusbar" aria-hidden="true">
        <span className="m-clock">{MOBILE_CLOCK}</span>
      </div>
      <div className="m-viewport">{props.children}</div>
      <div className="m-gesture" aria-hidden="true">
        <span />
      </div>
    </div>
  );
}

/**
 * 同屏对照：同一主题的桌面预览（真实 App + fixture），缩到 0.7 放在手机旁边。
 * 画对话屏时，iframe 里点开侧栏第一条会话，让桌面也落在对话视图上。
 */
function DesktopFigure(props: { theme: MobileOptions["theme"]; openSession: boolean }) {
  const t = useT();
  const ref = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (!props.openSession) return undefined;
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      const row = ref.current?.contentDocument?.querySelector<HTMLElement>(".task-row .option-row, .task-row button");
      if (row !== null && row !== undefined) {
        row.click();
        window.clearInterval(timer);
      } else if (tries > 40) {
        window.clearInterval(timer);
      }
    }, 150);
    return () => window.clearInterval(timer);
  }, [props.openSession]);
  return (
    <figure className="m-figure">
      <figcaption className="m-caption">{t.mobile.stage.desktop} · 1280 × 800 · 70%</figcaption>
      <div className="m-desk">
        <iframe
          ref={ref}
          title={t.mobile.stage.desktop}
          src={`/preview.html?scene=typical&theme=${props.theme}&lang=zh`}
        />
      </div>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// 手机应用：安卓一屏一页；iPad mini 竖屏左清单、右对话（同桌面的侧栏 + 对话）
// ---------------------------------------------------------------------------

type View = { kind: "list" } | { kind: "chat"; chat: MobileChat };

/** 点清单里的某一行打开哪份对话：有专门稿子的用稿子，其余按状态借一份、标题换成这一行的 */
function chatFor(row: MobileSession, wsName: string | null): MobileChat {
  const fromState = row.state === "running" ? "full" : row.state === "waiting" ? "waiting" : "typical";
  const base = mobileChat(fromState);
  return base.session.id === row.id ? base : { ...base, session: row, workspaceName: wsName };
}

function PhoneApp(props: { device: MobileDevice; shown: Shown }) {
  const { shown } = props;
  // 对话屏的清单（iPad 左栏）跟对话同一份数据：满载的对话配满载的清单，选中行才对得上
  const list = mobileList(
    shown.screen === "list"
      ? shown.scene
      : shown.screen === "chat" && (shown.state === "full" || shown.state === "reply-running")
        ? "full"
        : "typical",
  );
  const initial: View =
    shown.screen === "chat" ? { kind: "chat", chat: mobileChat(shown.state) } : { kind: "list" };
  const [view, setView] = useState<View>(initial);
  if (shown.screen === "pair") return <PairScreen state={shown.state} wide={props.device === "ipad"} />;
  const chatState: ChatState | null = shown.screen === "chat" ? shown.state : null;
  const open = (row: MobileSession, wsName: string | null) => setView({ kind: "chat", chat: chatFor(row, wsName) });

  if (props.device === "ipad") {
    return (
      <div className="m-split">
        <ListScreen
          data={list}
          selectedId={view.kind === "chat" ? view.chat.session.id : null}
          onOpen={open}
        />
        {view.kind === "chat" ? (
          <ChatScreen chat={view.chat} state={chatState ?? "typical"} onBack={null} />
        ) : (
          <div className="m-screen m-pane-empty">
            <div className="m-well">
              {list.workspaces.length > 0 && <PickHint list={list} />}
            </div>
          </div>
        )}
      </div>
    );
  }
  if (view.kind === "chat") {
    return <ChatScreen chat={view.chat} state={chatState ?? "typical"} onBack={() => setView({ kind: "list" })} />;
  }
  return <ListScreen data={list} selectedId={null} onOpen={open} />;
}

/** iPad 右栏还没选会话：一句空态，有人在等就说几件 */
function PickHint(props: { list: MobileListData }) {
  const t = useT();
  const waiting = allSessions(props.list).filter((item) => item.state === "waiting" || item.state === "failed").length;
  return (
    <PanelEmpty icon="message-square" className="m-empty">
      {waiting > 0 ? t.mobile.list.pickWaiting(waiting) : t.mobile.list.pickAny}
    </PanelEmpty>
  );
}

// ---------------------------------------------------------------------------
// 配对
// ---------------------------------------------------------------------------

function PairScreen(props: { state: PairState; wide: boolean }) {
  const t = useT();
  const filled = props.state !== "empty";
  const [address, setAddress] = useState(filled ? HOST.address : "");
  const [code, setCode] = useState(filled ? PAIR_CODE : "");
  return (
    <div className="m-screen m-pair" data-wide={props.wide || undefined}>
      <div className="m-pair-col">
        <p className="m-wordmark">orbita</p>
        <h1 className="m-pair-title">{t.mobile.pair.title}</h1>
        <p className="m-pair-lead">{t.mobile.pair.lead}</p>
        <label className="m-field">
          <span className="m-field-label">{t.mobile.pair.hostLabel}</span>
          <input
            className="text-field m-input-line"
            value={address}
            placeholder={t.mobile.pair.hostPlaceholder}
            onChange={(event) => setAddress(event.target.value)}
            aria-invalid={props.state === "offline" || undefined}
          />
        </label>
        <label className="m-field">
          <span className="m-field-label">{t.mobile.pair.codeLabel}</span>
          <input
            className="text-field m-input-line m-code"
            value={code}
            inputMode="numeric"
            placeholder="000 000"
            onChange={(event) => setCode(event.target.value)}
            aria-invalid={props.state === "expired" || undefined}
          />
          <span className="m-field-hint">{t.mobile.pair.codeWhere}</span>
        </label>
        <button type="button" className="btn-accent m-primary" disabled={address.trim() === "" || code.trim() === ""}>
          {t.mobile.pair.connect}
        </button>
        <div className="m-pair-note">
          {props.state === "empty" && (
            <PanelEmpty icon="laptop" hint={t.mobile.pair.emptyHint}>
              {t.mobile.pair.empty}
            </PanelEmpty>
          )}
          {props.state === "expired" && (
            <PanelEmpty tone="danger" icon="key" hint={t.mobile.pair.expiredHint}>
              {t.mobile.pair.expired}
            </PanelEmpty>
          )}
          {props.state === "offline" && (
            <PanelEmpty
              tone="danger"
              icon="wifi-off"
              hint={t.mobile.pair.offlineHint}
              exit={{ label: t.mobile.pair.retry, onClick: () => undefined }}
            >
              {t.mobile.pair.offline(HOST.address)}
            </PanelEmpty>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 会话清单
// ---------------------------------------------------------------------------

/** 顶上三组的上限：等你给 4 行（它最要紧），在跑与做完没看各 3 行，超出的就地展开 */
const GROUP_CAPS = { waiting: 4, running: 3, done: 3 } as const;
type GroupId = keyof typeof GROUP_CAPS;
/** 一个工作区收起时的汇总顺序（同桌面侧栏 ws-agg）：等你 › 出错 › 在跑 › 做完 */
const AGG_ORDER: readonly PieFill[] = ["waiting", "failed", "running", "done"];

function HostBar(props: { host: MobileHost }) {
  const t = useT();
  return (
    <header className="m-bar">
      <span className="m-bar-glyph">
        <Icon name="laptop" size={16} strokeWidth={1.8} />
      </span>
      <span className="m-bar-main">
        <span className="m-bar-title">{props.host.name}</span>
        <span className="m-bar-sub">
          {props.host.online ? t.mobile.host.online : t.mobile.host.offline} ·{" "}
          {props.host.net === "tailscale" ? t.mobile.host.tailscale : t.mobile.host.lan}
        </span>
      </span>
    </header>
  );
}

function ListScreen(props: {
  data: MobileListData;
  selectedId: string | null;
  onOpen: (row: MobileSession, wsName: string | null) => void;
}) {
  const t = useT();
  const { data } = props;
  const wsName = (id: string | null): string | null => data.workspaces.find((ws) => ws.id === id)?.name ?? null;
  const all = allSessions(data).sort((a, b) => b.updatedAt - a.updatedAt);
  const rank = (state: MobileSession["state"]) => (state === "waiting" ? 0 : 1);
  const groups: { id: GroupId; rows: MobileSession[] }[] = [
    { id: "waiting" as const, rows: all.filter((item) => item.state === "waiting" || item.state === "failed").sort((a, b) => rank(a.state) - rank(b.state)) },
    { id: "running" as const, rows: all.filter((item) => item.state === "running") },
    { id: "done" as const, rows: all.filter((item) => item.state === "done") },
  ].filter((group) => group.rows.length > 0);
  const empty = data.workspaces.length === 0 && data.loose.length === 0;
  return (
    <div className="m-screen m-list">
      <HostBar host={data.host} />
      <div className="m-scroll">
        {empty ? (
          <PanelEmpty icon="messages-square" hint={t.mobile.list.emptyHint} className="m-empty">
            {t.mobile.list.empty}
          </PanelEmpty>
        ) : (
          <>
            {groups.map((group) => (
              <AttentionGroup
                key={group.id}
                id={group.id}
                rows={group.rows}
                wsName={wsName}
                selectedId={props.selectedId}
                onOpen={props.onOpen}
              />
            ))}
            <section className="m-group" aria-label={t.mobile.list.workspaces}>
              <h2 className="m-group-head">{t.mobile.list.workspaces}</h2>
              {byActivity(data.workspaces).map((ws) => (
                <WorkspaceRow
                  key={ws.id}
                  ws={ws}
                  initiallyOpen={false}
                  selectedId={props.selectedId}
                  onOpen={(row) => props.onOpen(row, ws.name)}
                />
              ))}
              {data.loose.length > 0 && (
                <WorkspaceRow
                  ws={{ id: "loose", name: t.mobile.list.tasks, total: data.looseTotal, sessions: data.loose }}
                  loose
                  initiallyOpen={false}
                  selectedId={props.selectedId}
                  onOpen={(row) => props.onOpen(row, null)}
                />
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

/** 工作区按最近一次活动排（不按名字）：量一多，刚动过的总在上面，三个月没碰的自己沉到底 */
function byActivity(list: readonly MobileWorkspace[]): MobileWorkspace[] {
  const latest = (ws: MobileWorkspace) => Math.max(0, ...ws.sessions.map((item) => item.updatedAt));
  return [...list].sort((a, b) => latest(b) - latest(a));
}

function AttentionGroup(props: {
  id: GroupId;
  rows: MobileSession[];
  wsName: (id: string | null) => string | null;
  selectedId: string | null;
  onOpen: (row: MobileSession, wsName: string | null) => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const cap = GROUP_CAPS[props.id];
  const shown = expanded ? props.rows : props.rows.slice(0, cap);
  const rest = props.rows.length - cap;
  return (
    <section className="m-group" aria-label={t.mobile.list.group[props.id]}>
      <h2 className="m-group-head">{t.mobile.list.group[props.id]}</h2>
      {shown.map((row) => {
        const where = props.wsName(row.workspaceId);
        return (
          <button
            key={row.id}
            type="button"
            className="m-row option-row"
            aria-selected={props.selectedId === row.id || undefined}
            onClick={() => props.onOpen(row, where)}
          >
            <span className="m-slot">{row.state !== null && <StatusPie state={row.state} />}</span>
            <span className="m-row-main">
              <span className="m-row-title">{row.title}</span>
              <span className="m-row-line">
                {where !== null && <span className="m-row-where">{where} · </span>}
                <InlineMarks text={row.line} />
              </span>
            </span>
            <RowTrailing row={row} />
          </button>
        );
      })}
      {rest > 0 && (
        <button type="button" className="m-more option-row" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          <span className="m-slot">
            <Icon name={expanded ? "chevron-up" : "chevron-down"} size={14} strokeWidth={1.8} />
          </span>
          {expanded ? t.mobile.list.less : t.mobile.list.more(rest)}
        </button>
      )}
    </section>
  );
}

/** 行尾：做完 / 空闲写多久前；在跑 / 等你不写时间（不走的「刚刚」比没有更糟）；挂着子会话写个数 */
function RowTrailing(props: { row: MobileSession }) {
  const t = useT();
  const { row } = props;
  if (row.subRunning > 0) {
    return (
      <span className="m-trailing row-trailing" title={t.mobile.list.subRunning(row.subRunning)}>
        <Icon name="bot" size={12} strokeWidth={1.8} />
        {row.subRunning}
      </span>
    );
  }
  if (row.state === "running" || row.state === "waiting") return null;
  return <span className="m-trailing row-trailing">{sessionAgeLabel(row.updatedAt, MOBILE_NOW, t)}</span>;
}

function WorkspaceRow(props: {
  ws: MobileWorkspace;
  loose?: boolean;
  initiallyOpen: boolean;
  selectedId: string | null;
  onOpen: (row: MobileSession) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(props.initiallyOpen);
  const { ws } = props;
  const agg = AGG_ORDER.map((state) => ({ state, count: ws.sessions.filter((item) => item.state === state).length })).filter(
    (item) => item.count > 0,
  );
  const page = ws.sessions.slice(0, MOBILE_PAGE);
  const older = ws.total - page.length;
  const glyph: IconName = props.loose === true ? "message-square" : open ? "folder-open" : "folder";
  return (
    <div className="m-ws">
      <button type="button" className="m-ws-head option-row" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="m-slot">
          <Icon name={glyph} size={14} strokeWidth={1.8} />
        </span>
        <span className="m-ws-name">{ws.name}</span>
        {!open && agg.length > 0 && (
          <span className="run-agg ws-agg m-agg row-trailing">
            {agg.map((item) => (
              <span key={item.state}>
                <StatusPie state={item.state} />
                {item.count}
              </span>
            ))}
          </span>
        )}
      </button>
      {open && (
        <div className="m-ws-children">
          {page.map((row) => (
            <button
              key={row.id}
              type="button"
              className="m-trow option-row"
              aria-selected={props.selectedId === row.id || undefined}
              onClick={() => props.onOpen(row)}
            >
              <span className="m-slot">{row.state !== null && <StatusPie state={row.state} />}</span>
              <span className="m-trow-title">{row.title}</span>
              <span className="m-trailing row-trailing">
                {row.state === "running" || row.state === "waiting" ? null : sessionAgeLabel(row.updatedAt, MOBILE_NOW, t)}
              </span>
            </button>
          ))}
          {older > 0 && (
            <button type="button" className="m-trow m-older option-row">
              <span className="m-slot">
                <Icon name="history" size={14} strokeWidth={1.8} />
              </span>
              <span className="m-trow-title">{t.mobile.list.older(older)}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 对话
// ---------------------------------------------------------------------------

function clockOf(ms: number): string {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

function ChatScreen(props: { chat: MobileChat; state: ChatState; onBack: (() => void) | null }) {
  const t = useT();
  const { chat, state } = props;
  const running = chat.session.state === "running";
  const [draft, setDraft] = useState(state === "reply-running" ? REPLY_DRAFT : "");
  const [queued, setQueued] = useState<string[]>(state === "reply-running" ? [REPLY_QUEUED] : []);
  const offline = state === "reconnecting";
  const loading = state === "loading";
  const sendable = draft.trim() !== "" && !offline;
  const stopping = running && !sendable && !offline;
  const stateWord = t.mobile.chat.state[chat.session.state ?? "idle"];
  // 读尾部：打开就停在最后一条（手机上读的是「现在到哪了」），往上翻才看到「载入更早的」
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return undefined;
    const pin = () => {
      el.scrollTop = el.scrollHeight;
    };
    pin();
    // 正文里的图与代码高亮是异步长出来的：跟着长高继续钉在底部，手指一碰就交还给手指
    const observer = new ResizeObserver(pin);
    for (const child of Array.from(el.children)) observer.observe(child);
    const release = () => observer.disconnect();
    const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    for (const type of events) el.addEventListener(type, release, { once: true, passive: true });
    return () => {
      observer.disconnect();
      for (const type of events) el.removeEventListener(type, release);
    };
  }, [chat, state]);
  const shownEntries = chat.entries;
  const placeholder = offline
    ? t.mobile.chat.placeholderOffline
    : running
      ? t.mobile.chat.placeholderRunning
      : t.mobile.chat.placeholder;
  return (
    <div className="m-screen m-chat">
      <header className="m-bar m-chat-bar">
        {props.onBack !== null && (
          <IconButton label={t.mobile.chat.back} size="var(--m-touch)" onClick={props.onBack} className="m-back">
            <Icon name="chevron-left" size={16} />
          </IconButton>
        )}
        <span className="m-bar-main">
          <span className="m-bar-title">{chat.session.title}</span>
          <span className="m-bar-sub">
            {chat.session.state !== null && <StatusPie state={chat.session.state} />}
            {stateWord}
            {chat.workspaceName !== null && ` · ${chat.workspaceName}`}
          </span>
        </span>
      </header>
      <div className="m-well">
        {offline && (
          <div className="m-notice">
            <PanelEmpty icon="wifi-off" hint={t.mobile.chat.reconnectingHint}>
              {t.mobile.chat.reconnecting}
            </PanelEmpty>
          </div>
        )}
        <div ref={scrollRef} className="m-scroll m-transcript">
          {loading ? (
            <PanelEmpty busy className="m-empty">
              {t.mobile.chat.loading}
            </PanelEmpty>
          ) : (
            <>
              {chat.total > shownEntries.length && (
                <PanelEmpty icon="history" exit={{ label: t.mobile.chat.loadEarlier, onClick: () => undefined }} className="m-tail">
                  {t.mobile.chat.tail(MOBILE_TAIL)}
                </PanelEmpty>
              )}
              {shownEntries.map((entry, index) => (
                <Entry key={index} entry={entry} />
              ))}
            </>
          )}
        </div>
        <footer className="m-ledge">
          {chat.session.state === "waiting" && !loading && (
            <p className="m-hint">
              <Icon name="list-todo" size={14} strokeWidth={1.8} />
              <span>{t.mobile.chat.planWaiting}</span>
            </p>
          )}
          {queued.map((text, index) => (
            <div key={index} className="m-queue">
              <Icon name="clock" size={14} strokeWidth={1.8} />
              <span className="m-queue-text">{text}</span>
              <span className="m-trailing row-trailing">{t.mobile.chat.queued}</span>
            </div>
          ))}
          <div className="glass-card m-composer">
            <textarea
              className="m-input"
              rows={draft === "" ? 1 : 2}
              value={draft}
              placeholder={placeholder}
              disabled={loading}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button
              type="button"
              className="btn-accent m-send"
              data-tone={stopping ? "danger" : undefined}
              aria-label={sendable ? t.mobile.chat.send : stopping ? t.mobile.chat.stop : t.mobile.chat.send}
              disabled={loading || (!sendable && !stopping)}
              onClick={() => {
                if (!sendable) return;
                if (running) setQueued((list) => [...list, draft.trim()]);
                setDraft("");
              }}
            >
              <Icon name={stopping ? "square" : "arrow-up"} size={stopping ? 12 : 16} />
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function Entry(props: { entry: MobileEntry }) {
  const t = useT();
  const { entry } = props;
  if (entry.kind === "user") {
    return (
      <div className="m-user">
        <div className="user-bubble">
          <MarkdownBlock text={entry.text} variant="bubble" />
        </div>
        <span className="user-msg-time m-time">{clockOf(entry.at)}</span>
      </div>
    );
  }
  if (entry.kind === "prose") {
    return (
      <div className="assistant-prose">
        <MarkdownBlock text={entry.text} />
      </div>
    );
  }
  if (entry.kind === "process") {
    return (
      <button type="button" className="collapse-row-btn m-proc" aria-expanded={false}>
        <span className="proc-head-row">
          <span className="proc-say">
            <span className="proc-worked">{entry.worked}</span>
            <span className="proc-sep">·</span>
            <span className="proc-what">{entry.what}</span>
            {entry.failed !== undefined && <span className="proc-quiet">{t.chat.processQuietFailed(entry.failed)}</span>}
            <Icon name="chevron-right" size={13} strokeWidth={1.8} />
          </span>
        </span>
      </button>
    );
  }
  return (
    <div className="proc-live-wrap">
      <button type="button" className="proc-live" aria-expanded={false}>
        <div className="proc-who">
          <span className="proc-doing orbita-breath">
            <InlineMarks text={entry.doing} />…
          </span>
          <span className="proc-time">{entry.clock}</span>
          <Icon name="chevron-right" size={13} strokeWidth={1.8} />
        </div>
        <div className="proc-idea">
          <Icon name="lightbulb" size={13} strokeWidth={1.8} />
          <span>
            <InlineMarks text={entry.idea} />
          </span>
        </div>
        <div className="proc-foot">{entry.foot}</div>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 总览图
// ---------------------------------------------------------------------------

function Overview() {
  const t = useT();
  const o = t.mobile.overview;
  const ports: readonly [IconName, string][] = [
    ["list", o.portList],
    ["scroll-text", o.portTail],
    ["message-square", o.portReply],
    ["square", o.portStop],
  ];
  const notNow: readonly [IconName, string][] = [
    ["bell", o.notNowItems.push],
    ["shield-check", o.notNowItems.approve],
    ["mic", o.notNowItems.voice],
    ["file-text", o.notNowItems.files],
    ["terminal", o.notNowItems.terminal],
  ];
  return (
    <section className="m-ov">
      <h1 className="m-ov-title">{o.title}</h1>
      <div className="m-ov-map">
        <div className="glass-card m-ov-node">
          <span className="m-ov-head">
            <Icon name="smartphone" size={16} strokeWidth={1.8} />
            {o.phone}
          </span>
          <span className="m-ov-quiet">{o.phoneWhich}</span>
          <span className="m-ov-keeps">
            <Icon name="key" size={14} strokeWidth={1.8} />
            {o.phoneKeeps}
          </span>
        </div>
        <div className="m-ov-link">
          <span className="m-ov-net">{o.net}</span>
          <span className="m-ov-wire" aria-hidden="true" />
          <div className="m-ov-ports" aria-label={o.ports}>
            <span className="m-ov-ports-head">{o.ports}</span>
            {ports.map(([icon, label]) => (
              <span key={label} className="m-ov-port">
                <Icon name={icon} size={14} strokeWidth={1.8} />
                {label}
              </span>
            ))}
          </div>
          <span className="m-ov-wire" aria-hidden="true" />
          <span className="m-ov-quiet m-ov-pairing">
            <Icon name="plug" size={14} strokeWidth={1.8} />
            {o.pairing}
          </span>
        </div>
        <div className="glass-card m-ov-node">
          <span className="m-ov-head">
            <Icon name="cpu" size={16} strokeWidth={1.8} />
            {o.host}
          </span>
          <span className="m-ov-sub">
            <Icon name="laptop" size={14} strokeWidth={1.8} />
            {o.hostNow}
          </span>
          <span className="m-ov-sub m-ov-later">
            <Icon name="server" size={14} strokeWidth={1.8} />
            {o.hostLater}
          </span>
          <span className="m-ov-keeps">
            <Icon name="lock" size={14} strokeWidth={1.8} />
            {o.hostKeeps}
          </span>
        </div>
      </div>
      <div className="m-ov-notnow">
        <span className="m-ov-ports-head">{o.notNow}</span>
        {notNow.map(([icon, label]) => (
          <span key={label} className="m-ov-port">
            <Icon name={icon} size={14} strokeWidth={1.8} />
            {label}
          </span>
        ))}
      </div>
    </section>
  );
}
