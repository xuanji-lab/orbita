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
import { defaultThinkingLevel } from "./model-defaults.ts";
import { isProviderEnabled, type ProviderDto } from "./provider.ts";
import type { AppSettings, AvatarModelChoice, ModelPair } from "./settings.ts";
import type { ThinkingLevel } from "./thinking.ts";

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
  /**
   * 这一组用哪个模型（面板按用户的取法解析好的具体型号；见 `pickAvatarModel`）。缺席 = 主进程按设置兜底解析。
   * 面板显示什么就发什么：点之前胶囊上写的型号与这一轮实际开的型号是同一对，不靠两边各解析一遍对得上。
   */
  model?: ModelPair;
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
    (base === undefined || (typeof base === "string" && CANDIDATE_ID.test(base))) &&
    (raw["useCurrentSurface"] === undefined || typeof raw["useCurrentSurface"] === "boolean") &&
    (raw["model"] === undefined || isModelPair(raw["model"]))
  );
}

/** 一对非空的 providerId + modelId（请求里的 model、设置里的取法都认这一种形状） */
function isModelPair(value: unknown): value is ModelPair {
  return isRecord(value) && typeof value["providerId"] === "string" && value["providerId"] !== "" && typeof value["modelId"] === "string" && value["modelId"] !== "";
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

// ── 用生图工具还是手绘（面板的开关；真源是插件的策略文件） ─────────────────────

/** 面板「用生图工具」开关的两态：关 = 只让智能体手绘，开 = 用生图工具出候选（工具不在 / 出不来时插件自己退回手绘） */
export const AVATAR_RENDER_MODES = ["hand_drawn", "image_tool"] as const;
export type AvatarRenderMode = (typeof AVATAR_RENDER_MODES)[number];

export function isAvatarRenderMode(value: unknown): value is AvatarRenderMode {
  return typeof value === "string" && (AVATAR_RENDER_MODES as readonly string[]).includes(value);
}

/** 每一档对应插件「行星造物」策略的哪个预设（render_surface.py 的 PRESETS）。面板只写这两档 */
export const AVATAR_RENDER_PRESETS: Readonly<Record<AvatarRenderMode, string>> = { hand_drawn: "svg", image_tool: "image_only" };

/**
 * 开关此刻的状态。真源是插件的策略文件 `<插件根>/data/render-policy.json`，读写都经插件脚本
 * `render_surface.py policy`——面板不直接改那个文件。面板只有两档，策略文件里的档更多：
 * - svg → 关；image_only → 开；
 * - image_first（图像 2 张 + 手绘 1 张，面板没有这一档）→ 读出来当「开」，用户一拨开关才换成新档；
 * - ask / custom → 按候选位里有没有生图工具显示；原话留在 label / note / candidates 里，面板照实说，不去改用户的文件。
 */
export interface AvatarRenderPolicy {
  mode: AvatarRenderMode;
  /** 策略文件里的预设（svg / image_first / image_only / ask / custom）；读不出来为 null */
  preset: string | null;
  /** 插件给这条原则的原话 */
  label: string | null;
  /** 用户记在原则里的备注 */
  note: string | null;
  /** 原则里的候选位（image_model / model_svg / user_image） */
  candidates: string[];
  /** 策略文件还没有（新用户）：按默认手绘走；第一次在面板出图前应用把它落成已决定 */
  decided: boolean;
  /** 文件在但读不出来（不是 JSON、预设不认识……）：插件给的原因写这里，mode 按手绘显示 */
  problem: string | null;
}

/**
 * 面板改出图原则时写进策略文件 note 的那一句。用户自己写的备注留在前面；面板以前追加的记录先剥掉——
 * 只留「用户的备注 + 最近这一次」，不会拨一次长一截。
 */
export function avatarPolicyNote(previous: string | null, stamp: string, change: string): string {
  const own = (previous ?? "").replace(/；\d{4}-\d{2}-\d{2} \d{2}:\d{2} 在 Orbita 的星系设计面板里[^；]*/g, "").trim();
  const line = `${stamp} 在 Orbita 的星系设计面板里${change}`;
  return own === "" ? line : `${own}；${line}`;
}

/** ok:false = 插件没装，或它的出图脚本没跑起来（面板上开关不可用，原因照实显示） */
export type AvatarRenderPolicyResult = { ok: true; policy: AvatarRenderPolicy } | { ok: false; error: string };

/** 面板拨开关 */
export interface AvatarRenderPolicySetRequest {
  mode: AvatarRenderMode;
}

export function isAvatarRenderPolicySetRequest(raw: unknown): raw is AvatarRenderPolicySetRequest {
  return isRecord(raw) && isAvatarRenderMode(raw["mode"]);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * 插件 `policy` 读命令的输出（任意形状都接）→ 开关的状态。不抛：插件没说出一句有用的话时也回一个带 problem 的手绘态，
 * 面板照实显示原因。
 */
export function avatarRenderPolicyOf(raw: unknown): AvatarRenderPolicy {
  const blank = { label: null, note: null, candidates: [], decided: true };
  if (!isRecord(raw) || raw["ok"] !== true) {
    const message = isRecord(raw) ? text(raw["message"]) : null;
    return { mode: "hand_drawn", preset: null, ...blank, problem: message ?? "插件没有说出图原则" };
  }
  const policy = isRecord(raw["policy"]) ? raw["policy"] : {};
  const preset = text(policy["preset"]);
  if (preset === null) return { mode: "hand_drawn", preset: null, ...blank, problem: "插件没有说出图原则是哪一档" };
  const candidates = stringsOf(policy["candidates"]);
  const usesImageTool = preset === "image_only" || preset === "image_first" || (preset === "custom" && candidates.includes("image_model"));
  return {
    mode: usesImageTool ? "image_tool" : "hand_drawn",
    preset,
    label: text(policy["label"]),
    note: text(policy["note"]),
    candidates,
    decided: policy["decided"] !== false,
    problem: null,
  };
}

// ── 这一组用哪个模型 ────────────────────────────────────────────────────

/** 取法落到的型号，和它是怎么来的（面板照这个写胶囊，主进程照这个定思考档） */
export interface AvatarModelPick extends ModelPair {
  /** session = 跟会话栏（或「子会话模型」退回了会话栏）；sub_session_model = 设置里的子会话默认模型；picked = 面板里挑定的型号 */
  source: "session" | "sub_session_model" | "picked";
}

/**
 * 取法 → 此刻的型号（**只挑不校验**，校验在 `checkAvatarModel`）。面板与主进程共用这一份：
 * 面板拿它的结果写胶囊并随请求发来，主进程兜底时（请求没带型号）自己再挑一遍。
 * - 没选过：会话栏此刻的模型（`session`），没有就是没有——不拿别家顶上（回 null）；
 * - 「子会话模型」：设置里的子会话默认模型；它那家被关 / 被删 / 没设时退回会话栏（同原子会话的退回）；
 * - 挑了具体型号：原样返回，哪怕它已不可用——换成别家不是这里的事。
 */
export function pickAvatarModel(
  choice: AvatarModelChoice | undefined,
  session: ModelPair | undefined,
  settings: Pick<AppSettings, "subSessionModel">,
  providers: readonly ProviderDto[],
): AvatarModelPick | null {
  if (choice === "sub_session") {
    const sub = settings.subSessionModel;
    const owner = sub === undefined ? undefined : providers.find((provider) => provider.id === sub.providerId);
    if (sub !== undefined && owner !== undefined && isProviderEnabled(owner)) return { ...sub, source: "sub_session_model" };
    return session === undefined ? null : { ...session, source: "session" };
  }
  if (choice !== undefined) return { ...choice, source: "picked" };
  return session === undefined ? null : { ...session, source: "session" };
}

/** 这个型号此刻用不了的原因（面板与主进程各翻各的那句话，原因只有这一份） */
export interface AvatarModelUnavailable {
  /** provider_gone = 服务商被删了；provider_off = 服务商关着；model_gone = 型号已不在它的模型列表里 */
  kind: "provider_gone" | "provider_off" | "model_gone";
  providerId: string;
  modelId: string;
  /** 服务商的显示名；被删了为 null */
  providerName: string | null;
}

export type AvatarModelCheck = { ok: true } | { ok: false; reason: AvatarModelUnavailable };

/** 服务商开着、型号还在它的模型列表里 = 能用。**不静默换别家**：渠道不替用户选（同自动化、delegate 的口径） */
export function checkAvatarModel(pair: ModelPair, providers: readonly ProviderDto[]): AvatarModelCheck {
  const provider = providers.find((candidate) => candidate.id === pair.providerId);
  if (provider === undefined) return { ok: false, reason: { kind: "provider_gone", ...pair, providerName: null } };
  if (!isProviderEnabled(provider)) return { ok: false, reason: { kind: "provider_off", ...pair, providerName: provider.displayName } };
  if (!provider.models.declared.some((model) => model.id === pair.modelId)) {
    return { ok: false, reason: { kind: "model_gone", ...pair, providerName: provider.displayName } };
  }
  return { ok: true };
}

/** 主进程回给面板的错误句（avatar 这条路上的错误都是中文原句，同文件其它地方） */
export function avatarModelError(reason: AvatarModelUnavailable): string {
  const id = `${reason.providerId}/${reason.modelId}`;
  switch (reason.kind) {
    case "provider_off":
      return `出图用的模型 ${reason.modelId} 所在的服务商「${reason.providerName}」已关闭。到设置 › 模型服务打开它，或在形象一节的模型菜单里换一个。`;
    case "model_gone":
      return `出图用的模型 ${id} 已不在服务商的模型列表里。到设置 › 模型服务重新拉取，或在形象一节的模型菜单里换一个。`;
    default:
      return `出图用的模型 ${id} 的服务商已被删除。在形象一节的模型菜单里换一个。`;
  }
}

export type AvatarModelResolution =
  | (AvatarModelPick & { ok: true; thinkingLevel: ThinkingLevel })
  | { ok: false; error: string };

/**
 * 主进程开这一轮用的模型：**请求里带的型号最优先**（面板显示什么就发什么），没带才按设置里的取法解析。
 * `session` 是会话栏此刻的模型——面板在时它带在请求里，所以这里拿到的是 `lastUsed`。
 * 挑不出、或挑出的型号已不可用：报错说清怎么办，**不换成别家**。
 * 思考档跟型号走：落的是子会话默认模型（且用的正是它）就沿 `subSessionThinking`，否则取该型号的默认档。
 */
export function resolveAvatarModel(input: {
  requested: ModelPair | undefined;
  session: ModelPair | undefined;
  settings: Pick<AppSettings, "avatarModel" | "subSessionModel" | "subSessionThinking">;
  providers: readonly ProviderDto[];
}): AvatarModelResolution {
  const picked = pickAvatarModel(input.settings.avatarModel, input.session, input.settings, input.providers);
  const chosen = input.requested ?? picked;
  if (chosen === null) return { ok: false, error: "会话栏还没有可用模型：先在会话栏选一个模型，或在形象一节的模型菜单里挑一个。" };
  const check = checkAvatarModel(chosen, input.providers);
  if (!check.ok) return { ok: false, error: avatarModelError(check.reason) };
  const sameAsPicked = picked !== null && picked.providerId === chosen.providerId && picked.modelId === chosen.modelId;
  const thinkingLevel =
    picked !== null && sameAsPicked && picked.source === "sub_session_model"
      ? (input.settings.subSessionThinking ?? defaultThinkingLevel(chosen.modelId))
      : defaultThinkingLevel(chosen.modelId);
  return { ok: true, providerId: chosen.providerId, modelId: chosen.modelId, source: sameAsPicked ? picked.source : "picked", thinkingLevel };
}
