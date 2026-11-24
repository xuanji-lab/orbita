/**
 * 星系设计面板「生成形象」的契约（四层契约第 1 层）：给一颗天体（主星或一颗子智能体行星）出 2–3 张无脸地表候选，
 * 用户挑一张写进 planet/。眼睛、星环仍由代码画，候选只是地表。
 *
 * 谁出图：插件「行星造物」（planet-forge）的 planet-render 技能。主进程在后台开一条**幕后会话**（session meta 的
 * backstage = "avatar"，不进任何列表），让智能体照技能跑 render_surface.py plan → 逐位出图（图像生成 MCP 工具 /
 * 自己写 SVG）→ submit / fail。候选位、后端、降级链、重画上限全由插件的用户原则（render-policy.json）定，这里不写死。
 * 进度不从对话里抠：主进程轮询插件的账本 `<候选目录>/manifest.json`（插件写、界面读），翻成 AvatarJob 推给面板。
 *
 * 候选目录（与插件技能「放在设计稿旁边的 planet/surfaces/」一致）：
 * - 主星：`planet/surfaces/`
 * - 行星：`planet/agents/<id>/surfaces/`
 * 选中后 galaxy.json 的 surface 指向 `<候选目录>/candidates/<文件>`（相对 planet/，与集成分支现有约定同一个基准）；
 * 有插件设计稿（主星的 planet/design.json、行星伴随文件里登记的 design）时再跑插件的 `select` 写稿，两边同源。
 */

/** 插件的三种后端：图像生成工具 / 智能体画 SVG / 用户给的图（面板这一版不收用户的图） */
export type AvatarBackend = "image_model" | "model_svg" | "user_image";
export const AVATAR_BACKENDS: readonly AvatarBackend[] = ["image_model", "model_svg", "user_image"];

export function isAvatarBackend(value: unknown): value is AvatarBackend {
  return typeof value === "string" && (AVATAR_BACKENDS as readonly string[]).includes(value);
}

/** 一次尝试（插件账本 slots[].attempts[] 的子集） */
export interface AvatarAttempt {
  backend: AvatarBackend;
  ok: boolean;
  /** 没过校验 / 失败的原因（插件原话） */
  reasons: string[];
  /** 工具根本不可用（直接降级、不占次数） */
  unavailable: boolean;
  /** 出图工具全名（image_model 才有） */
  tool: string | null;
}

/**
 * 一个候选位：
 * - working：还在出（智能体在画 / 在等图像工具），backend 是此刻在用的后端；
 * - done：收下了一张，image 是给面板看的小图（data URL，无脸，眼睛由面板代码叠）；
 * - failed：这一位所有后端都用完了（reason 写哪里没过），或这一轮结束 / 超时 / 取消了还没交图。
 */
export type AvatarSlotState = "working" | "done" | "failed";

export interface AvatarSlot {
  slot: number;
  /** 原则里这一位想用的后端 */
  wanted: AvatarBackend;
  /** 此刻（或最后）用的后端：与 wanted 不同 = 降级了 */
  backend: AvatarBackend;
  state: AvatarSlotState;
  attempts: AvatarAttempt[];
  /** 收下的候选 id（插件的 r<轮>-s<位>），done 才有 */
  candidateId: string | null;
  image: string | null;
  /** 失败原因；working / done 为 null */
  reason: string | null;
}

/**
 * 一次出图的整体状态：
 * - preparing：幕后会话开起来了，智能体还没跑完 plan（候选位按原则先占位）；
 * - running：plan 好了，候选在一张张出；
 * - ready：这一轮结束，至少有一张候选，等用户挑；
 * - pending：这一轮结束，一张都没出来——这颗天体还没有地表就显示「待出图」（代码画的默认球）；
 * - selected：用户挑好了，已写进 planet/；
 * - failed：没能开始或中途断了（没装插件、没有可用模型、幕后会话起不来……），error 说原因。
 */
export type AvatarJobState = "preparing" | "running" | "ready" | "pending" | "selected" | "failed";

export interface AvatarJob {
  workspaceId: string;
  /** "main" = 主星；否则是 galaxy.json 里行星的 id */
  bodyId: string;
  state: AvatarJobState;
  /** 插件账本的轮次；preparing 时还没有 */
  round: number | null;
  slots: AvatarSlot[];
  /** 插件 plan 的说明（如「没有可用的图像生成工具，改让智能体画 SVG」） */
  notes: string[];
  /** 用的哪条原则（插件 render-policy.json 的 label） */
  policy: string | null;
  /** 跑这一轮的模型；从盘上账本恢复的旧轮次为 null */
  model: { providerId: string; modelId: string } | null;
  /** 幕后会话 id（排查用）；从盘上恢复的旧轮次为 null */
  sessionId: string | null;
  /** 选中的候选 id（selected 才有） */
  selected: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

/** 正在出图的状态（面板据此显示「生成中」、禁用按钮） */
export function isAvatarJobLive(job: AvatarJob | null): boolean {
  return job !== null && (job.state === "preparing" || job.state === "running");
}

export interface AvatarBodyRef {
  workspaceId: string;
  bodyId: string;
}

/** 面板点「生成形象」/「再来一组」 */
export interface AvatarGenerateRequest extends AvatarBodyRef {
  /**
   * 这颗天体此刻的元素构成（面板里看到的那一份，含没落盘的默认构成）：插件的 visual_plan.py 认 Orbita mix 原样。
   * 缺席 = 主进程读 galaxy.json 里存着的。
   */
  mix?: unknown;
  /** 面板里的名字（还没写回盘时也按它出图） */
  name?: string;
  /** 用户这一轮用自然语言写的修改要求；没有 baseCandidateId 时当作附加要求重出一组 */
  instruction?: string;
  /** 以哪张旧候选为基础改（插件的 r<轮>-s<位>）；缺席 = 不以某张为基础 */
  baseCandidateId?: string;
  /** 聊天修改用：以 galaxy.json 当前在用的 surface 为基础；候选在账本里就带原提示词，否则直接读当前图 */
  useCurrentSurface?: boolean;
}

export interface AvatarSelectRequest extends AvatarBodyRef {
  candidateId: string;
}

export type AvatarJobResult = { ok: true; job: AvatarJob | null } | { ok: false; error: string };

/** 历史里的一张图：image 与候选格一样是给面板看的小图；文件仍留在 planet/ 的 candidates/ 里 */
export interface AvatarHistoryCandidate {
  candidateId: string;
  backend: AvatarBackend;
  image: string | null;
}

/** 一次出图请求及其那一轮交出的图；round 为 null = 请求已记下，但插件还没跑出 plan / 没能开始 */
export interface AvatarHistoryEntry {
  id: string;
  round: number | null;
  instruction: string | null;
  baseCandidateId: string | null;
  startedAt: number;
  candidates: AvatarHistoryCandidate[];
}

export interface AvatarHistory {
  entries: AvatarHistoryEntry[];
  /** 此刻在用的候选（从 galaxy.json 的 surface 反推，旧轮次也能认出来） */
  selected: string | null;
}

export type AvatarHistoryResult = { ok: true; history: AvatarHistory } | { ok: false; error: string };

/** 主进程 → renderer 的进度推送（同一颗天体后一次覆盖前一次） */
export interface AvatarJobEvent {
  job: AvatarJob;
}

const BODY_ID = /^(main|[\w-]{1,64})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAvatarBodyRef(raw: unknown): raw is AvatarBodyRef {
  return isRecord(raw) && typeof raw["workspaceId"] === "string" && raw["workspaceId"] !== "" && typeof raw["bodyId"] === "string" && BODY_ID.test(raw["bodyId"]);
}

export function isAvatarGenerateRequest(raw: unknown): raw is AvatarGenerateRequest {
  if (!isAvatarBodyRef(raw) || !isRecord(raw)) return false;
  const name = raw["name"];
  const instruction = raw["instruction"];
  const base = raw["baseCandidateId"];
  return (
    (name === undefined || (typeof name === "string" && name.length <= 200)) &&
    (instruction === undefined || (typeof instruction === "string" && instruction.trim() !== "" && instruction.length <= AVATAR_INSTRUCTION_MAX)) &&
    (base === undefined || (typeof base === "string" && CANDIDATE_ID.test(base)))
  ) && (raw["useCurrentSurface"] === undefined || typeof raw["useCurrentSurface"] === "boolean");
}

export function isAvatarSelectRequest(raw: unknown): raw is AvatarSelectRequest {
  return isAvatarBodyRef(raw) && isRecord(raw) && typeof raw["candidateId"] === "string" && CANDIDATE_ID.test(raw["candidateId"]);
}

/** 自然语言修改要求的上限（够写清几件事，也避免把整篇文档塞进出图提示词） */
export const AVATAR_INSTRUCTION_MAX = 1000;
const CANDIDATE_ID = /^r\d{1,4}-s\d{1,2}$/;

/** 一轮最多几个候选位（插件原则里的 candidates；再多面板放不下，也没有挑的意义） */
export const AVATAR_SLOTS_MAX = 4;
/** 一轮最长多久（ms）：到点还没交的位记「超时」并停掉幕后会话。Qwen turbo 一张 10–20 s，SVG 一张约一分钟，三位串行加重画留足余量 */
export const AVATAR_JOB_TIMEOUT_MS = 8 * 60 * 1000;
