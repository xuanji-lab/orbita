import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { effectiveLanguage } from "@shared/settings";
import { LocaleContext, htmlLang, useT } from "../../locale.ts";
import { Icon, type IconName } from "../../shell/Icon";
import { IconButton } from "../../shell/IconButton";
import { InlineMarks } from "../../shell/InlineMarks";
import { PanelEmpty } from "../../shell/PanelEmpty";
import { StatusPie } from "../../shell/StatusPie";
import { sessionAgeLabel } from "../../shell/relative-time.ts";
import { MarkdownBlock } from "../../features/chat/MarkdownBlock";
import { ChatFileScopeContext } from "../../features/chat/chat-file-scope.ts";
import {
  HOST,
  MOBILE_CLOCK,
  MOBILE_NOW,
  MOBILE_PAGE,
  MOBILE_SYNCED,
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
 * 手机上能做的只有四件事：列任务、读尾部、回一句、停止。没有审批、语音、文件、终端。
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

/** 舞台上每台设备共用的那几个开关（断线、先展开哪个工作区、整列） */
interface Knobs {
  tall: boolean;
  offline: boolean;
  open: string | null;
}

const DEVICE_SIZE: Readonly<Record<MobileDevice, string>> = {
  android: "412 × 915",
  "android-s": "360 × 780",
  ipad: "744 × 1133",
};

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
  const knobs: Knobs = { tall: options.tall, offline: options.offline, open: options.open };
  const first = shown[0];
  return (
    <main className="m-stage">
      {shown.map((item) => (
        <Figure key={JSON.stringify(item)} device={options.device} shown={item} knobs={knobs} />
      ))}
      {options.compare && first !== undefined && first.screen !== "pair" && (
        <DesktopFigure theme={options.theme} open={first.screen === "chat" ? mobileChat(first.state).session : null} />
      )}
    </main>
  );
}

function Figure(props: { device: MobileDevice; shown: Shown; knobs: Knobs }) {
  const t = useT();
  const { shown, knobs } = props;
  const state =
    shown.screen === "pair"
      ? t.mobile.stage.pairState[shown.state]
      : shown.screen === "chat"
        ? t.mobile.stage.chatState[shown.state]
        : t.mobile.stage.scene[shown.scene];
  const tall = knobs.tall && shown.screen === "list";
  const extra = [
    knobs.offline && shown.screen === "list" ? t.mobile.stage.offline : null,
    knobs.open !== null && shown.screen === "list" ? t.mobile.stage.expanded(knobs.open.replace(/^ws-/, "")) : null,
    tall ? t.mobile.stage.tall : null,
  ].filter((item) => item !== null);
  return (
    <figure className="m-figure">
      <figcaption className="m-caption">
        {t.mobile.stage[props.device]} {DEVICE_SIZE[props.device]} · {t.mobile.stage.screen[shown.screen]} · {state}
        {extra.map((item) => ` · ${item}`).join("")}
      </figcaption>
      <Device device={props.device} tall={tall}>
        <PhoneApp device={props.device} shown={shown} knobs={knobs} />
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
 * 桌面侧用 `mirror=mobile`：典型 fixture 里混进手机稿的同一批任务（同标题、同状态，在跑与等你由 fixture
 * 发 agent 事件点亮），首页记录与侧栏的状态饼才有东西可比。画对话屏时在 iframe 里打开同一条任务：
 * 首页记录里有就点那一行，没有就先展开它所在的工作区再点。
 */
function DesktopFigure(props: { theme: MobileOptions["theme"]; open: MobileSession | null }) {
  const t = useT();
  const ref = useRef<HTMLIFrameElement>(null);
  const title = props.open?.title ?? null;
  useEffect(() => {
    if (title === null) return undefined;
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      const doc = ref.current?.contentDocument;
      if (doc === null || doc === undefined || tries > 60) {
        if (tries > 60) window.clearInterval(timer);
        return;
      }
      const rows = Array.from(doc.querySelectorAll<HTMLElement>(".log-row, .task-row button"));
      const hit = rows.find((row) => row.textContent?.includes(title) === true);
      if (hit !== undefined) {
        hit.click();
        window.clearInterval(timer);
        return;
      }
      // 不在首页记录里：展开名字是 orbita 的工作区（收着的才点）
      const heads = Array.from(doc.querySelectorAll<HTMLElement>(".ws-head"));
      const head = heads.find((item) => item.textContent?.includes("orbita") === true);
      const fold = head?.querySelector<HTMLElement>(".ws-fold[aria-expanded='false']");
      fold?.click();
    }, 200);
    return () => window.clearInterval(timer);
  }, [title]);
  return (
    <figure className="m-figure">
      <figcaption className="m-caption">{t.mobile.stage.desktop} · 1280 × 800 · 70%</figcaption>
      <div className="m-desk">
        <iframe
          ref={ref}
          title={t.mobile.stage.desktop}
          src={`/preview.html?scene=typical&mirror=mobile&theme=${props.theme}&lang=zh`}
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

/** 跑完 / 出错的任务被打开过（任意一端都算，未读标记在会话 meta 里、两端共享） */
function unreadKind(row: MobileSession): boolean {
  return row.state === "done" || row.state === "failed";
}

function PhoneApp(props: { device: MobileDevice; shown: Shown; knobs: Knobs }) {
  const { shown, knobs } = props;
  // 对话屏的清单（iPad 左栏）跟对话同一份数据：满载的对话配满载的清单，选中行才对得上
  const list = mobileList(
    shown.screen === "list"
      ? shown.scene
      : shown.screen === "chat" && (shown.state === "full" || shown.state === "reply-running")
        ? "full"
        : "typical",
  );
  const initialChat = shown.screen === "chat" ? mobileChat(shown.state) : null;
  const [view, setView] = useState<View>(initialChat === null ? { kind: "list" } : { kind: "chat", chat: initialChat });
  // 打开过的跑完 / 出错：选中时只清掉饼、行不动（不在手指下跳走）；返回或切到别的任务时才离组
  const [viewed, setViewed] = useState<ReadonlySet<string>>(
    () => new Set(initialChat !== null && unreadKind(initialChat.session) ? [initialChat.session.id] : []),
  );
  if (shown.screen === "pair") return <PairScreen state={shown.state} wide={props.device === "ipad"} />;
  const chatState: ChatState | null = shown.screen === "chat" ? shown.state : null;
  const offline = knobs.offline || chatState === "reconnecting";
  const open = (row: MobileSession, wsName: string | null) => {
    if (unreadKind(row)) setViewed((set) => new Set([...set, row.id]));
    setView({ kind: "chat", chat: chatFor(row, wsName) });
  };
  const listScreen = (selectedId: string | null) => (
    <ListScreen
      data={list}
      seen={{ viewed, selectedId }}
      offline={offline}
      initiallyOpen={knobs.open}
      onOpen={open}
    />
  );

  if (props.device === "ipad") {
    const empty = list.workspaces.length === 0 && list.loose.length === 0;
    return (
      <div className="m-split">
        {listScreen(view.kind === "chat" ? view.chat.session.id : null)}
        {view.kind === "chat" ? (
          <ChatScreen chat={view.chat} state={chatState ?? "typical"} offline={offline} onBack={null} />
        ) : (
          // 清单是空的：右边也不画纸面井（一整块空白的纸没有话可说）
          <div className="m-screen m-pane-empty">
            {!empty && (
              <div className="m-well">
                <PickHint list={list} />
              </div>
            )}
          </div>
        )}
      </div>
    );
  }
  if (view.kind === "chat") {
    return (
      <ChatScreen chat={view.chat} state={chatState ?? "typical"} offline={offline} onBack={() => setView({ kind: "list" })} />
    );
  }
  return listScreen(null);
}

/** iPad 右栏还没选任务：一句空态，有人在等就说几件 */
function PickHint(props: { list: MobileListData }) {
  const t = useT();
  const waiting = allSessions(props.list).filter((item) => item.state === "waiting").length;
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
        {props.state === "expired" && (
          <div className="m-pair-note">
            <PanelEmpty tone="danger" icon="key" hint={t.mobile.pair.expiredHint}>
              {t.mobile.pair.expired}
            </PanelEmpty>
          </div>
        )}
        {props.state === "offline" && (
          <div className="m-pair-note">
            <PanelEmpty
              tone="danger"
              icon="wifi-off"
              hint={t.mobile.pair.offlineHint}
              exit={{ label: t.mobile.pair.retry, onClick: () => undefined }}
            >
              {t.mobile.pair.offline(HOST.address)}
            </PanelEmpty>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 任务清单
// ---------------------------------------------------------------------------

/**
 * 顶上四组与上限：等你 4（最要紧）、在跑 3、跑完没看 3、出错 3，超出的就地展开。
 * 出错单独成组、排在最后（审查：夜间回归这类任务天天出错，混在「等你」里会把真正等你的挤下去）。
 */
const GROUP_ORDER = ["waiting", "running", "done", "failed"] as const;
type GroupId = (typeof GROUP_ORDER)[number];
const GROUP_CAPS: Readonly<Record<GroupId, number>> = { waiting: 4, running: 3, done: 3, failed: 3 };

interface Seen {
  viewed: ReadonlySet<string>;
  selectedId: string | null;
}

/** 一行此刻画什么饼、进哪一组。打开过的跑完 / 出错：选中时还在原组但不画饼，没选中就离组 */
function effective(row: MobileSession, seen: Seen): { state: MobileSession["state"]; group: GroupId | null } {
  if (row.state === null) return { state: null, group: null };
  if (unreadKind(row) && seen.viewed.has(row.id)) {
    return row.id === seen.selectedId ? { state: null, group: row.state as GroupId } : { state: null, group: null };
  }
  return { state: row.state, group: row.state };
}

function HostBar(props: { host: MobileHost; offline: boolean }) {
  const t = useT();
  return (
    <header className="m-bar" data-stale={props.offline || undefined}>
      <span className="m-bar-glyph">
        <Icon name={props.offline ? "wifi-off" : "laptop"} size={16} strokeWidth={1.8} />
      </span>
      <span className="m-bar-main">
        <span className="m-bar-title">{props.host.name}</span>
        <span className="m-bar-sub">
          {props.offline
            ? `${t.mobile.host.reconnecting} · ${t.mobile.host.lastSync(MOBILE_SYNCED)}`
            : `${t.mobile.host.online} · ${props.host.net === "tailscale" ? t.mobile.host.tailscale : t.mobile.host.lan}`}
        </span>
      </span>
    </header>
  );
}

function ListScreen(props: {
  data: MobileListData;
  seen: Seen;
  offline: boolean;
  initiallyOpen: string | null;
  onOpen: (row: MobileSession, wsName: string | null) => void;
}) {
  const t = useT();
  const { data, seen } = props;
  const wsName = (id: string | null): string | null => data.workspaces.find((ws) => ws.id === id)?.name ?? null;
  const all = allSessions(data).sort((a, b) => b.updatedAt - a.updatedAt);
  const groups = GROUP_ORDER.map((id) => ({ id, rows: all.filter((row) => effective(row, seen).group === id) })).filter(
    (group) => group.rows.length > 0,
  );
  const empty = data.workspaces.length === 0 && data.loose.length === 0;
  return (
    <div className="m-screen m-list" data-stale={props.offline || undefined}>
      <HostBar host={data.host} offline={props.offline} />
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
                seen={seen}
                onOpen={props.onOpen}
              />
            ))}
            <section className="m-group" aria-label={t.mobile.list.workspaces}>
              <h2 className="m-group-head">{t.mobile.list.workspaces}</h2>
              {byActivity(data.workspaces).map((ws) => (
                <WorkspaceRow
                  key={ws.id}
                  ws={ws}
                  initiallyOpen={props.initiallyOpen === ws.id}
                  seen={seen}
                  onOpen={(row) => props.onOpen(row, ws.name)}
                />
              ))}
            </section>
            {data.loose.length > 0 && (
              // 不属于任何工作区的任务：和「工作区」并列的一组（同桌面侧栏），不是工作区里的一行
              <section className="m-group" aria-label={t.mobile.list.tasks}>
                <h2 className="m-group-head">{t.mobile.list.tasks}</h2>
                <TaskRows
                  sessions={data.loose}
                  total={data.looseTotal}
                  seen={seen}
                  onOpen={(row) => props.onOpen(row, null)}
                />
              </section>
            )}
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
  seen: Seen;
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
        const state = effective(row, props.seen).state;
        return (
          <button
            key={row.id}
            type="button"
            className="m-row option-row"
            aria-selected={props.seen.selectedId === row.id || undefined}
            onClick={() => props.onOpen(row, where)}
          >
            <span className="m-slot">{state !== null && <StatusPie state={state} />}</span>
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

/**
 * 行尾：跑完 / 空闲写多久前；在跑 / 等你不写时间（不走的「刚刚」比没有更糟）。
 * 挂着在跑的子会话时只写在跑的个数（手机上没有悬停提示，总数与在跑数分不清，审查 S7）；没有在跑的不写。
 */
function RowTrailing(props: { row: MobileSession }) {
  const t = useT();
  const { row } = props;
  if (row.subRunning > 0) {
    return (
      <span className="m-trailing row-trailing" aria-label={t.mobile.list.subRunning(row.subRunning)}>
        <Icon name="bot" size={12} strokeWidth={1.8} />
        {row.subRunning}
      </span>
    );
  }
  if (row.state === "running" || row.state === "waiting") return null;
  return <span className="m-trailing row-trailing">{sessionAgeLabel(row.updatedAt, MOBILE_NOW, t)}</span>;
}

/**
 * 工作区：一行名字，点开是它的任务。行尾不再汇总状态饼（审查 S4）：亮着的任务顶上几组已经列过，
 * 手机上再数一遍只是满载首屏最密的一串颜色。
 */
function WorkspaceRow(props: {
  ws: MobileWorkspace;
  initiallyOpen: boolean;
  seen: Seen;
  onOpen: (row: MobileSession) => void;
}) {
  const [open, setOpen] = useState(props.initiallyOpen);
  const { ws } = props;
  return (
    <div className="m-ws">
      <button type="button" className="m-ws-head option-row" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="m-slot">
          <Icon name={open ? "folder-open" : "folder"} size={14} strokeWidth={1.8} />
        </span>
        <span className="m-ws-name">{ws.name}</span>
      </button>
      {open && (
        <div className="m-ws-children">
          <TaskRows sessions={ws.sessions} total={ws.total} seen={props.seen} onOpen={props.onOpen} />
        </div>
      )}
    </div>
  );
}

/**
 * 一组任务行（工作区展开后、「任务」组）：已经在顶上几组露过的不再重复，折成一行「另有 N 件在上面」；
 * 名额（MOBILE_PAGE）留给按最近活动排的空闲任务——刚在电脑上看完的那条要能在这里接着回（审查 M3）。
 */
function TaskRows(props: {
  sessions: readonly MobileSession[];
  total: number;
  seen: Seen;
  onOpen: (row: MobileSession) => void;
}) {
  const t = useT();
  const above = props.sessions.filter((row) => effective(row, props.seen).group !== null).length;
  const rest = props.sessions
    .filter((row) => effective(row, props.seen).group === null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const page = rest.slice(0, MOBILE_PAGE);
  const older = props.total - above - page.length;
  return (
    <>
      {above > 0 && (
        <div className="m-trow m-above">
          <span className="m-slot">
            <Icon name="chevron-up" size={14} strokeWidth={1.8} />
          </span>
          <span className="m-trow-title">{t.mobile.list.above(above)}</span>
        </div>
      )}
      {page.map((row) => (
        <button
          key={row.id}
          type="button"
          className="m-trow option-row"
          aria-selected={props.seen.selectedId === row.id || undefined}
          onClick={() => props.onOpen(row)}
        >
          <span className="m-slot" />
          <span className="m-trow-title">{row.title}</span>
          <span className="m-trailing row-trailing">{sessionAgeLabel(row.updatedAt, MOBILE_NOW, t)}</span>
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
    </>
  );
}

// ---------------------------------------------------------------------------
// 对话
// ---------------------------------------------------------------------------

function clockOf(ms: number): string {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/**
 * 对话页。在跑的时候顶栏右侧常驻一颗独立的停止键（2026-11-25 用户拍板「单独放一颗停止键」）：
 * 放顶栏而不放输入框左边——停止和发送是两件相反的事，离开拇指常落的发送键，就不会在想发一句时误停；
 * 键盘弹起时顶栏也还在。右下那颗键只管发送，有字才亮。
 */
function ChatScreen(props: { chat: MobileChat; state: ChatState; offline: boolean; onBack: (() => void) | null }) {
  const t = useT();
  const { chat, state, offline } = props;
  const running = chat.session.state === "running";
  const [draft, setDraft] = useState(state === "reply-running" ? REPLY_DRAFT : "");
  const [queued, setQueued] = useState<string[]>(state === "reply-running" ? [REPLY_QUEUED] : []);
  const loading = state === "loading";
  const sendable = draft.trim() !== "" && !offline && !loading;
  const stateWord = t.mobile.chat.state[chat.session.state ?? "idle"];
  const placeholder = offline
    ? t.mobile.chat.placeholderOffline
    : running
      ? t.mobile.chat.placeholderRunning
      : t.mobile.chat.placeholder;
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
  return (
    <div className="m-screen m-chat">
      <header className="m-bar m-chat-bar" data-stale={offline || undefined}>
        {props.onBack !== null && (
          <IconButton label={t.mobile.chat.back} size="var(--m-touch)" onClick={props.onBack} className="m-back">
            <Icon name="chevron-left" size={16} />
          </IconButton>
        )}
        <span className="m-bar-main">
          <span className="m-bar-title">{chat.session.title}</span>
          <span className="m-bar-sub">
            {chat.session.state !== null && <StatusPie state={chat.session.state} />}
            {offline ? `${stateWord} · ${t.mobile.chat.beforeDisconnect}` : stateWord}
            {chat.workspaceName !== null && ` · ${chat.workspaceName}`}
          </span>
        </span>
        {running && !loading && (
          <IconButton
            label={t.mobile.chat.stop}
            title={t.mobile.chat.stop}
            size="var(--m-touch)"
            disabled={offline}
            className="m-stop"
          >
            <Icon name="circle-stop" size={16} strokeWidth={1.8} />
          </IconButton>
        )}
      </header>
      <div className="m-well">
        {offline && (
          <div className="m-notice">
            <PanelEmpty
              icon="wifi-off"
              hint={t.mobile.chat.reconnectingHint}
              exit={{ label: t.mobile.chat.retry, onClick: () => undefined }}
            >
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
              {chat.total > chat.entries.length && (
                <PanelEmpty icon="history" exit={{ label: t.mobile.chat.loadEarlier, onClick: () => undefined }} className="m-tail">
                  {t.mobile.chat.tail(MOBILE_TAIL)}
                </PanelEmpty>
              )}
              {chat.entries.map((entry, index) => (
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
              aria-label={t.mobile.chat.send}
              disabled={!sendable}
              onClick={() => {
                if (!sendable) return;
                if (running) setQueued((list) => [...list, draft.trim()]);
                setDraft("");
              }}
            >
              <Icon name="arrow-up" size={16} />
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
    ["circle-stop", o.portStop],
  ];
  const notNow: readonly string[] = [
    o.notNowItems.push,
    o.notNowItems.approve,
    o.notNowItems.voice,
    o.notNowItems.files,
    o.notNowItems.terminal,
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
        {notNow.map((label) => (
          <span key={label} className="m-ov-off">
            {label}
          </span>
        ))}
      </div>
    </section>
  );
}
