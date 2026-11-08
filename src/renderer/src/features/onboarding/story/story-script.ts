/**
 * 故事版新手引导「璇玑对接」的剧本：站、步、辨伪环节、推进规则。全是纯函数 / 纯数据，渲染组件只管画。
 *
 * 设定：璇玑星座里几座站失去同步。用户是新来的轨道调度员，AI 是站里的领航员，两人查清哪里断了，
 * 把站一座座接回有序轨道。剧本版：领航员的台词写死在 messages（onboarding.story），不接模型、不调 agent。
 *
 * 每个 Orbita 功能是一座站。站有三个状态：
 * - dim：还没出场（星图上只是一粒暗点，没有名字）
 * - lost：出场了、失步（闪烁、虚线），故事里正有一个麻烦等着它
 * - linked：接通了（实心、连上线）
 * 「出场」发生在它的功能登场的**前一步**（上一步台词里先说麻烦），「接通」发生在做完那件事之后。
 */
import { GUIDE, type ChapterId, type StepPage } from "../onboarding-pages.ts";
import type { OnboardingStyle, ThemePreference } from "@shared/settings";

export const STATION_IDS = ["pilot", "archive", "observatory", "verify", "wing", "route", "log", "hq", "protocol", "patrol"] as const;
export type StationId = (typeof STATION_IDS)[number];
export type StationState = "dim" | "lost" | "linked";

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
  "folder",
  "read",
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

export interface StoryStep {
  id: StepId;
  /** 0 = 序幕，1 / 2 / 3 = 三幕：通电与读档 / 追查与辨伪 / 对接与巡航 */
  act: Act;
  /** 站内展示的功能真截图（缺 = 这一步没有功能登场） */
  shot?: ShotRef;
  /** 到这一步时出场（变 lost）的站 */
  wake?: readonly StationId[];
  /** 到这一步时接通的站 */
  link?: readonly StationId[];
  /** 到这一步时要等辨伪环节过了才接通的站（用户核对出冒名信号，站才亮） */
  gateLink?: readonly StationId[];
  /** 这一步是辨伪环节：两条报告 + 原文，核对后才能选 */
  gate?: true;
  /** 这一步在聊哪座站（星图上给它一圈光；缺 = 整幅星图） */
  about?: StationId;
  /** 这一步的主操作按钮写的是剧情里的动作（文案里 steps.<id>.cue），而不是「下一步」 */
  cue?: true;
  /** 通电这一步：附一个「现在就去接」的出口（打开设置 › 模型服务商） */
  exitToProviders?: true;
}

export const STEPS: readonly StoryStep[] = [
  { id: "wake", about: "pilot", act: 0, wake: ["pilot"], cue: true },
  { id: "power", about: "pilot", act: 1, shot: { chapter: "start", page: "providers" }, wake: ["archive"], cue: true, exitToProviders: true },
  { id: "folder", about: "archive", act: 1, shot: { chapter: "files", page: "files" }, link: ["pilot"], cue: true },
  { id: "read", about: "archive", act: 1, shot: { chapter: "task", page: "watch" }, wake: ["observatory"], cue: true },
  { id: "browse", about: "observatory", act: 1, shot: { chapter: "browser", page: "read" }, link: ["archive"], wake: ["verify"], cue: true },
  { id: "reports", about: "verify", act: 2, gate: true, link: ["observatory"], gateLink: ["verify"] },
  { id: "verified", about: "verify", act: 2, shot: { chapter: "quote", page: "pdf" }, wake: ["wing"], cue: true },
  { id: "fires", about: "wing", act: 2, shot: { chapter: "subsessions", page: "dispatch" }, wake: ["route"], cue: true },
  { id: "route", about: "route", act: 2, shot: { chapter: "progress", page: "plan" }, link: ["wing"], wake: ["log"], cue: true },
  { id: "memory", about: "log", act: 3, shot: { chapter: "memory", page: "remember" }, link: ["route"], wake: ["hq"], cue: true },
  { id: "report", about: "hq", act: 3, shot: { chapter: "docs", page: "export" }, link: ["log"], wake: ["protocol"], cue: true },
  { id: "protocol", about: "protocol", act: 3, shot: { chapter: "plugins", page: "make" }, link: ["hq"], wake: ["patrol"], cue: true },
  { id: "patrol", about: "patrol", act: 3, shot: { chapter: "automation", page: "create" }, link: ["protocol"], cue: true },
  { id: "chart", act: 3, shot: { chapter: "board", page: "week" }, link: ["patrol"], cue: true },
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

/** 两条报告：a 与原文对得上，b 是编的（原文写的是 four distinct datasets，没有 CHI-bike） */
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
  /** 原文里要高亮的那一句关键片段 */
  mark: "four distinct datasets: NYC-taxi, NYC-bike, NYC-crime, and CHI-taxi",
} as const;

/** 两条报告各自的数据集清单与「引文」。甲的引文是原文里真有的；乙的引文原文里找不到（编的） */
export const REPORTS: Record<ReportId, { datasets: readonly string[]; quote: string }> = {
  a: {
    datasets: ["NYC-taxi", "NYC-bike", "NYC-crime", "CHI-taxi"],
    quote: "four distinct datasets: NYC-taxi, NYC-bike, NYC-crime, and CHI-taxi",
  },
  b: {
    datasets: ["NYC-taxi", "NYC-bike", "NYC-crime", "CHI-taxi", "CHI-bike"],
    quote: "five distinct datasets: NYC-taxi, NYC-bike, NYC-crime, CHI-taxi, and CHI-bike",
  },
};

export interface Gate {
  /** 点开过原文（不点开，选不了） */
  opened: boolean;
  /** 选过的最后一条（选错会留着，用来给反馈） */
  picked: ReportId | null;
  /** 选错的次数（不惩罚，只用来换一句反馈） */
  wrong: number;
  /** 过了 */
  solved: boolean;
  /** 是领航员替选的（不是用户自己挑出来的）：台词会不一样 */
  byPilot: boolean;
}

export const FRESH_GATE: Gate = { opened: false, picked: null, wrong: 0, solved: false, byPilot: false };

export interface StoryState {
  index: number;
  gate: Gate;
}

export function initialState(index = 0): StoryState {
  return { index: Math.min(STEP_COUNT - 1, Math.max(0, index)), gate: FRESH_GATE };
}

export function atGate(state: StoryState): boolean {
  return stepOf(state.index).gate === true;
}

/** 这一步还过不去：辨伪环节没解开。→ 键 / 主按钮在这里先推进核对，而不是翻页 */
export function gateOpen(state: StoryState): boolean {
  return atGate(state) && !state.gate.solved;
}

export function openOriginal(state: StoryState): StoryState {
  if (!atGate(state) || state.gate.opened) return state;
  return { ...state, gate: { ...state.gate, opened: true } };
}

/** 选一条报告当「对不上原文的」。没点开原文不让选；选对过关，选错记一次、能重选 */
export function pickReport(state: StoryState, report: ReportId): StoryState {
  if (!gateOpen(state) || !state.gate.opened) return state;
  if (report === FAKE_REPORT) return { ...state, gate: { ...state.gate, picked: report, solved: true } };
  return { ...state, gate: { ...state.gate, picked: report, wrong: state.gate.wrong + 1 } };
}

/**
 * 「下一步」：
 * - 辨伪环节没解开时，先翻开原文；原文已开还没选，领航员替你指出来（过关，byPilot）——
 *   只按 → 的人也能走完，亲手选的人得到的是自己的那一下
 * - 否则翻页；最后一页之后是 "finish"（调用方收尾、写看过）
 */
export function pressNext(state: StoryState): StoryState | "finish" {
  if (gateOpen(state)) {
    if (!state.gate.opened) return openOriginal(state);
    return { ...state, gate: { ...state.gate, picked: FAKE_REPORT, solved: true, byPilot: true } };
  }
  if (state.index >= STEP_COUNT - 1) return "finish";
  return { ...state, index: state.index + 1 };
}

/** 「上一步」：直接退一页，辨伪的进度保留（退回来看，已过的仍是已过） */
export function pressPrev(state: StoryState): StoryState {
  if (state.index <= 0) return state;
  return { ...state, index: state.index - 1 };
}

/** 主按钮该写什么：辨伪环节按它的进度换字，最后一页是收尾，其余按这一步有没有剧情动作 */
export type NextLabel = "cue" | "next" | "gateOpen" | "gatePilot" | "finish";
export function nextLabel(state: StoryState): NextLabel {
  const step = stepOf(state.index);
  if (gateOpen(state)) return state.gate.opened ? "gatePilot" : "gateOpen";
  if (state.index >= STEP_COUNT - 1) return "finish";
  return step.cue === true ? "cue" : "next";
}

// ---------------------------------------------------------------------------
// 站点状态
// ---------------------------------------------------------------------------

function firstStep(pick: (step: StoryStep) => readonly StationId[] | undefined, station: StationId): number {
  return STEPS.findIndex((step) => pick(step)?.includes(station) === true);
}

/** 一座站在这一刻的状态（第几步 + 辨伪进度） */
export function stationState(station: StationId, state: StoryState): StationState {
  const linkAt = firstStep((step) => step.link, station);
  const gateLinkAt = firstStep((step) => step.gateLink, station);
  const wakeAt = firstStep((step) => step.wake, station);
  if (linkAt !== -1 && state.index >= linkAt) return "linked";
  if (gateLinkAt !== -1) {
    // 辨伪环节里接通的站：那一步里要等过了关；过了那一步一律算接通
    if (state.index > gateLinkAt) return "linked";
    if (state.index === gateLinkAt && state.gate.solved) return "linked";
  }
  if (wakeAt !== -1 && state.index >= wakeAt) return "lost";
  return "dim";
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

/** 这一步里「正在聊」的站：这一步该高亮哪座（出场的、或这一步要接通的） */
export function focusStation(index: number): StationId | undefined {
  return stepOf(index).about;
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
