/**
 * 新手引导的数据表：章、页、每页用哪张截图、框哪一块、编号点落在哪、放大镜放大哪一块。
 * **加页 / 改页只改这张表与文案**（messages 的 `onboarding.chapters.<章>.pages.<页>`），
 * 渲染组件（OnboardingView）是通用的。
 *
 * 坐标一律是**截图上的比例**（0–1，左上为原点），与截图的像素尺寸无关：截图换分辨率、
 * 引导窗口缩放都不用改表。截图是 1440×900 的真实界面（演示课题「城市感知课题」），
 * 浅色与玄各一套、文件名相同，按当前主题挑（onboarding-nav 的 shotTheme）。
 * 坐标取自拍图时 DOM 元素的真实外框（拍图脚本顺手量出来的），不是目测。
 *
 * 贯穿全程一个案例：一个研究课题，从接模型、读论文、交文件夹，到派子会话、做插件、
 * 每天自动跑、一周看板、收尾——截图都出自同一个课题，前后接得上。
 */

import { SHOT_BOXES } from "./shot-boxes.ts";

/** 截图文件名（不含扩展名）：shots/light/<id>.webp 与 shots/dark/<id>.webp 各一张 */
export const SHOT_IDS = [
  "home",
  "providers",
  "general",
  "migration",
  "composer",
  "permission",
  "working",
  "rewind",
  "plan",
  "context",
  "files",
  "review",
  "quote",
  "excerpts",
  "pdf-cite",
  "task-ref",
  "deck-make",
  "deck-edit",
  "deck-export",
  "doc-note",
  "deck-quote",
  "delegate",
  "subsessions",
  "memory",
  "memory-library",
  "terminal",
  "background",
  "browser-chat",
  "browser",
  "plugins",
  "plugin-make",
  "plugin-draft",
  "plugin-board",
  "automation",
  "automation-edit",
  "board-week",
  "focus",
  "closing",
  "carryovers",
] as const;
export type ShotId = (typeof SHOT_IDS)[number];

/** 截图上的一块（比例） */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 编号点：n 对应右侧第 n 条配文；x / y 是点的圆心（比例） */
export interface Pin {
  n: number;
  x: number;
  y: number;
}

/**
 * 放大镜：把截图上的 from 那块放大 scale 倍，贴在截图框里的 at 处（左上角，比例，可越出
 * 截图框——设计稿里放大镜压在窗口右下缘外）。pins 只有 x 有意义（放大镜内的比例）：编号点
 * 一律骑在放大镜的上边框上、对着被放大的那个元素，不压在放大的字上。
 * 放大镜自己占的地方（at 起，宽 from.w × scale、高 from.h × scale，都是截图框的比例）不许盖住
 * 它的来源 from——盖住了读者分不清哪边是原件（onboarding-pages.test.ts 把关）。
 */
export interface Loupe {
  from: Box;
  at: { x: number; y: number };
  scale: number;
  pins?: readonly Pin[];
}

/** 章首页：大截图 + 章名 + 这一章几页 + 案例 */
export interface OpenerPage {
  kind: "opener";
  id: string;
  shot: ShotId;
}

/**
 * 步骤页：截图压暗、框出 focus、编号点、可选放大镜；配文的 notes 条数 = 编号点的种类数。
 * say = 这页有「这样告诉它」的样例句（文案里的 say），附「放进输入框试试」。
 */
export interface StepPage {
  kind: "step";
  id: string;
  shot: ShotId;
  focus?: Box;
  pins?: readonly Pin[];
  loupe?: Loupe;
  say?: boolean;
  /**
   * 这页的 say 是**动作提示**而不是能直接发的话（要先在界面里点一页、划一处才成立）：
   * 样例框里没有发送键，「试试」不往输入框放字，只按 open 把右栏面板摆好。文案仍放在 say 里。
   */
  hint?: boolean;
  /**
   * 点「试试」时先摆好右栏：`slides` = 打开演示文稿面板（回到上次那份）；`slides-new` = 新建一份空的并打开
   * （读者还没有演示文稿时，提示里的动作也有地方做）
   */
  open?: "slides" | "slides-new";
}

/** 常见问题：一页一问，纯文字 */
export interface FaqPage {
  kind: "faq";
  id: string;
}

export type GuidePage = OpenerPage | StepPage | FaqPage;

export type GuidePart = "basics" | "tools" | "appendix";

export interface GuideChapter {
  id: ChapterId;
  part: GuidePart;
  pages: readonly GuidePage[];
}

export const CHAPTER_IDS = [
  "start",
  "task",
  "progress",
  "files",
  "quote",
  "docs",
  "subsessions",
  "memory",
  "terminal",
  "browser",
  "plugins",
  "automation",
  "board",
  "focus",
  "faq",
] as const;
export type ChapterId = (typeof CHAPTER_IDS)[number];

/** 拍图脚本量出来的框没找到时记在这里（单测要求它为空）；界面上退回截图正中的一小块，不至于崩 */
export const MISSING_BOXES: string[] = [];

/** 某张截图上量出来的一个元素（capture.mjs 写进 shot-boxes.ts），外扩 pad 并夹在截图内 */
function box(shot: ShotId, name: string, pad = 0.006): Box {
  const found = SHOT_BOXES[shot]?.[name];
  if (found === undefined || found.w <= 0 || found.h <= 0) {
    MISSING_BOXES.push(`${shot}.${name}`);
    return { x: 0.45, y: 0.45, w: 0.1, h: 0.1 };
  }
  return padded(found, pad);
}

function padded(b: Box, pad: number): Box {
  const x = Math.max(0, b.x - pad);
  const y = Math.max(0, b.y - pad);
  return { x, y, w: Math.min(1, b.x + b.w + pad) - x, h: Math.min(1, b.y + b.h + pad) - y };
}

/** 放大镜取景：一排东西，横向多留 padX、纵向只留 padY——上下别切到相邻行的字 */
function rowLoupe(b: Box, padX: number, padY: number): Box {
  const x = Math.max(0, b.x - padX);
  const y = Math.max(0, b.y - padY);
  return { x, y, w: Math.min(1, b.x + b.w + padX) - x, h: Math.min(1, b.y + b.h + padY) - y };
}

/** 两块合成一块（框住一行里的几样东西） */
function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** 一块里按比例切出一部分（量到的是整块面板、要框的是它上半截这类情况） */
function part(b: Box, from: { x?: number; y?: number; w?: number; h?: number }): Box {
  return { x: b.x + b.w * (from.x ?? 0), y: b.y + b.h * (from.y ?? 0), w: b.w * (from.w ?? 1), h: b.h * (from.h ?? 1) };
}

type Anchor = "tl" | "tr" | "bl" | "br" | "l" | "r" | "t" | "b" | "c";

/** 编号点落在一块的某个角 / 边中点上 */
function pin(n: number, b: Box, at: Anchor = "tl"): Pin {
  const x = at.includes("l") ? b.x : at.includes("r") ? b.x + b.w : b.x + b.w / 2;
  const y = at.includes("t") ? b.y : at.includes("b") ? b.y + b.h : b.y + b.h / 2;
  return { n, x, y };
}

/** 放大镜：把 from 放大 scale 倍贴在 at；marks 给「第几号 → 被放大的那个元素」，编号点按元素中线落在放大镜上沿 */
function loupe(from: Box, at: { x: number; y: number }, scale: number, marks: readonly (readonly [number, Box])[] = []): Loupe {
  const clamp = (value: number): number => Math.min(0.96, Math.max(0.04, value));
  return { from, at, scale, pins: marks.map(([n, target]) => ({ n, x: clamp((target.x + target.w / 2 - from.x) / from.w), y: 0 })) };
}

const opener = (shot: ShotId): OpenerPage => ({ kind: "opener", id: "opener", shot });
const step = (id: string, shot: ShotId, layout: Omit<StepPage, "kind" | "id" | "shot"> = {}): StepPage => ({ kind: "step", id, shot, ...layout });
const faq = (id: string): FaqPage => ({ kind: "faq", id });

// —— 每页的取景。框名对应 scripts/onboarding-shots/scenes.mjs 里各场景的 measure ——

const home = { sidebar: box("home", "sidebar"), composer: box("home", "composer"), rail: box("home", "rail", 0.004), newTask: box("home", "newTask", 0.004) };
const composer = {
  card: box("composer", "card"),
  clip: box("composer", "clip", 0.003),
  ws: box("composer", "ws", 0.003),
  perm: box("composer", "perm", 0.003),
  model: box("composer", "model", 0.003),
  think: box("composer", "think", 0.003),
};
const composerBar = union(union(composer.clip, composer.model), composer.think);
/** 放大镜取景：底栏一整排（回形针到思考档），上沿多留一截——编号点骑在放大镜上边框上，不压字 */
const composerLoupe: Box = (() => {
  const b = padded(composerBar, 0.012);
  return { x: b.x, y: b.y - 0.022, w: b.w, h: b.h + 0.022 };
})();
const general = { chore: box("general", "chore"), sub: box("general", "sub") };
const plan = box("plan", "panel", 0);
const automationRow = box("automation", "daily");

export const GUIDE: readonly GuideChapter[] = [
  {
    id: "start",
    part: "basics",
    pages: [
      opener("home"),
      step("welcome", "home", { pins: [pin(1, home.sidebar), pin(2, home.composer), pin(3, home.rail, "l")] }),
      step("providers", "providers", {
        focus: box("providers", "plan"),
        pins: [pin(1, box("providers", "added", 0.003), "tl"), pin(2, box("providers", "deepseek"))],
        loupe: loupe(box("providers", "plan"), { x: 0.42, y: 0.5 }, 1.8, [[1, box("providers", "added", 0.003)]]),
      }),
      step("roles", "general", {
        focus: union(general.chore, general.sub),
        pins: [pin(1, general.chore), pin(2, general.sub)],
        loupe: loupe(union(general.chore, general.sub), { x: 0.3, y: 0.71 }, 1.25),
      }),
      step("import", "migration", {
        focus: union(box("migration", "readonly"), box("migration", "scan")),
        pins: [pin(1, box("migration", "scan"), "b"), pin(2, box("migration", "readonly"))],
      }),
    ],
  },
  {
    id: "task",
    part: "basics",
    pages: [
      opener("working"),
      step("composer", "composer", {
        focus: composer.card,
        // 1–3 只在放大镜里（底栏小字原图里看不清）；原图上只留框住整张输入卡的 4，一页一套编号
        pins: [pin(4, composer.card, "tl")],
        loupe: loupe(composerLoupe, { x: 0.2, y: 0.62 }, 2, [[1, composer.clip], [2, composer.ws], [3, composer.perm]]),
        say: true,
      }),
      step("permission", "permission", {
        focus: union(box("permission", "menu"), box("permission", "perm")),
        pins: [pin(1, box("permission", "menu"), "tr")],
        loupe: loupe(padded(union(box("permission", "menu"), box("permission", "perm")), 0.02), { x: 0.5, y: 0.38 }, 2.2),
      }),
      step("watch", "working", {
        focus: box("working", "block"),
        pins: [pin(1, box("working", "block"), "tl"), pin(2, box("working", "block"), "bl")],
      }),
      step("rewind", "rewind", {
        focus: box("rewind", "rewind", 0.008),
        pins: [pin(1, box("rewind", "rewind", 0.008), "l"), pin(2, box("rewind", "undo", 0.006), "l")],
        loupe: loupe(rowLoupe(box("rewind", "rewind"), 0.05, 0.012), { x: 0.55, y: 0.5 }, 3),
      }),
    ],
  },
  {
    id: "progress",
    part: "basics",
    pages: [
      opener("plan"),
      step("plan", "plan", {
        focus: box("plan", "plan"),
        pins: [pin(1, box("plan", "plan"), "tl"), pin(2, box("plan", "done"), "l")],
        // 放大镜放在来源（右栏计划）左边的空地上：不盖住框，右栏上的 1、2 才看得见
        loupe: loupe(box("plan", "plan"), { x: 0.03, y: 0.2 }, 1.4, [[1, part(box("plan", "plan"), { w: 0.16 })]]),
      }),
      step("goal", "plan", { focus: box("plan", "goal"), pins: [pin(1, box("plan", "goal"), "tl")], loupe: loupe(box("plan", "goal"), { x: 0.15, y: 0.45 }, 1.8) }),
      step("context", "context", {
        focus: box("context", "panel", 0),
        pins: [pin(1, box("context", "files"), "l"), pin(2, part(box("context", "panel", 0), { y: 0.02, h: 0.06 }), "l")],
      }),
    ],
  },
  {
    id: "files",
    part: "basics",
    pages: [
      opener("files"),
      step("workspace", "home", { focus: home.sidebar, pins: [pin(1, home.sidebar), pin(2, home.newTask, "r")] }),
      step("files", "files", { focus: box("files", "panel", 0), pins: [pin(1, box("files", "crumb"), "l"), pin(2, part(box("files", "panel", 0), { y: 0.2, h: 0.5 }), "l")] }),
      step("changes", "review", {
        focus: box("review", "panel", 0),
        pins: [pin(1, box("review", "row"), "l"), pin(2, part(box("review", "panel", 0), { y: 0.1, h: 0.4 }), "l")],
      }),
    ],
  },
  {
    id: "quote",
    part: "basics",
    pages: [
      opener("quote"),
      step("quote", "quote", {
        pins: [pin(1, box("quote", "toolbar"), "tl"), pin(2, box("quote", "quote"), "tl")],
        loupe: loupe(padded(box("quote", "toolbar"), 0.03), { x: 0.35, y: 0.55 }, 2.4, [[1, box("quote", "toolbar")]]),
        say: true,
      }),
      step("excerpt", "excerpts", { focus: box("excerpts", "panel", 0), pins: [pin(1, box("excerpts", "first"), "tl"), pin(2, box("excerpts", "first"), "bl")] }),
      step("pdf", "pdf-cite", {
        focus: box("pdf-cite", "mark", 0.01),
        pins: [pin(1, box("pdf-cite", "cite", 0.004), "t")],
        loupe: loupe(padded(box("pdf-cite", "mark"), 0.03), { x: 0.08, y: 0.6 }, 2.6),
      }),
      step("session", "task-ref", { focus: union(box("task-ref", "turn"), box("task-ref", "answer")), pins: [pin(1, box("task-ref", "turn"), "tl")], say: true }),
    ],
  },
  {
    id: "docs",
    part: "basics",
    pages: [
      opener("deck-make"),
      step("make", "deck-make", {
        pins: [pin(1, box("deck-make", "row"), "l"), pin(2, box("deck-make", "card"), "bl"), pin(3, box("deck-make", "rail", 0.004), "l")],
        say: true,
      }),
      step("edit", "deck-edit", {
        focus: box("deck-edit", "panel", 0),
        pins: [pin(1, box("deck-edit", "tools"), "tl"), pin(2, box("deck-edit", "picked"), "tl"), pin(3, box("deck-edit", "theme"), "b"), pin(4, box("deck-edit", "thumbs"), "tl")],
        hint: true,
        open: "slides-new",
      }),
      step("export", "deck-export", {
        focus: box("deck-export", "menu"),
        pins: [pin(1, box("deck-export", "menu"), "tl"), pin(2, box("deck-export", "pptx"), "bl")],
      }),
      step("doc", "doc-note", {
        focus: box("doc-note", "panel", 0),
        pins: [pin(1, box("doc-note", "views"), "tl"), pin(2, box("doc-note", "callout"), "tl"), pin(3, box("doc-note", "exportBtn"), "b")],
        say: true,
      }),
      step("quote", "deck-quote", {
        pins: [pin(1, box("deck-quote", "quoteBtn"), "t"), pin(2, box("deck-quote", "chip"), "tl")],
        // 放大镜放在聊天栏中段的空处：发出去的那一条（引用芯片 + 气泡）放大看，文件名与页号才读得清
        loupe: loupe(padded(union(box("deck-quote", "chip"), box("deck-quote", "bubble")), 0.01), { x: 0.02, y: 0.3 }, 1.25),
        hint: true,
        open: "slides",
      }),
    ],
  },
  {
    id: "subsessions",
    part: "basics",
    pages: [
      opener("subsessions"),
      step("dispatch", "delegate", { focus: box("delegate", "cards"), pins: [pin(1, box("delegate", "cards"), "tl")], say: true }),
      step("inbox", "subsessions", { focus: box("subsessions", "panel", 0), pins: [pin(1, part(box("subsessions", "panel", 0), { y: 0.13, h: 0.2 }), "l")] }),
      step("waiting", "subsessions", {
        focus: part(box("subsessions", "panel", 0), { h: 0.1 }),
        pins: [pin(1, box("subsessions", "rail", 0.004), "l")],
        // 取景比框多留一截底：回答框完整进镜，不切成半行
        loupe: loupe(part(box("subsessions", "panel", 0), { h: 0.135 }), { x: 0.05, y: 0.47 }, 1.5),
      }),
      step("cost", "general", { focus: general.sub, pins: [pin(1, general.sub)], loupe: loupe(general.sub, { x: 0.27, y: 0.72 }, 1.35) }),
    ],
  },
  {
    id: "memory",
    part: "basics",
    pages: [
      opener("memory-library"),
      step("remember", "memory-library", { focus: box("memory-library", "entries", 0.004), pins: [pin(1, box("memory-library", "entries", 0.004), "tl")] }),
      step("used", "memory", {
        focus: union(box("memory", "row"), box("memory", "list")),
        pins: [pin(1, box("memory", "row"), "tl")],
      }),
      step("correct", "memory-library", { focus: box("memory-library", "scopes"), pins: [pin(1, box("memory-library", "scopes"), "tl")], say: true }),
    ],
  },
  {
    id: "terminal",
    part: "tools",
    pages: [
      opener("terminal"),
      step("run", "terminal", { focus: part(box("terminal", "term", 0), { h: 0.16 }), pins: [pin(1, box("terminal", "term", 0), "tl")], loupe: loupe(part(box("terminal", "term", 0), { h: 0.16 }), { x: 0.1, y: 0.55 }, 1.6), say: true }),
      step("background", "background", { focus: box("background", "card"), pins: [pin(1, box("background", "card"), "tl")], say: true }),
    ],
  },
  {
    id: "browser",
    part: "tools",
    pages: [
      opener("browser"),
      step("read", "browser-chat", { focus: union(box("browser-chat", "turn"), box("browser-chat", "answer")), pins: [pin(1, box("browser-chat", "turn"), "tl")], say: true }),
      step("login", "browser", { pins: [pin(1, box("browser", "window", 0), "tl")] }),
    ],
  },
  {
    id: "plugins",
    part: "tools",
    pages: [
      opener("plugins"),
      step("page", "plugins", {
        focus: box("plugins", "panel", 0),
        pins: [pin(1, box("plugins", "local"), "tl"), pin(2, box("plugins", "drafting"), "l")],
      }),
      step("make", "plugin-make", { focus: union(box("plugin-make", "bubble"), box("plugin-make", "make")), pins: [pin(1, box("plugin-make", "bubble"), "tl")], say: true }),
      step("draft", "plugin-draft", { focus: box("plugin-draft", "panel", 0), pins: [pin(1, box("plugin-draft", "workflow"), "tl")] }),
      step("result", "plugin-board", { focus: box("plugin-board", "card"), pins: [pin(1, box("plugin-board", "card"), "tl")] }),
    ],
  },
  {
    id: "automation",
    part: "tools",
    pages: [
      opener("automation"),
      step("create", "automation", { focus: box("automation", "panel", 0), pins: [pin(1, automationRow, "tl")], say: true }),
      step("plugin", "automation-edit", {
        focus: box("automation-edit", "panel", 0),
        pins: [pin(1, part(box("automation-edit", "panel", 0), { y: 0.3, h: 0.2 }), "l"), pin(2, box("automation-edit", "edit"), "l")],
      }),
      step("chart", "automation", {
        focus: automationRow,
        pins: [pin(1, part(automationRow, { x: 0.62, w: 0.2 }), "t")],
        loupe: loupe(automationRow, { x: 0.3, y: 0.62 }, 1.55, [[1, part(automationRow, { x: 0.62, w: 0.2 })], [2, part(automationRow, { x: 0.86, w: 0.12 })]]),
      }),
    ],
  },
  {
    id: "board",
    part: "tools",
    pages: [
      opener("board-week"),
      step("card", "plugin-board", { focus: box("plugin-board", "card"), pins: [pin(1, box("plugin-board", "card"), "tl")] }),
      step("week", "board-week", { focus: box("board-week", "card"), pins: [pin(1, box("board-week", "card"), "tl")] }),
    ],
  },
  // 第 13 章原型第 4 页「交给自动化消化」（让自动化把「以后再做」消化掉）是虚线待定：等实测结论再加，先不做
  {
    id: "focus",
    part: "tools",
    pages: [
      opener("focus"),
      step("focus", "focus", { focus: box("focus", "picker"), pins: [pin(1, box("focus", "key", 0.004), "b")] }),
      step("wrap", "closing", { focus: box("closing", "card"), pins: [pin(1, box("closing", "tick", 0.004), "b")] }),
      step("later", "carryovers", { focus: part(box("carryovers", "list", 0), { h: 0.55 }), pins: [pin(1, box("carryovers", "list", 0), "tr")] }),
    ],
  },
  { id: "faq", part: "appendix", pages: [faq("perms"), faq("data"), faq("twice"), faq("language"), faq("background"), faq("update")] },
];
