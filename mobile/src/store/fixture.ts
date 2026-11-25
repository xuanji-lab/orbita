/**
 * 样例数据（只在开发版里能打开）：截「空 / 平常 / 满载」三档的图用，不连电脑、不读任何真实数据。
 *
 * 打开方式：开发版里 `adb shell am start -a android.intent.action.VIEW -d "orbita-mobile://fixture?scene=full&screen=list"`。
 * 参数：scene = empty | typical | full；screen = pair | list | chat；chat = 会话 id；
 * pair = expired | offline | wrongCode | hijacked；offline = 1（断线态）；open = 工作区 id（先展开它）；
 * draft = 1（对话页输入框里放一句草稿）；slow = 1（清单与尾部迟迟不回，截加载态）。
 *
 * 量级照用户的真实用量（任务书与设计稿同一口径）：12 个工作区、近 2000 条根会话——电脑一次只给最近
 * 30 天、最多 200 条（`sessions.list` 的窗口，见 src/main/mobile/summaries.ts），所以满载清单是 200 条、
 * truncated；orbita 一个晚上 17 件亮着（12 件在跑、等你 1、出错 1、跑完没看 3），另有几件大事在别的
 * 工作区，其中一件挂着 43 个在跑的子会话。标题与说法取自设计稿的 fixture（proto/mobile-look）。
 */
import type { MobileMethod, MobileMethodParams, MobileSessionState, SessionSummary, TailEntry } from "../../../src/shared/mobile.ts";
import type { Credentials, PairOutcome } from "../protocol/pair.ts";
import { RequestError, type LinkStatus } from "../protocol/link.ts";
import { AppController, type Transport, type TransportCallbacks } from "./controller.ts";

export interface FixtureParams {
  scene: "empty" | "typical" | "full";
  screen: "pair" | "list" | "chat";
  chat: string | null;
  pair: "expired" | "offline" | "wrongCode" | "hijacked" | null;
  offline: boolean;
  open: string | null;
  draft: boolean;
  /** 清单与尾部迟迟不回（截加载态） */
  slow: boolean;
}

/** `orbita-mobile://fixture?…` → 参数；不是样例链接回 null */
export function parseFixtureUrl(url: string | null): FixtureParams | null {
  if (url === null) return null;
  const match = /^orbita-mobile:\/\/fixture\/?(?:\?(.*))?$/.exec(url);
  if (match === null) return null;
  const query = new Map<string, string>();
  for (const part of (match[1] ?? "").split("&")) {
    const [key, value] = part.split("=");
    if (key !== undefined && key !== "") query.set(key, decodeURIComponent(value ?? ""));
  }
  const scene = query.get("scene");
  const screen = query.get("screen");
  const pair = query.get("pair");
  return {
    scene: scene === "empty" || scene === "full" ? scene : "typical",
    screen: screen === "pair" || screen === "chat" ? screen : "list",
    chat: query.get("chat") ?? null,
    pair: pair === "expired" || pair === "offline" || pair === "wrongCode" || pair === "hijacked" ? pair : null,
    offline: query.get("offline") === "1",
    open: query.get("open") ?? null,
    draft: query.get("draft") === "1",
    slow: query.get("slow") === "1",
  };
}

const MIN = 60_000;
const HOUR = 60 * MIN;

const HOST_NAME = "wafo 的 MacBook Pro";

function makeRow(now: number, id: string, title: string, ws: [string, string] | null, state: MobileSessionState, line: string | null, ago: number, children = 0): SessionSummary {
  return {
    id,
    title,
    workspaceId: ws?.[0] ?? null,
    workspaceName: ws?.[1] ?? null,
    state,
    lastLine: line,
    updatedAt: now - ago,
    childrenRunning: children,
  };
}

const ORBITA: [string, string] = ["ws-orbita", "orbita"];
const THESIS: [string, string] = ["ws-thesis", "博士论文"];

function typical(now: number): SessionSummary[] {
  return [
    makeRow(now, "m-plan", "手机端第一刀：配对与会话清单", ORBITA, "waiting", "计划写好了，等你确认后开工", 6 * MIN),
    makeRow(now, "m-migrate", "迁内核到 pi-durable：会话迁移脚本", ORBITA, "running", "第 3 步：把 1973 条旧会话写进 SQLite", MIN, 43),
    makeRow(now, "m-win", "修 Windows 打包脚本", ORBITA, "running", "运行 bun run dist:win", 2 * MIN),
    makeRow(now, "m-review", "审 PR 565：子会话残留的在跑标记", ORBITA, "done", "看完了，两处要改：通道关闭时没清 running", 48 * MIN),
    makeRow(now, "m-notes", "整理 11 月的验收清单", ORBITA, "idle", "把这周合进去的 PR 列一遍", 50 * HOUR),
    makeRow(now, "m-lit", "第三章文献综述 · 立场分组", THESIS, "idle", "把 12 篇按立场分三组", 5 * HOUR),
  ];
}

const WORKSPACES: readonly (readonly [string, string, number])[] = [
  ["ws-orbita", "orbita", 72],
  ["ws-thesis", "博士论文", 24],
  ["ws-vault", "研究库", 18],
  ["ws-intent", "intent-lab", 13],
  ["ws-planet", "行星造物", 6],
  ["ws-urban", "城市智能论文", 15],
  ["ws-reading", "读书笔记", 9],
  ["ws-xhs", "小红书", 7],
  ["ws-capcut", "视频剪辑", 4],
  ["ws-design", "设计系统", 11],
  ["ws-server", "服务器运维", 5],
  ["ws-teaching", "助教", 3],
];

const ORBITA_NIGHT: readonly (readonly [string, MobileSessionState, string, number, number])[] = [
  ["手机端第一刀：配对与会话清单", "waiting", "计划写好了，等你确认后开工", 4, 0],
  ["夜间回归：Windows 打包", "failed", "出错停下了：下载 NSIS 超时（ETIMEDOUT）", 11, 0],
  ["迁内核到 pi-durable：会话迁移脚本", "running", "第 3 步：把 1973 条旧会话写进 SQLite", 1, 43],
  ["性能：切会话卡顿", "running", "读取 session-states.ts", 1, 6],
  ["子会话面板 40 条时的滚动", "running", "运行 bun run test", 2, 0],
  ["设计系统：中性灰的对比度复核", "running", "在想：玄档三级墨落在卡面上够不够 4.5", 3, 0],
  ["自动化归档：保留最近 30 次", "running", "改 automation-store.ts", 3, 0],
  ["看板卡片：四档尺寸", "running", "截图核对 sm / md / lg / xl", 5, 0],
  ["权限：只留「放行」一档", "running", "运行 bun run typecheck", 6, 0],
  ["PDF 阅读器：引用跳转", "running", "读取 reader/anchors.ts", 7, 0],
  ["外部会话只读导入", "running", "在想：Kimi Work 的存储格式", 8, 0],
  ["语音：豆包连接重试", "running", "改 voice/doubao.ts", 9, 0],
  ["关系图谱：影响面卡", "running", "运行 python3 atlas/check.py", 12, 0],
  ["Release notes：0.9.4", "running", "整理合入的 17 个 PR", 14, 0],
  ["审 PR 561：右栏记忆", "done", "看完了：一处竞态，切会话时旧请求回来覆盖新面板", 26, 0],
  ["配额条：Claude 的周额度", "done", "加好了，周额度和 5 小时额度分两行", 52, 0],
  ["修 git 面板的空仓库", "done", "改完了：空仓库显示「还没有提交」", 70, 0],
];

const ELSEWHERE: readonly (readonly [string, string, MobileSessionState, string, number, number])[] = [
  ["ws-thesis", "第三章文献综述 · 立场分组", "waiting", "想确认：「城市数字孪生」归哪一派？", 18, 12],
  ["ws-thesis", "第二章：图表重画", "running", "运行 python3 figures/fig2.py", 4, 0],
  ["ws-urban", "投稿前自查：引用格式", "running", "核对 references.bib 的 86 条", 9, 3],
  ["ws-vault", "本周论文 digest", "done", "写好了：8 篇，两篇值得细读", 95, 0],
  ["ws-server", "TRX40 显卡驱动升级", "failed", "出错停下了：nvidia-smi 找不到设备", 130, 0],
  ["ws-intent", "意图召回：评测集", "done", "跑完了：召回率 0.71，比上周高 0.06", 160, 0],
];

const IDLE_TOPICS = ["修一下", "看看为什么", "整理", "复盘", "写一版", "对照", "核对", "补测试", "改文案", "调研"];
const IDLE_OBJECTS = ["侧栏的展开状态", "上周的验收截图", "引用格式", "启动速度", "通知的去重", "配色", "导出 PDF 的分页", "会话标题", "空态文案", "快捷键表", "打包脚本", "第四章提纲", "实验记录", "图 3 的配色"];

/** 满载：电脑给的 200 条窗口（12 个工作区 + 「任务」组），truncated */
function full(now: number): SessionSummary[] {
  const rows: SessionSummary[] = [];
  ORBITA_NIGHT.forEach(([title, state, line, ago, children], i) => {
    const id = i === 2 ? "m-migrate" : i === 0 ? "m-plan" : `orbita-night-${i}`;
    rows.push(makeRow(now, id, title, ORBITA, state, line, ago * MIN, children));
  });
  rows.push(makeRow(now, "orbita-recent-0", "调对话页的表格横向滚动", ORBITA, "idle", "表格在窄屏里横向滚动", 3 * MIN));
  rows.push(makeRow(now, "orbita-recent-1", "对一下 0.9.4 的发版清单", ORBITA, "idle", "把这周合进去的 17 个 PR 列一遍", 41 * MIN));
  rows.push(makeRow(now, "m-review", "审 PR 565：子会话残留的在跑标记", ORBITA, "idle", "看完了，两处要改", 95 * MIN));
  ELSEWHERE.forEach(([wsId, title, state, line, ago, children], i) => {
    const name = WORKSPACES.find(([id]) => id === wsId)?.[1] ?? wsId;
    rows.push(makeRow(now, `${wsId}-lit-${i}`, title, [wsId, name], state, line, ago * MIN, children));
  });
  for (const [wsId, name, count] of WORKSPACES) {
    const have = rows.filter((row) => row.workspaceId === wsId).length;
    for (let i = 0; i < count - have; i += 1) {
      const topic = IDLE_TOPICS[i % IDLE_TOPICS.length] ?? "整理";
      const object = IDLE_OBJECTS[(i * 5 + wsId.length) % IDLE_OBJECTS.length] ?? "笔记";
      rows.push(makeRow(now, `${wsId}-idle-${i}`, `${topic}${object}`, [wsId, name], "idle", `${topic}${object}`, 9 * HOUR + i * 7 * HOUR));
    }
  }
  const loose = 200 - rows.length;
  for (let i = 0; i < loose; i += 1) {
    const object = IDLE_OBJECTS[(i * 3) % IDLE_OBJECTS.length] ?? "笔记";
    rows.push(makeRow(now, `loose-${i}`, `${IDLE_TOPICS[(i + 2) % IDLE_TOPICS.length] ?? "整理"}${object}`, null, "idle", null, 20 * HOUR + i * 9 * HOUR));
  }
  return rows;
}

/** 对话尾部（纯文本；手机第一刀不渲染 Markdown） */
function tails(now: number): Map<string, TailEntry[]> {
  let n = 0;
  const e = (kind: TailEntry["kind"], ago: number, patch: Partial<TailEntry>): TailEntry => {
    n += 1;
    return { id: `e${n}`, at: now - ago, kind, ...patch };
  };
  const map = new Map<string, TailEntry[]>();
  map.set("m-review", [
    e("user", 71 * MIN, { text: "审一下 PR 565，主要看子会话关掉以后侧栏还亮着蓝饼的问题。" }),
    e("process", 70 * MIN, { steps: 11 }),
    e("assistant", 67 * MIN, {
      text: "看完了，方向对，两处要改：\n\n1. 通道关闭时只清了母会话那一侧的 running，子会话自己的槽还留着，重开窗口才消失。\n2. 新测试只覆盖了正常关闭，没覆盖 agent 进程崩溃的路径。\n\n其余没问题，可以在改完这两处后合。",
    }),
    e("user", 55 * MIN, { text: "第 2 点你直接补上测试。" }),
    e("process", 54 * MIN, { steps: 6 }),
    e("assistant", 50 * MIN, { text: "补好了：channel-close.test.ts 加了崩溃路径，回退修复时这条测试会红。" }),
  ]);
  map.set("m-migrate", [
    e("user", 54 * MIN, { text: "先别写代码。把迁移分成几步、每步怎么回滚，写清楚给我看。" }),
    e("process", 53 * MIN, { steps: 57 }),
    e("assistant", 47 * MIN, {
      text: "分三步走，每步都能单独回滚：\n\n1. 只读盘点：扫一遍 sessions/，记下每条会话的行数与最后一条记录的 id，不改任何文件。\n2. 双写影子库：新写入同时进 JSONL 和 SQLite；读还走 JSONL。出问题删掉影子库即可。\n3. 切读：读改走 SQLite，JSONL 留 7 天再删。\n\n盘点结果里最大的一条有 4.1 万行，单独拆出来按 500 条一批写。",
    }),
    e("user", 31 * MIN, { text: "可以。按这个来，先跑第 1、2 步。" }),
    e("process", 30 * MIN, { steps: 41, failed: 1 }),
    e("assistant", 12 * MIN, {
      text: "前两步跑完了。影子库和 JSONL 逐条比对一致（1973 / 1973）。有一条 2026-08 的旧会话缺 mode 字段，按 skip 补上了，原文件没动。\n\n下面在跑第 3 步。",
    }),
    e("process", 4 * MIN, { steps: 9 }),
  ]);
  map.set("m-plan", [
    e("user", 14 * MIN, { text: "手机端先做「看与回」：列会话、读尾部、回一句、停止。先出计划，别动代码。", images: 1 }),
    e("process", 13 * MIN, { steps: 25 }),
    e("assistant", 6 * MIN, {
      text: "第一刀：配对与会话清单。我先把范围钉死，你确认后再开工。\n\n1. 配对：电脑上 设置 › 手机 生成 6 位码，3 分钟有效；手机输地址和码，换回一份长期凭据。\n2. 四个口：列会话、读尾部、回一句、停止。\n3. 状态：五档由主进程统一推导，手机和桌面读同一份。\n\n不做：审批、语音、文件、终端、推送。",
    }),
  ]);
  return map;
}

class FixtureTransport implements Transport {
  private readonly callbacks: TransportCallbacks;
  private readonly sessions: SessionSummary[];
  private readonly tails: Map<string, TailEntry[]>;
  private readonly offline: boolean;
  /** 迟迟不回的那个方法：清单屏卡在清单上、对话屏卡在尾部上 */
  private readonly slowMethod: MobileMethod | null;
  private readonly now: number;

  constructor(callbacks: TransportCallbacks, params: FixtureParams, now: number) {
    this.callbacks = callbacks;
    this.now = now;
    this.sessions = params.scene === "empty" ? [] : params.scene === "full" ? full(now) : typical(now);
    this.tails = tails(now);
    this.offline = params.offline;
    this.slowMethod = !params.slow ? null : params.screen === "chat" ? "tail.load" : "sessions.list";
  }

  start(): void {
    this.callbacks.onStatus({ kind: "open", hostName: HOST_NAME, since: this.now });
    this.callbacks.onOpen();
    if (this.offline) {
      const status: LinkStatus = { kind: "waiting", attempt: 3, retryAt: this.now + 8_000, since: this.now - 2 * MIN, shutdown: false };
      setTimeout(() => this.callbacks.onStatus(status), 300);
    }
  }

  stop(): void {}

  retryNow(): void {}

  async request<M extends MobileMethod>(method: M, params: MobileMethodParams[M]): Promise<unknown> {
    if (method === this.slowMethod) await new Promise((resolve) => setTimeout(resolve, 120_000));
    switch (method) {
      case "sessions.list":
        return { sessions: this.sessions, truncated: this.sessions.length >= 200 };
      case "tail.load": {
        const { sessionId } = params as MobileMethodParams["tail.load"];
        const entries = this.tails.get(sessionId) ?? [];
        return { entries, hasMore: entries.length > 0, rev: 1 };
      }
      case "reply":
        return { queued: true, position: 0 };
      case "ping":
        return { now: Date.now() };
      default:
        if (method === "stop" || method.endsWith("watch") || method === "unread.clear") return null;
        throw new RequestError({ code: "bad_request", message: "样例数据不支持这个方法" });
    }
  }
}

const CREDENTIALS: Credentials = {
  address: "100.64.0.12",
  port: 47620,
  deviceId: "fedcba9876543210fedcba9876543210",
  devicePrivate: "",
  hostPublic: "",
  hostName: HOST_NAME,
  pairedAt: 0,
};

/** 用样例数据搭一个控制器，并把画面推到参数要的那一屏 */
export async function fixtureController(params: FixtureParams): Promise<AppController> {
  const now = Date.now();
  const controller = new AppController({
    loadCredentials: async () => (params.screen === "pair" ? null : CREDENTIALS),
    saveCredentials: async () => undefined,
    clearCredentials: async () => undefined,
    makeTransport: (_credentials, callbacks) => new FixtureTransport(callbacks, params, now),
    pair: async (): Promise<PairOutcome> => ({ ok: false, reason: params.pair ?? "offline" }),
    deviceName: "样例手机",
    now: Date.now,
  });
  await controller.boot();
  if (params.screen === "pair" && params.pair !== null) await controller.pair("100.64.0.12", "418207");
  if (params.screen === "chat") {
    // 等清单到手再开对话（openSession 要在清单里找得到这条）
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.openSession(params.chat ?? "m-review");
    // 「在跑时回一句」：排队条里已经有一句在等这一轮跑完
    if (params.draft) await controller.sendReply("先别动 README，等我看完第 3 步再改。");
  }
  return controller;
}

export const FIXTURE_DRAFT = "顺手把迁移前的会话数也记进日志，回头对账用。";
