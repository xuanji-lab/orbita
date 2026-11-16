/**
 * 故事版新手引导「璇玑对接」的剧本：站、步、玩家动作、辨伪环节、推进规则。全是纯函数 / 纯数据，
 * 渲染组件只管画与接键盘。
 *
 * 设定：璇玑星座里几座站失去同步。用户是新来的轨道调度员，AI 是站里的领航员，两人查清哪里断了，
 * 把站一座座对接回有序轨道。剧本版：领航员的台词写死在 messages（onboarding.story），不接模型、不调 agent。
 *
 * 第二轮起是**动作驱动**：星图是操作面。关键时刻不是点「下一步」，而是玩家在星图 / 画面上做一件事
 * （点领航站通电、在星图上点选该派谁出门、在两条报告里挑出冒名的、点僚机放出两架、按这次的顺序点三座站存成协议、
 * 选巡航周期……）做完才推进；「下一步」只留给纯对话。每个动作键盘都能完成（站是按钮，Tab / Enter）。
 *
 * 每座站只有两个状态：lost 失步（空心、偏离轨道、抖）/ linked 接通（实心、锁回轨道、连上线）。
 * 开场十座站全部失步，一座座被接回。
 */
import { GUIDE, type ChapterId, type StepPage } from "../onboarding-pages.ts";
import type { OnboardingStyle, ThemePreference } from "@shared/settings";

export const STATION_IDS = ["pilot", "archive", "observatory", "verify", "wing", "route", "log", "hq", "protocol", "patrol"] as const;
export type StationId = (typeof STATION_IDS)[number];
export type StationState = "lost" | "linked";

/** 站在哪条轨道上：0 = 中心（领航员），1 / 2 / 3 = 三幕各一圈 */
export type Ring = 0 | 1 | 2 | 3;

export interface StationDef {
  id: StationId;
  ring: Ring;
  /** 它代表 Orbita 的哪个功能（只给测试与文档对账用，界面文字在 messages） */
  feature: string;
}

export const STATIONS: readonly StationDef[] = [
  { id: "pilot", ring: 0, feature: "接模型（服务商）" },
  { id: "archive", ring: 1, feature: "文件夹、读 PDF" },
  { id: "observatory", ring: 1, feature: "浏览器" },
  { id: "verify", ring: 2, feature: "引用原文核对" },
  { id: "wing", ring: 2, feature: "子会话" },
  { id: "route", ring: 2, feature: "计划" },
  { id: "log", ring: 3, feature: "记忆" },
  { id: "hq", ring: 3, feature: "Word / PPT" },
  { id: "protocol", ring: 3, feature: "插件" },
  { id: "patrol", ring: 3, feature: "自动化" },
];

export const STEP_IDS = [
  "wake",
  "power",
  "archive",
  "browse",
  "reports",
  "verified",
  "fires",
  "route",
  "memory",
  "report",
  "protocol",
  "patrol",
  "chart",
  "landing",
] as const;
export type StepId = (typeof STEP_IDS)[number];

/** 站内要展示的真截图：取手册里某一页的取景（截图、框选、编号点、放大镜原样复用） */
export interface ShotRef {
  chapter: ChapterId;
  page: string;
}

export type Act = 0 | 1 | 2 | 3;

/**
 * 一步里玩家要做的事（没有 = 纯对话，点「下一步」就行）：
 * - tap：点某座站 times 次（通电点领航站一次；放出两架僚机点僚机站两次）
 * - pick：在星图上点选一座该去的站，选错由领航员解释为什么不是它，可重选
 * - sequence：按这次的顺序依次点几座站（存成协议），点错从头来
 * - choose：从几个选项里选一个（不同选项领航员回应不同，殊途同归）
 * - gate：辨伪——两条报告，先点开原文，再挑出对不上的那条
 */
export type Task =
  | { kind: "tap"; station: StationId; times: number }
  | { kind: "pick"; correct: StationId }
  | { kind: "sequence"; order: readonly StationId[] }
  | { kind: "choose"; options: number }
  | { kind: "gate" };

export interface StoryStep {
  id: StepId;
  /** 0 = 序幕，1 / 2 / 3 = 三幕：通电与读档 / 追查与辨伪 / 对接与巡航 */
  act: Act;
  /** 这一步在聊哪座站（星图上给它一圈光；缺 = 整幅星图） */
  about?: StationId;
  /** 站内展示的功能真截图（缺 = 这一步没有功能登场） */
  shot?: ShotRef;
  /** 到这一步时就接通的站（上一步做完的结果） */
  arrive?: readonly StationId[];
  /** 这一步的动作做完时接通的站（没有动作的步，到站就算做完） */
  link?: readonly StationId[];
  /** 这一步开头，这座已接通的站又失步一次（转折）；动作做完它重新锁回轨道 */
  relapse?: StationId;
  /** 玩家要做的事；缺 = 纯对话 */
  task?: Task;
  /** 非必答的两选一回话（「调度员」自己说话；不选直接下一步也行）：选项数 */
  reply?: number;
}

export const STEPS: readonly StoryStep[] = [
  { id: "wake", act: 0, about: "pilot", reply: 2 },
  { id: "power", act: 1, about: "pilot", shot: { chapter: "start", page: "providers" }, task: { kind: "tap", station: "pilot", times: 1 }, link: ["pilot"] },
  { id: "archive", act: 1, about: "archive", shot: { chapter: "files", page: "files" }, reply: 2 },
  { id: "browse", act: 1, about: "observatory", shot: { chapter: "browser", page: "read" }, arrive: ["archive"], task: { kind: "pick", correct: "observatory" }, link: ["observatory"] },
  { id: "reports", act: 2, about: "verify", task: { kind: "gate" }, link: ["verify"] },
  { id: "verified", act: 2, about: "verify", shot: { chapter: "quote", page: "pdf" } },
  { id: "fires", act: 2, about: "wing", shot: { chapter: "subsessions", page: "dispatch" }, task: { kind: "tap", station: "wing", times: 2 }, link: ["wing"] },
  { id: "route", act: 2, about: "route", shot: { chapter: "progress", page: "plan" }, task: { kind: "choose", options: 2 }, link: ["route"] },
  { id: "memory", act: 3, about: "log", shot: { chapter: "memory", page: "remember" }, arrive: ["log"], reply: 2 },
  { id: "report", act: 3, about: "hq", shot: { chapter: "docs", page: "export" }, task: { kind: "choose", options: 2 }, link: ["hq"] },
  { id: "protocol", act: 3, about: "protocol", shot: { chapter: "plugins", page: "make" }, relapse: "observatory", task: { kind: "sequence", order: ["archive", "observatory", "verify"] }, link: ["protocol"] },
  { id: "patrol", act: 3, about: "patrol", shot: { chapter: "automation", page: "create" }, task: { kind: "choose", options: 3 }, link: ["patrol"] },
  { id: "chart", act: 3, shot: { chapter: "board", page: "week" } },
  { id: "landing", act: 3, shot: { chapter: "start", page: "welcome" } },
];

export const STEP_COUNT = STEPS.length;

export function stepOf(index: number): StoryStep {
  const step = STEPS[Math.min(STEPS.length - 1, Math.max(0, index))];
  if (step === undefined) throw new Error("剧本是空的");
  return step;
}

/** 从手册的数据表里取出这一步要展示的取景；取不到（手册改了页 id）返回 undefined，界面退回无截图版式 */
export function shotPage(ref: ShotRef | undefined): StepPage | undefined {
  if (ref === undefined) return undefined;
  const page = GUIDE.find((chapter) => chapter.id === ref.chapter)?.pages.find((each) => each.id === ref.page);
  return page?.kind === "step" ? page : undefined;
}

// ---------------------------------------------------------------------------
// 辨伪环节
// ---------------------------------------------------------------------------

/**
 * 两条报告都说「四个数据集」，乙悄悄把其中一个换了（NYC-crime → CHI-bike），引文也跟着改——
 * 不对着原文一个个核，看不出来。
 */
export type ReportId = "a" | "b";
export const FAKE_REPORT: ReportId = "b";

/**
 * 辨伪环节的原文：**逐字取自演示课题的论文 arXiv 2403.00813（UrbanGPT）第 5 页 4.1.1**
 * （PDF 里「var-/ious」「us-/ing」是行尾断字，这里按词接回）。是论文原文不是界面文案，所以不进 messages。
 * 与手册里 pdf-cite 截图是同一篇。
 */
export const GATE_SOURCE = {
  file: "UrbanGPT-2403.00813.pdf",
  page: 5,
  section: "4.1.1",
  text:
    "To evaluate the effectiveness of the proposed model in predicting spatio-temporal patterns across various urban computing scenarios, we conducted experiments using four distinct datasets: NYC-taxi, NYC-bike, NYC-crime, and CHI-taxi. These datasets encompass a wide range of data sources to capture the dynamic nature of urban environments, including records of taxi travel, bike trajectories, crime incidents in New York City, and taxi travel data in Chicago.",
  /** 原文里被甲引用的那一句（选完才高亮，选之前不泄题） */
  mark: "four distinct datasets: NYC-taxi, NYC-bike, NYC-crime, and CHI-taxi",
} as const;

/** 两条报告各自的数据集清单与「引文」。甲的引文是原文里真有的；乙的引文原文里找不到（编的） */
export const REPORTS: Record<ReportId, { datasets: readonly string[]; quote: string }> = {
  a: {
    datasets: ["NYC-taxi", "NYC-bike", "NYC-crime", "CHI-taxi"],
    quote: "four distinct datasets: NYC-taxi, NYC-bike, NYC-crime, and CHI-taxi",
  },
  b: {
    datasets: ["NYC-taxi", "NYC-bike", "CHI-bike", "CHI-taxi"],
    quote: "four distinct datasets: NYC-taxi, NYC-bike, CHI-bike, and CHI-taxi",
  },
};

// ---------------------------------------------------------------------------
// 状态与动作
// ---------------------------------------------------------------------------

/** 一步里玩家做到哪了 */
export interface Progress {
  /** 动作做完了（没有动作的步不看这个） */
  done: boolean;
  /** tap：已点了几次 */
  taps: number;
  /** sequence：已按对的站（点错清空）/ pick：选对的那座 */
  picks: readonly StationId[];
  /** 点错 / 选错的次数（不惩罚，只用来换一句提示） */
  wrong: number;
  /** 最近一次点错的站（给提示用） */
  wrongStation: StationId | null;
  /** choose 与 reply：选了第几项 */
  choice: number | null;
  /** 是领航员代劳完成的（不是玩家自己做的） */
  byPilot: boolean;
  /** 通电：玩家点了领航站，但还没有可用的模型 */
  needsModel: boolean;
  /** 通电：用演示信号先走完（之后再去接真的） */
  demo: boolean;
  /** gate：点开过原文（不点开，选不了） */
  opened: boolean;
  /** gate：选过的最后一条（选完才高亮原文那句） */
  picked: ReportId | null;
}

export const FRESH: Progress = {
  done: false,
  taps: 0,
  picks: [],
  wrong: 0,
  wrongStation: null,
  choice: null,
  byPilot: false,
  needsModel: false,
  demo: false,
  opened: false,
  picked: null,
};

export interface StoryState {
  index: number;
  progress: Partial<Record<StepId, Progress>>;
}

export function initialState(index = 0): StoryState {
  return { index: Math.min(STEP_COUNT - 1, Math.max(0, index)), progress: {} };
}

export function progressOf(state: StoryState, index = state.index): Progress {
  return state.progress[stepOf(index).id] ?? FRESH;
}

function withProgress(state: StoryState, patch: Partial<Progress>): StoryState {
  const step = stepOf(state.index);
  return { ...state, progress: { ...state.progress, [step.id]: { ...progressOf(state), ...patch } } };
}

/** 第 index 步的动作做完了没：没有动作的步算做完 */
export function stepDone(state: StoryState, index: number): boolean {
  const step = stepOf(index);
  return step.task === undefined || progressOf(state, index).done;
}

/** 这一步还有动作没做完：「下一步」不放行 */
export function blocked(state: StoryState): boolean {
  return !stepDone(state, state.index);
}

export function atGate(state: StoryState): boolean {
  return stepOf(state.index).task?.kind === "gate";
}

/** 能不能让领航员代劳：辨伪必须玩家自己选，不给代劳；其余动作给一个出口，免得卡死 */
export function canAssist(state: StoryState): boolean {
  const task = stepOf(state.index).task;
  return task !== undefined && task.kind !== "gate" && !progressOf(state).done;
}

// ---- 站点点击 -------------------------------------------------------------

export interface TapContext {
  /** 玩家有没有可用的模型（通电那一步用） */
  hasProvider: boolean;
}

/** 当前这一步，这座站能不能点：tap 只有目标站，pick / sequence 所有站，其余都不能 */
export function isTappable(state: StoryState, station: StationId): boolean {
  const task = stepOf(state.index).task;
  if (task === undefined || progressOf(state).done) return false;
  if (task.kind === "tap") return station === task.station;
  return task.kind === "pick" || task.kind === "sequence";
}

/** 星图上点了一座站。不是当前动作该点的站 / 动作已做完 / 没有动作：原样返回（同一个对象） */
export function tapStation(state: StoryState, station: StationId, context: TapContext): StoryState {
  const step = stepOf(state.index);
  const task = step.task;
  const now = progressOf(state);
  if (task === undefined || now.done || !isTappable(state, station)) return state;
  if (task.kind === "tap") {
    // 通电：没有模型就还不能通电，把出口亮出来（去接 / 先用演示信号）
    if (step.id === "power" && !context.hasProvider) return withProgress(state, { needsModel: true });
    const taps = Math.min(task.times, now.taps + 1);
    return withProgress(state, { taps, done: taps >= task.times });
  }
  if (task.kind === "pick") {
    if (station === task.correct) return withProgress(state, { picks: [station], done: true, wrongStation: null });
    return withProgress(state, { wrong: now.wrong + 1, wrongStation: station });
  }
  if (task.kind === "sequence") {
    const expected = task.order[now.picks.length];
    if (station === expected) {
      const picks = [...now.picks, station];
      return withProgress(state, { picks, done: picks.length >= task.order.length, wrongStation: null });
    }
    // 点错：从头来，并记下该点的是哪一座
    return withProgress(state, { picks: [], wrong: now.wrong + 1, wrongStation: station });
  }
  return state;
}

/** 通电那一步：没有模型时选「先用演示信号走完」 */
export function useDemoSignal(state: StoryState): StoryState {
  const step = stepOf(state.index);
  if (step.id !== "power" || progressOf(state).done) return state;
  return withProgress(state, { done: true, demo: true, taps: 1 });
}

/** 通电那一步：点了领航站但还没有模型——界面要亮出出口（去接 / 先用演示信号） */
export function needsModelExit(state: StoryState): boolean {
  return stepOf(state.index).id === "power" && progressOf(state).needsModel && !progressOf(state).done;
}

// ---- 选项 -----------------------------------------------------------------

/** 选一个选项：choose 动作选完算做完；reply（非必答）只记下选了哪个。越界 / 没有选项的步原样返回 */
export function choose(state: StoryState, option: number): StoryState {
  const step = stepOf(state.index);
  const count = step.task?.kind === "choose" ? step.task.options : (step.reply ?? 0);
  if (count === 0 || option < 0 || option >= count) return state;
  if (step.task?.kind === "choose") {
    if (progressOf(state).done) return state;
    return withProgress(state, { choice: option, done: true });
  }
  return withProgress(state, { choice: option });
}

// ---- 辨伪 -----------------------------------------------------------------

export function gateOpen(state: StoryState): boolean {
  return atGate(state) && !progressOf(state).done;
}

export function openOriginal(state: StoryState): StoryState {
  if (!atGate(state) || progressOf(state).opened) return state;
  return withProgress(state, { opened: true });
}

/**
 * 选一条报告当「对不上原文的」。没点开原文不让选；选错记一次、能重选；选对过关。
 * 选完（不论对错）原文里那一句才高亮——选之前不泄题。
 */
export function pickReport(state: StoryState, report: ReportId): StoryState {
  if (!gateOpen(state) || !progressOf(state).opened) return state;
  if (report === FAKE_REPORT) return withProgress(state, { picked: report, done: true });
  return withProgress(state, { picked: report, wrong: progressOf(state).wrong + 1 });
}

// ---- 代劳 -----------------------------------------------------------------

/** 领航员代劳：把这一步的动作做完（辨伪除外，见 canAssist）。只给想快点看完的人一个出口 */
export function assist(state: StoryState): StoryState {
  if (!canAssist(state)) return state;
  const task = stepOf(state.index).task;
  if (task === undefined) return state;
  if (task.kind === "tap") return withProgress(state, { taps: task.times, done: true, byPilot: true, demo: stepOf(state.index).id === "power" });
  if (task.kind === "pick") return withProgress(state, { picks: [task.correct], done: true, byPilot: true });
  if (task.kind === "sequence") return withProgress(state, { picks: task.order, done: true, byPilot: true });
  if (task.kind === "choose") return withProgress(state, { choice: 0, done: true, byPilot: true });
  return state;
}

// ---- 翻页 -----------------------------------------------------------------

export type NextResult = StoryState | "finish";

/**
 * 「下一步」：动作没做完就不放行（原样返回同一个状态对象，调用方据此抖一下提示）；
 * 例外：辨伪还没点开原文时，→ 先替你翻开原文（翻开不是选，答案还得自己挑）。
 * 最后一页之后是 "finish"（调用方收尾、写看过）。
 */
export function pressNext(state: StoryState): NextResult {
  if (blocked(state)) {
    if (atGate(state) && !progressOf(state).opened) return openOriginal(state);
    return state;
  }
  if (state.index >= STEP_COUNT - 1) return "finish";
  return { ...state, index: state.index + 1 };
}

/** 「上一步」：直接退一页，做过的动作保留（退回来看，已做的仍是已做） */
export function pressPrev(state: StoryState): StoryState {
  if (state.index <= 0) return state;
  return { ...state, index: state.index - 1 };
}

/** 主按钮该写什么：动作没做完是「先动手」（灰的），最后一页是收尾，其余「下一步」 */
export type NextLabel = "wait" | "next" | "finish";
export function nextLabel(state: StoryState): NextLabel {
  if (blocked(state)) return "wait";
  if (state.index >= STEP_COUNT - 1) return "finish";
  return "next";
}

// ---------------------------------------------------------------------------
// 站点状态
// ---------------------------------------------------------------------------

function stepsOf(pick: (step: StoryStep) => readonly StationId[] | StationId | undefined, station: StationId): number[] {
  const out: number[] = [];
  STEPS.forEach((step, index) => {
    const value = pick(step);
    if (value === station || (Array.isArray(value) && value.includes(station))) out.push(index);
  });
  return out;
}

/** 一座站在这一刻的状态（第几步 + 动作进度）。开场十座全是 lost */
export function stationState(station: StationId, state: StoryState): StationState {
  // 转折：这一步里它又失步，动作做完才重新锁回
  const relapseAt = stepsOf((step) => step.relapse, station)[0];
  if (relapseAt !== undefined && state.index === relapseAt && !stepDone(state, relapseAt)) return "lost";
  for (const at of stepsOf((step) => step.arrive, station)) if (state.index >= at) return "linked";
  for (const at of stepsOf((step) => step.link, station)) {
    if (state.index > at || (state.index === at && stepDone(state, at))) return "linked";
  }
  return "lost";
}

export function stationStates(state: StoryState): Record<StationId, StationState> {
  const out = {} as Record<StationId, StationState>;
  for (const id of STATION_IDS) out[id] = stationState(id, state);
  return out;
}

export function linkedCount(state: StoryState): number {
  return STATION_IDS.filter((id) => stationState(id, state) === "linked").length;
}

/** 一圈轨道「同步」：这一圈上的站全接通了，这圈才转起来（转 = 运转） */
export function ringSynced(ring: Ring, state: StoryState): boolean {
  const members = STATIONS.filter((station) => station.ring === ring);
  return members.length > 0 && members.every((station) => stationState(station.id, state) === "linked");
}

/** 这一步里「正在聊」的站：星图上给它一圈光 */
export function focusStation(index: number): StationId | undefined {
  return stepOf(index).about;
}

/** 要不要在星图上提示玩家点哪座：tap 动作的目标站；按顺序点的步，点错之后提示下一座该点谁 */
export function hintStation(state: StoryState): StationId | undefined {
  const task = stepOf(state.index).task;
  const now = progressOf(state);
  if (task === undefined || now.done) return undefined;
  if (task.kind === "tap") return task.station;
  if (task.kind === "sequence" && now.wrong > 0) return task.order[now.picks.length];
  return undefined;
}

/** 僚机站身边绕着几架僚机：放出去一架多一架，放完两架留到故事结束 */
export function wingMoons(state: StoryState): number {
  const at = STEPS.findIndex((step) => step.id === "fires");
  if (state.index > at) return 2;
  if (state.index < at) return 0;
  return progressOf(state).taps;
}

// ---------------------------------------------------------------------------
// 画风
// ---------------------------------------------------------------------------

/** 纸面两档主题回落「观测记录」：线路图与航行日志只覆盖浅色与两档暗色 */
export function effectiveStyle(style: OnboardingStyle | undefined, theme: Exclude<ThemePreference, "system">): OnboardingStyle {
  if (theme === "copybook" || theme === "typescript") return "observe";
  return style ?? "observe";
}

export function styleSwitchable(theme: Exclude<ThemePreference, "system">): boolean {
  return theme !== "copybook" && theme !== "typescript";
}
