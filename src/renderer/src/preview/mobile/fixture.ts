import type { PieFill } from "../../shell/status-pie.ts";

/**
 * 手机端设计稿的合成数据（2026-11-25）。只服务 preview/mobile/ 的几个画面，不读真实会话与密钥。
 *
 * 量级照用户的真实用量造（任务书与 orbita-ui-task-brief 的「满载」口径）：12 个工作区、
 * 近 2000 条根会话、一个晚上同一个工作区里十几件活在跑、四五件大事同时进行（其中一件挂着 40 多个子会话）。
 * 子会话不上手机清单（和桌面侧栏一样只列根会话），只在母会话的行上露一句「N 个子会话在跑」。
 *
 * 状态五档与桌面同一套推导（completion-notice.ts 的 SessionRunState）：running / waiting / done / failed / null（空闲）。
 */

export type MobileRunState = PieFill | null;

export interface MobileSession {
  id: string;
  title: string;
  workspaceId: string | null;
  state: MobileRunState;
  /** 这一行的那一句：在跑 = 此刻在干什么；等你 = 等你什么；出错 = 错误首行；做完 = 回答首行；空闲 = 你最后问的 */
  line: string;
  updatedAt: number;
  /** 挂着几个在跑的子会话（没有 = 0） */
  subRunning: number;
}

export interface MobileWorkspace {
  id: string;
  name: string;
  /** 这个工作区一共多少条根会话（手机只拉第一页） */
  total: number;
  /** 第一页：按最近活跃排好 */
  sessions: MobileSession[];
}

export interface MobileHost {
  name: string;
  address: string;
  net: "tailscale" | "lan";
  online: boolean;
}

export interface MobileListData {
  host: MobileHost;
  workspaces: MobileWorkspace[];
  /** 不属于任何工作区的会话（侧栏的「任务」组）的第一页与总数 */
  loose: MobileSession[];
  looseTotal: number;
}

/** 设计稿钉住的「现在」：一个工作日的晚上 23:40，所有相对时间从它算（截图可复现）。 */
export const MOBILE_NOW = new Date(2026, 10, 25, 23, 40).getTime();
/** 断线态里「最后同步」的钟点：断线前两分钟 */
export const MOBILE_SYNCED = "23:38";
/** 状态栏上的钟点，与 MOBILE_NOW 一致 */
export const MOBILE_CLOCK = "23:40";
/** 一个工作区展开后先露几条（再往下是「更早的 N 条」） */
export const MOBILE_PAGE = 6;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const HOST: MobileHost = { name: "wafo 的 MacBook Pro", address: "wafo-mbp", net: "tailscale", online: true };

function s(
  id: string,
  title: string,
  workspaceId: string | null,
  state: MobileRunState,
  line: string,
  ago: number,
  subRunning = 0,
): MobileSession {
  return { id, title, workspaceId, state, line, updatedAt: MOBILE_NOW - ago, subRunning };
}

/** 平常：两个工作区、五条会话，一件等你、一件在跑、一件做完没看 */
function typicalList(): MobileListData {
  const orbita: MobileWorkspace = {
    id: "ws-orbita",
    name: "orbita",
    total: 5,
    sessions: [
      s("m-plan", "手机端第一刀：配对与会话清单", "ws-orbita", "waiting", "计划写好了，等你确认后开工", 6 * MIN),
      s("m-typecheck", "修 Windows 打包脚本", "ws-orbita", "running", "运行 `bun run dist:win`", 2 * MIN),
      s("orbita-night-2", "迁内核到 pi-durable：会话迁移脚本", "ws-orbita", "running", "第 3 步：把 1973 条旧会话写进 SQLite", MIN, 43),
      s("m-review", "审 PR 565：子会话残留的在跑标记", "ws-orbita", "done", "看完了，两处要改：通道关闭时没清 running", 48 * MIN),
      s("m-notes", "整理 11 月的验收清单", "ws-orbita", null, "把这周合进去的 PR 列一遍", 2 * DAY),
    ],
  };
  const thesis: MobileWorkspace = {
    id: "ws-thesis",
    name: "博士论文",
    total: 1,
    sessions: [s("m-lit", "第三章文献综述 · 立场分组", "ws-thesis", null, "把 12 篇按立场分三组", 5 * HOUR)],
  };
  return { host: HOST, workspaces: [orbita, thesis], loose: [], looseTotal: 0 };
}

const WORKSPACE_NAMES: ReadonlyArray<readonly [string, string, number]> = [
  ["ws-orbita", "orbita", 612],
  ["ws-thesis", "博士论文", 241],
  ["ws-vault", "研究库", 188],
  ["ws-intent", "intent-lab", 133],
  ["ws-planet", "行星造物", 64],
  ["ws-urban", "城市智能论文", 157],
  ["ws-reading", "读书笔记", 92],
  ["ws-xhs", "小红书", 71],
  ["ws-capcut", "视频剪辑", 38],
  ["ws-design", "设计系统", 119],
  ["ws-server", "服务器运维", 46],
  ["ws-teaching", "助教", 27],
];

/** orbita 一个晚上同时在跑的十几件活（满载的主角） */
const ORBITA_NIGHT: ReadonlyArray<readonly [string, MobileRunState, string, number, number]> = [
  ["手机端第一刀：配对与会话清单", "waiting", "计划写好了，等你确认后开工", 4, 0],
  ["夜间回归：Windows 打包", "failed", "出错停下了：下载 NSIS 超时（ETIMEDOUT）", 11, 0],
  ["迁内核到 pi-durable：会话迁移脚本", "running", "第 3 步：把 1973 条旧会话写进 SQLite", 1, 43],
  ["性能：切会话卡顿", "running", "读取 `session-states.ts`", 1, 6],
  ["子会话面板 40 条时的滚动", "running", "运行 `bun run test`", 2, 0],
  ["设计系统：中性灰的对比度复核", "running", "在想：玄档三级墨落在卡面上够不够 4.5", 3, 0],
  ["自动化归档：保留最近 30 次", "running", "改 `automation-store.ts`", 3, 0],
  ["看板卡片：四档尺寸", "running", "截图核对 sm / md / lg / xl", 5, 0],
  ["权限：只留「放行」一档", "running", "运行 `bun run typecheck`", 6, 0],
  ["PDF 阅读器：引用跳转", "running", "读取 `reader/anchors.ts`", 7, 0],
  ["外部会话只读导入", "running", "在想：Kimi Work 的存储格式", 8, 0],
  ["语音：豆包连接重试", "running", "改 `voice/doubao.ts`", 9, 0],
  ["关系图谱：影响面卡", "running", "运行 `python3 atlas/check.py`", 12, 0],
  ["Release notes：0.9.4", "running", "整理合入的 17 个 PR", 14, 0],
  ["审 PR 561：右栏记忆", "done", "看完了：一处竞态，切会话时旧请求回来覆盖新面板", 26, 0],
  ["配额条：Claude 的周额度", "done", "加好了，周额度和 5 小时额度分两行", 52, 0],
  ["修 git 面板的空仓库", "done", "改完了：空仓库显示「还没有提交」", 70, 0],
];

/** 其他工作区今晚的大事与零星状态 */
const ELSEWHERE: ReadonlyArray<readonly [string, string, MobileRunState, string, number, number]> = [
  ["ws-thesis", "第三章文献综述 · 立场分组", "waiting", "想确认：「城市数字孪生」归哪一派？", 18, 12],
  ["ws-thesis", "第二章：图表重画", "running", "运行 `python3 figures/fig2.py`", 4, 0],
  ["ws-urban", "投稿前自查：引用格式", "running", "核对 references.bib 的 86 条", 9, 3],
  ["ws-vault", "本周论文 digest", "done", "写好了：8 篇，两篇值得细读", 95, 0],
  ["ws-server", "TRX40 显卡驱动升级", "failed", "出错停下了：nvidia-smi 找不到设备", 130, 0],
  ["ws-intent", "意图召回：评测集", "done", "跑完了：召回率 0.71，比上周高 0.06", 160, 0],
];

const IDLE_TOPICS = [
  "修一下", "看看为什么", "整理", "复盘", "写一版", "对照", "核对", "补测试", "改文案", "调研",
];
const IDLE_OBJECTS = [
  "侧栏的展开状态", "上周的验收截图", "引用格式", "启动速度", "通知的去重", "配色", "导出 PDF 的分页",
  "会话标题", "空态文案", "快捷键表", "打包脚本", "第四章提纲", "实验记录", "图 3 的配色",
];

function idleSessions(workspaceId: string, count: number, startAgo: number): MobileSession[] {
  const out: MobileSession[] = [];
  for (let i = 0; i < count; i++) {
    const topic = IDLE_TOPICS[i % IDLE_TOPICS.length] ?? "整理";
    const object = IDLE_OBJECTS[(i * 5 + workspaceId.length) % IDLE_OBJECTS.length] ?? "笔记";
    const ago = startAgo + i * (7 * HOUR + ((i * 37) % 11) * HOUR);
    out.push(s(`${workspaceId}-idle-${i}`, `${topic}${object}`, workspaceId, null, `${topic}${object}`, ago));
  }
  return out;
}

/** orbita 里刚在电脑上看完、已经没有状态的几条：展开工作区时它们该排在最前面（审查 M3） */
const ORBITA_RECENT: ReadonlyArray<readonly [string, string, number]> = [
  ["调对话页的表格横向滚动", "表格在窄屏里横向滚动，不挤成一字一行", 3],
  ["对一下 0.9.4 的发版清单", "把这周合进去的 17 个 PR 列一遍", 41],
  ["复盘：切会话为什么卡了半秒", "看一下 session-states 的重渲染", 95],
];

/** 满载：12 个工作区、1973 条根会话；今晚 orbita 里十几件在跑，另有四五件大事在别处进行 */
function fullList(): MobileListData {
  const workspaces = WORKSPACE_NAMES.map(([id, name, total]): MobileWorkspace => {
    const lit: MobileSession[] = [];
    if (id === "ws-orbita") {
      ORBITA_NIGHT.forEach(([title, state, line, ago, sub], i) => {
        lit.push(s(`orbita-night-${i}`, title, id, state, line, ago * MIN, sub));
      });
    }
    ELSEWHERE.forEach(([ws, title, state, line, ago, sub], i) => {
      if (ws === id) lit.push(s(`${id}-lit-${i}`, title, id, state, line, ago * MIN, sub));
    });
    // 第一页 = 亮着的全部 + 按最近活动排的空闲若干条：手机展开工作区时，亮着的已经在顶上几组里，名额留给空闲的
    const recent = id === "ws-orbita"
      ? ORBITA_RECENT.map(([title, line, ago], i) => s(`orbita-recent-${i}`, title, id, null, line, ago * MIN))
      : [];
    const firstPage = [...lit, ...recent, ...idleSessions(id, MOBILE_PAGE + 2 - recent.length, 9 * HOUR)];
    return { id, name, total, sessions: firstPage };
  });
  const loose = idleSessions("loose", MOBILE_PAGE + 2, 20 * HOUR);
  const looseTotal = 1973 - WORKSPACE_NAMES.reduce((sum, [, , total]) => sum + total, 0);
  return { host: HOST, workspaces, loose, looseTotal };
}

export function mobileList(scene: "empty" | "typical" | "full"): MobileListData {
  if (scene === "empty") return { host: HOST, workspaces: [], loose: [], looseTotal: 0 };
  return scene === "full" ? fullList() : typicalList();
}

/** 全部已拉到的会话（等你 / 进行中 / 做完没看三组从这里按状态挑） */
export function allSessions(data: MobileListData): MobileSession[] {
  return [...data.workspaces.flatMap((ws) => ws.sessions), ...data.loose];
}

// ---------------------------------------------------------------------------
// 对话页
// ---------------------------------------------------------------------------

export type MobileEntry =
  | { kind: "user"; text: string; at: number }
  | { kind: "prose"; text: string }
  /** 落定的一轮过程：一行「工作了多久 · 做了什么」 */
  | { kind: "process"; worked: string; what: string; failed?: number }
  /** 正在跑的那一轮：在干什么 · 走表 · 在想什么 · 输出尾巴 */
  | { kind: "live"; doing: string; clock: string; idea: string; foot: string };

export interface MobileChat {
  session: MobileSession;
  workspaceName: string | null;
  /** 这条会话一共多少条记录；手机只读尾部 */
  total: number;
  entries: MobileEntry[];
}

/** 「在跑时回一句」那一屏：输入框里没发出去的草稿，和已经排着队的一句 */
export const REPLY_DRAFT = "顺手把迁移前的会话数也记进日志，回头对账用。";
export const REPLY_QUEUED = "先别动 README，等我看完第 3 步再改。";
/** 配对出错两屏里已经填好的配对码 */
export const PAIR_CODE = "418 207";

/** 读尾部：手机一次只拉最近这么多条 */
export const MOBILE_TAIL = 20;

const PLAN_TEXT = [
  "## 第一刀：配对与会话清单",
  "",
  "我先把范围钉死，你确认后再开工。",
  "",
  "1. **配对**：电脑上 设置 › 手机 生成 6 位码，5 分钟有效；手机输地址和码，换回一张长期凭据。",
  "2. **四个口**：`列会话`、`读尾部`、`回一句`、`停止`，都走主进程现有的 IPC，不新开第二套会话语义。",
  "3. **状态**：五档由主进程统一推导，手机和桌面读同一份。",
  "",
  "| 口 | 方向 | 一次多少 | 失败时 |",
  "| --- | --- | --- | --- |",
  "| 列会话 | 读 | 每个工作区第一页 6 条 | 显示离线，保留上次的清单 |",
  "| 读尾部 | 读 | 最近 20 条 | 显示重连，草稿留在手机 |",
  "| 回一句 | 写 | 一条文字 | 排队，连上再发 |",
  "| 停止 | 写 | 一次 | 如实报错，不假装停了 |",
  "",
  "配对接口的形状大概是这样：",
  "",
  "```ts",
  "export interface PairRequest {",
  "  code: string;        // 6 位，5 分钟有效",
  "  deviceName: string;  // 「wafo 的 Pixel」",
  "}",
  "export interface PairGrant {",
  "  token: string;       // 只存在手机的安全存储里",
  "  hostName: string;",
  "}",
  "```",
  "",
  "清单在桌面侧栏上的对照截图：",
  "",
  "![桌面侧栏](shots/desktop-home.png)",
  "",
  "**不做**：审批、语音、文件、终端、推送的内容。",
].join("\n");

export function mobileChat(state: "typical" | "full" | "loading" | "reconnecting" | "reply-running" | "waiting"): MobileChat {
  const ws = "orbita";
  if (state === "full" || state === "reply-running") {
    const session = s("orbita-night-2", "迁内核到 pi-durable：会话迁移脚本", "ws-orbita", "running", "第 3 步：把 1973 条旧会话写进 SQLite", MIN, 43);
    return {
      session,
      workspaceName: ws,
      total: 186,
      entries: [
        { kind: "user", text: "先别写代码。把迁移分成几步、每步怎么回滚，写清楚给我看。", at: MOBILE_NOW - 54 * MIN },
        { kind: "process", worked: "工作了 6 分 40 秒", what: "读了 14 个文件，派出 43 个子会话" },
        {
          kind: "prose",
          text: [
            "分三步走，每步都能单独回滚：",
            "",
            "1. **只读盘点**：扫一遍 `sessions/`，记下每条会话的行数与最后一条记录的 id，不改任何文件。",
            "2. **双写影子库**：新写入同时进 JSONL 和 SQLite；读还走 JSONL。出问题删掉影子库即可。",
            "3. **切读**：读改走 SQLite，JSONL 留 7 天再删。",
            "",
            "| 步骤 | 动了什么 | 回滚 | 预计 |",
            "| --- | --- | --- | --- |",
            "| 盘点 | 什么都不动 | 不需要 | 3 分钟 |",
            "| 双写 | 多一个 `sessions.db` | 删库、关开关 | 1 小时 |",
            "| 切读 | 读路径 | 开关拨回 JSONL | 10 分钟 |",
            "",
            "盘点结果里最大的一条有 4.1 万行，单独拆出来按批写：",
            "",
            "```ts",
            "for (const batch of chunk(records, 500)) {",
            "  db.transaction(() => batch.forEach(insert))();",
            "}",
            "```",
          ].join("\n"),
        },
        { kind: "user", text: "可以。按这个来，先跑第 1、2 步。", at: MOBILE_NOW - 31 * MIN },
        { kind: "process", worked: "工作了 18 分 05 秒", what: "改了 6 个文件，41 步", failed: 1 },
        {
          kind: "prose",
          text: "前两步跑完了。影子库和 JSONL 逐条比对一致（1973 / 1973）。有一条 2026-08 的旧会话缺 `mode` 字段，按 `skip` 补上了，原文件没动。\n\n下面在跑第 3 步。",
        },
        { kind: "live", doing: "运行 `migrate.ts --step 3`", clock: "4:12", idea: "第 3 步：把 1973 条旧会话写进 SQLite", foot: "已写 1312 / 1973 · 最大的一条按 500 一批" },
      ],
    };
  }
  if (state === "waiting") {
    const session = s("m-plan", "手机端第一刀：配对与会话清单", "ws-orbita", "waiting", "计划写好了，等你确认后开工", 6 * MIN);
    return {
      session,
      workspaceName: ws,
      total: 9,
      entries: [
        { kind: "user", text: "手机端先做「看与回」：列会话、读尾部、回一句、停止。先出计划，别动代码。", at: MOBILE_NOW - 14 * MIN },
        { kind: "process", worked: "工作了 7 分 52 秒", what: "读了 22 个文件，查了 3 个项目" },
        { kind: "prose", text: PLAN_TEXT },
      ],
    };
  }
  const session = s("m-review", "审 PR 565：子会话残留的在跑标记", "ws-orbita", "done", "看完了，两处要改：通道关闭时没清 running", 48 * MIN);
  return {
    session,
    workspaceName: ws,
    total: 6,
    entries: [
      { kind: "user", text: "审一下 PR 565，主要看子会话关掉以后侧栏还亮着蓝饼的问题。", at: MOBILE_NOW - 71 * MIN },
      { kind: "process", worked: "工作了 3 分 18 秒", what: "读了 9 个文件，跑了 2 次测试" },
      {
        kind: "prose",
        text: "看完了，方向对，两处要改：\n\n1. 通道关闭时只清了母会话那一侧的 `running`，子会话自己的槽还留着，重开窗口才消失。\n2. 新测试只覆盖了正常关闭，没覆盖 agent 进程崩溃的路径。\n\n其余没问题，可以在改完这两处后合。",
      },
      { kind: "user", text: "第 2 点你直接补上测试。", at: MOBILE_NOW - 55 * MIN },
      { kind: "process", worked: "工作了 4 分 02 秒", what: "改了 1 个文件，跑了 3 次测试" },
      { kind: "prose", text: "补好了：`channel-close.test.ts` 加了崩溃路径，回退修复时这条测试会红。" },
    ],
  };
}
