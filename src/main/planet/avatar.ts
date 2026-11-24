/**
 * 「生成形象」的主进程核心（不碰 electron，可直测）。契约与取舍见 shared/planet-avatar.ts。
 *
 * 一次出图 = 一条幕后会话（backstage: "avatar"）里的一轮：智能体读插件「行星造物」的 planet-render 技能，跑
 * render_surface.py plan → 逐位出图（图像生成 MCP / 自己写 SVG）→ submit / fail。主进程不碰图像模型，只做三件事：
 * 1. 备好输入（面板里这颗天体的 mix + 名字 + 职能 → <候选目录>/input-<时间>.json）、开幕后会话；
 * 2. 每秒读一次插件账本 <候选目录>/manifest.json，翻成 AvatarJob 推给面板（生成中 / 收下 / 失败 + 原因 + 降级）；
 * 3. 用户挑一张：写 galaxy.json 的 surface（相对 planet/），有插件稿时再跑插件的 select 写稿。
 * 账本在盘上，所以没有活任务时（重启后、换了窗口）按账本最后一轮重建状态——进度不只活在内存里。
 */
import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { writeJsonAtomic } from "../atomic-write.ts";
import type { AgentEvent, SubmitAgentInput } from "../../shared/agent-ipc.ts";
import {
  AVATAR_JOB_TIMEOUT_MS,
  AVATAR_SLOTS_MAX,
  isAvatarBackend,
  isAvatarJobLive,
  type AvatarAttempt,
  type AvatarBackend,
  type AvatarBodyRef,
  type AvatarGenerateRequest,
  type AvatarJob,
  type AvatarJobResult,
  type AvatarSelectRequest,
  type AvatarSlot,
} from "../../shared/planet-avatar.ts";
import { parseCompanion, parseMix, PLANET_DESIGN_FILE, PLANET_DIR, PLANET_GALAXY_FILE, type GalaxyCompanion, type PlanetMix } from "../../shared/planet-design.ts";
import type { PermissionMode } from "../../shared/permission.ts";
import type { SessionMeta } from "../../shared/session.ts";
import { SUB_AGENTS_DIR } from "../../shared/sub-agent.ts";
import type { ThinkingLevel } from "../../shared/thinking.ts";
import type { Workspace } from "../../shared/workspace.ts";
import { insidePlanetDir, readJson, readProfile, withPlanetLock } from "./store.ts";

/** 插件名：出图走它的技能与脚本 */
export const AVATAR_PLUGIN = "planet-forge";
export const AVATAR_SKILL = join("skills", "planet-render", "SKILL.md");
export const AVATAR_SCRIPT = join("scripts", "render_surface.py");
export const AVATAR_POLICY = join("data", "render-policy.json");
/** 候选目录名（主星在 planet/ 下，行星在 planet/agents/<id>/ 下）——与插件技能「planet/surfaces/」一致 */
export const SURFACES_DIR = "surfaces";
/** 幕后会话的权限档：没有人在场审批，脚本与出图工具都要直接跑（提示词把它限定在插件脚本与候选目录里） */
export const AVATAR_MODE: PermissionMode = "skip";
const POLL_MS = 1000;

export interface ScriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type AvatarModel = { ok: true; providerId: string; modelId: string; thinkingLevel: ThinkingLevel } | { ok: false; error: string };

export interface AvatarDeps {
  workspaces: { list(): Promise<Workspace[]> };
  /** 插件「行星造物」的根目录；没装为 null（不看作用域：形象是每个工作区都要的，技能路径直接写进提示词） */
  pluginRoot(): Promise<string | null>;
  sessions: { ensureSession(meta: SessionMeta): Promise<void>; remove(id: string): Promise<void> };
  /** 跑这一轮用哪个模型（子会话默认模型 → 上次用的模型；index.ts 接 resolveAutomationModel） */
  resolveModel(): Promise<AvatarModel>;
  submitTurn(input: SubmitAgentInput): Promise<void>;
  abort(sessionId: string): Promise<void> | void;
  /** 跑插件脚本（python3 <root>/<script> …args），带超时；不抛，退出码照实回 */
  runScript(root: string, args: readonly string[]): Promise<ScriptResult>;
  /** 候选图 → 面板看的小图（png 裁球缩小、svg 原样转 data URL）；读不出为 null */
  loadImage(path: string): Promise<string | null>;
  emit(job: AvatarJob): void;
  now(): number;
  newId(): string;
  pollMs?: number;
  timeoutMs?: number;
}

/** 一颗天体在盘上的位置 */
export interface BodyPlace {
  workspace: Workspace;
  /** 候选目录（绝对） */
  dir: string;
  /** 插件设计稿（绝对）；没有为 null */
  design: string | null;
  name: string;
  role: string | null;
  bodyType: "star" | "rock" | "ice" | "gas" | null;
  mix: PlanetMix | null;
  /** galaxy.json 里此刻的 surface（相对 planet/）；没有为 null */
  surface: string | null;
}

// ── 插件账本（manifest.json）的读法 ─────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

interface ManifestCandidate {
  id: string;
  slot: number;
  backend: AvatarBackend;
  file: string;
}

interface ManifestSlot {
  slot: number;
  wanted: AvatarBackend;
  backend: AvatarBackend;
  status: "pending" | "done" | "exhausted";
  attempts: AvatarAttempt[];
  pendingReason: string | null;
}

export interface ManifestRound {
  round: number;
  slots: ManifestSlot[];
  candidates: ManifestCandidate[];
  notes: string[];
  policy: string | null;
}

function parseAttempt(raw: unknown): AvatarAttempt | null {
  if (!isRecord(raw) || !isAvatarBackend(raw["backend"])) return null;
  return {
    backend: raw["backend"],
    ok: raw["ok"] === true,
    reasons: strings(raw["reasons"]),
    unavailable: raw["unavailable"] === true,
    tool: typeof raw["tool"] === "string" ? raw["tool"] : null,
  };
}

/** 插件账本 → 各轮（宽松：认不出的位与候选丢掉，不抛） */
export function parseManifest(raw: unknown): ManifestRound[] {
  if (!isRecord(raw) || !Array.isArray(raw["rounds"])) return [];
  const rounds: ManifestRound[] = [];
  for (const item of raw["rounds"]) {
    if (!isRecord(item) || typeof item["round"] !== "number") continue;
    const slots: ManifestSlot[] = [];
    for (const slot of Array.isArray(item["slots"]) ? item["slots"] : []) {
      if (!isRecord(slot) || typeof slot["slot"] !== "number" || !isAvatarBackend(slot["backend"])) continue;
      const status = slot["status"] === "done" || slot["status"] === "exhausted" ? slot["status"] : "pending";
      slots.push({
        slot: slot["slot"],
        wanted: isAvatarBackend(slot["wanted"]) ? slot["wanted"] : slot["backend"],
        backend: slot["backend"],
        status,
        attempts: (Array.isArray(slot["attempts"]) ? slot["attempts"] : []).map(parseAttempt).filter((each): each is AvatarAttempt => each !== null),
        pendingReason: typeof slot["pendingReason"] === "string" ? slot["pendingReason"] : null,
      });
    }
    const candidates: ManifestCandidate[] = [];
    for (const cand of Array.isArray(item["candidates"]) ? item["candidates"] : []) {
      if (!isRecord(cand) || typeof cand["id"] !== "string" || typeof cand["slot"] !== "number" || typeof cand["file"] !== "string" || !isAvatarBackend(cand["backend"])) continue;
      candidates.push({ id: cand["id"], slot: cand["slot"], backend: cand["backend"], file: cand["file"] });
    }
    const policy = isRecord(item["policy"]) && typeof item["policy"]["label"] === "string" ? item["policy"]["label"] : null;
    rounds.push({ round: item["round"], slots: slots.slice(0, AVATAR_SLOTS_MAX), candidates, notes: strings(item["notes"]), policy });
  }
  return rounds;
}

/** 一位没交图时写给用户看的原因：最后一次尝试的原话，没有就用兜底的一句 */
function lastReason(slot: ManifestSlot, fallback: string): string {
  if (slot.pendingReason !== null) return slot.pendingReason;
  const last = slot.attempts[slot.attempts.length - 1];
  return last !== undefined && last.reasons.length > 0 ? last.reasons.join("；") : fallback;
}

/**
 * 账本的一轮 → 面板的候选位。ended = 这一轮已经结束（会话停了 / 超时 / 取消 / 重启后读回）：
 * 还在 pending 的位就是没交图，记成失败并写 endReason。
 */
export function slotsOf(round: ManifestRound, images: ReadonlyMap<string, string | null>, ended: string | null): AvatarSlot[] {
  return round.slots.map((slot) => {
    const cand = round.candidates.find((each) => each.slot === slot.slot) ?? null;
    if (slot.status === "done" && cand !== null) {
      return { slot: slot.slot, wanted: slot.wanted, backend: cand.backend, state: "done", attempts: slot.attempts, candidateId: cand.id, image: images.get(cand.file) ?? null, reason: null };
    }
    if (slot.status === "exhausted") {
      return { slot: slot.slot, wanted: slot.wanted, backend: slot.backend, state: "failed", attempts: slot.attempts, candidateId: null, image: null, reason: lastReason(slot, "所有后端都试过了") };
    }
    if (ended !== null) {
      return { slot: slot.slot, wanted: slot.wanted, backend: slot.backend, state: "failed", attempts: slot.attempts, candidateId: null, image: null, reason: ended };
    }
    return { slot: slot.slot, wanted: slot.wanted, backend: slot.backend, state: "working", attempts: slot.attempts, candidateId: null, image: null, reason: null };
  });
}

/** 原则里的候选位（plan 之前先占位）：读插件 render-policy.json 的 candidates；读不到按插件默认（画 2 张 SVG） */
export function policySlots(raw: unknown): { slots: AvatarSlot[]; label: string | null } {
  const list = isRecord(raw) ? strings(raw["candidates"]).filter(isAvatarBackend) : [];
  const wanted: AvatarBackend[] = list.length > 0 ? list.slice(0, AVATAR_SLOTS_MAX) : ["model_svg", "model_svg"];
  return {
    slots: wanted.map((backend, index) => ({ slot: index + 1, wanted: backend, backend, state: "working", attempts: [], candidateId: null, image: null, reason: null })),
    label: isRecord(raw) && typeof raw["label"] === "string" ? raw["label"] : null,
  };
}

/** 盘上的 planet/ 相对路径（统一用 /） */
function planetRelative(workspacePath: string, full: string): string | null {
  const root = resolve(workspacePath, PLANET_DIR);
  const target = resolve(full);
  if (!target.startsWith(root + sep)) return null;
  return relative(root, target).split(sep).join("/");
}

// ── 提示词 ────────────────────────────────────────────────────────────

export function avatarPrompt(input: { root: string; input: string; dir: string; name: string }): string {
  const rs = `python3 "${join(input.root, AVATAR_SCRIPT)}"`;
  return [
    `[星系设计面板 · 生成形象 · ${input.name}] 这一轮是界面在后台替用户派的出图任务：没有人在对话里看着，不要提问、不要等确认、不要寒暄，做完就结束。`,
    "",
    `用插件「行星造物」出图。先用 read 读它的出图技能：${join(input.root, AVATAR_SKILL)}（插件根 ${input.root}；下面 RS = ${rs}）。只做技能的第 1–3 步：`,
    "1. 认出你手边的图像生成工具（技能第 1 步的规则）；有配套的状态工具（如 *_status）先查一次在不在线，不在线就当没有。",
    "2. 出视觉计划和候选位（只跑这一次）：",
    `   RS plan --input "${input.input}" --dir "${input.dir}" --image-tools <认出的工具全名，逗号分隔；一个都没有就去掉这个参数>`,
    "   输出里 needsPolicyChoice 为 true 也不要问，照它给的 slots 出图。",
    "3. 按 slots 逐位出图，交给脚本（submit / fail），按退出码走（5 改了重交、6 换成 slotNow.backend、7 这一位用完），直到每一位都收下或用完：",
    "   - image_model：用 plan 输出的 imagePrompt / negativePrompt 调 imageTool（Qwen 用 turbo 档出候选），每一位换一个种子；出图后亲眼看一遍，有字、水印、眼睛、嘴就 fail 掉重出。",
    `   - model_svg：读 plan 写的 svg-brief，照骨架写一个完整 SVG，存到 ${join(input.dir, "work")}/ 下（如 r<轮>-s<位>.svg）再 submit。`,
    "   - 工具报错或超时：RS fail --reason \"<原话>\"；工具根本不可用加 --unavailable。",
    "4. 不要跑 preview、select、policy；不要改设计稿、galaxy.json 或插件里的文件；不要调 show_plugin_board——挑哪一张由用户在面板里定。",
    "最后用一两句话说每一位的结局。",
  ].join("\n");
}

// ── 任务表 ────────────────────────────────────────────────────────────

interface Live {
  job: AvatarJob;
  place: BodyPlace;
  roundsBefore: number;
  timer: ReturnType<typeof setInterval> | null;
  deadline: ReturnType<typeof setTimeout> | null;
  /** 正在读账本（一次只读一份，慢的那次没读完不叠下一次） */
  busy: boolean;
}

function keyOf(ref: AvatarBodyRef): string {
  return `${ref.workspaceId}\u0000${ref.bodyId}`;
}

export class AvatarJobs {
  private readonly deps: AvatarDeps;
  private readonly live = new Map<string, Live>();
  /** 候选图小图的缓存（文件路径 → data URL）：账本每秒读一次，图不必每秒重解 */
  private readonly images = new Map<string, string | null>();

  constructor(deps: AvatarDeps) {
    this.deps = deps;
  }

  /** 这颗天体在盘上的位置、名字、职能、构成；工作区或行星不在为错误 */
  async place(ref: AvatarBodyRef): Promise<{ ok: true; place: BodyPlace } | { ok: false; error: string }> {
    const workspace = (await this.deps.workspaces.list()).find((each) => each.id === ref.workspaceId);
    if (workspace === undefined) return { ok: false, error: "没有这个工作区" };
    const planetDir = join(workspace.path, PLANET_DIR);
    const companion: GalaxyCompanion = parseCompanion((await readJson(join(planetDir, PLANET_GALAXY_FILE))) ?? null);
    const designOf = async (relativePath: string | undefined): Promise<string | null> => {
      if (relativePath === undefined) return null;
      const full = insidePlanetDir(workspace.path, relativePath);
      if (full === null) return null;
      const raw = await readJson(full);
      return raw === undefined || raw === null ? null : full;
    };
    const nameIn = async (full: string | null): Promise<string | undefined> => {
      if (full === null) return undefined;
      const raw = await readJson(full);
      return isRecord(raw) && typeof raw["name"] === "string" && raw["name"].trim() !== "" ? raw["name"] : undefined;
    };
    if (ref.bodyId === "main") {
      const design = await designOf(PLANET_DESIGN_FILE);
      return {
        ok: true,
        place: {
          workspace,
          dir: join(planetDir, SURFACES_DIR),
          design,
          name: (await nameIn(design)) ?? companion.main?.name ?? workspace.name,
          role: null,
          bodyType: "star",
          mix: companion.main?.mix ?? null,
          surface: companion.main?.surface ?? null,
        },
      };
    }
    const planet = companion.planets.find((each) => each.id === ref.bodyId);
    if (planet === undefined) return { ok: false, error: "星系里没有这颗行星" };
    const design = await designOf(planet.design);
    const profile = await readProfile(workspace.path, planet.id);
    return {
      ok: true,
      place: {
        workspace,
        dir: join(planetDir, SUB_AGENTS_DIR, planet.id, SURFACES_DIR),
        design,
        name: profile?.name ?? (await nameIn(design)) ?? planet.name ?? planet.id,
        role: profile?.role ?? planet.note ?? null,
        bodyType: planet.composition ?? null,
        mix: planet.mix ?? null,
        surface: planet.surface ?? null,
      },
    };
  }

  /** 面板点「生成形象」/「再来一组」：开一轮；同一颗正在出图时拒绝 */
  async generate(request: AvatarGenerateRequest): Promise<AvatarJobResult> {
    const key = keyOf(request);
    if (isAvatarJobLive(this.live.get(key)?.job ?? null)) return { ok: false, error: "这颗星正在出图，等这一组出完或先取消" };
    const located = await this.place(request);
    if (!located.ok) return located;
    const place = located.place;
    const root = await this.deps.pluginRoot();
    if (root === null) return { ok: false, error: "没装插件「行星造物」（planet-forge）：出图走它的技能与脚本，装上后再试" };
    const model = await this.deps.resolveModel();
    if (!model.ok) return { ok: false, error: model.error };

    const mix = request.mix === undefined ? place.mix : (parseMix(request.mix) ?? place.mix);
    const name = request.name !== undefined && request.name.trim() !== "" ? request.name.trim() : place.name;
    const now = this.deps.now();
    await mkdir(join(place.dir, "work"), { recursive: true });
    const inputPath = join(place.dir, `input-${now}.json`);
    // 插件 visual_plan.py 认 { mix, name, role, bodyType }（Orbita mix 原样）；bodyType 定天体类别，与面板按构成推出的类别一致
    await writeJsonAtomic(inputPath, {
      ...(mix === null ? {} : { mix }),
      name,
      ...(place.role === null ? {} : { role: place.role }),
      ...(place.bodyType === null ? {} : { bodyType: place.bodyType }),
      source: "orbita-galaxy-designer",
    });
    const roundsBefore = parseManifest(await readJson(join(place.dir, "manifest.json"))).length;
    const policy = policySlots(await readJson(join(root, AVATAR_POLICY)));
    const sessionId = this.deps.newId();
    const job: AvatarJob = {
      workspaceId: request.workspaceId,
      bodyId: request.bodyId,
      state: "preparing",
      round: null,
      slots: policy.slots,
      notes: [],
      policy: policy.label,
      model: { providerId: model.providerId, modelId: model.modelId },
      sessionId,
      selected: null,
      error: null,
      startedAt: now,
      finishedAt: null,
    };
    const live: Live = { job, place, roundsBefore, timer: null, deadline: null, busy: false };
    this.live.set(key, live);
    await this.deps.sessions.ensureSession({
      id: sessionId,
      title: `生成形象 · ${name}`,
      titleSource: "user",
      cwd: place.workspace.path,
      workspaceId: place.workspace.id,
      backstage: "avatar",
      providerId: model.providerId,
      modelId: model.modelId,
      mode: AVATAR_MODE,
      thinkingLevel: model.thinkingLevel,
      piSessionFile: null,
      pinned: false,
      archived: false,
      starred: false,
      unread: null,
      recentQueries: [],
      stats: null,
      createdAt: now,
      updatedAt: now,
    });
    try {
      await this.deps.submitTurn({
        sessionId,
        cwd: place.workspace.path,
        workspaceId: place.workspace.id,
        resume: null,
        providerId: model.providerId,
        modelId: model.modelId,
        mode: AVATAR_MODE,
        thinkingLevel: model.thinkingLevel,
        text: avatarPrompt({ root, input: inputPath, dir: place.dir, name }),
      });
    } catch (cause) {
      await this.deps.sessions.remove(sessionId).catch(() => undefined);
      this.live.delete(key);
      return { ok: false, error: `出图的幕后会话没开起来：${cause instanceof Error ? cause.message : String(cause)}` };
    }
    live.timer = setInterval(() => void this.poll(key), this.deps.pollMs ?? POLL_MS);
    live.deadline = setTimeout(() => void this.end(key, "超时了，这一位没交图"), this.deps.timeoutMs ?? AVATAR_JOB_TIMEOUT_MS);
    // 计时不拖住进程退出（应用退出、测试结束）
    live.timer.unref?.();
    live.deadline.unref?.();
    this.deps.emit(job);
    return { ok: true, job };
  }

  /** 读这颗天体当前这一轮：有活任务给活的，没有就按盘上账本的最后一轮重建；从没出过图为 null */
  async get(ref: AvatarBodyRef): Promise<AvatarJobResult> {
    const live = this.live.get(keyOf(ref));
    if (live !== undefined) return { ok: true, job: live.job };
    const located = await this.place(ref);
    if (!located.ok) return { ok: true, job: null };
    const place = located.place;
    const rounds = parseManifest(await readJson(join(place.dir, "manifest.json")));
    const last = rounds[rounds.length - 1];
    if (last === undefined) return { ok: true, job: null };
    const slots = await this.slotsWithImages(place, last, "上次没出完（应用退出或中断了），这一位没交图");
    const chosen = last.candidates.find((cand) => planetRelative(place.workspace.path, join(place.dir, cand.file)) === place.surface) ?? null;
    const at = await stat(join(place.dir, "manifest.json")).then((info) => info.mtimeMs, () => 0);
    return {
      ok: true,
      job: {
        workspaceId: ref.workspaceId,
        bodyId: ref.bodyId,
        state: chosen !== null ? "selected" : slots.some((slot) => slot.state === "done") ? "ready" : "pending",
        round: last.round,
        slots,
        notes: last.notes,
        policy: last.policy,
        model: null,
        sessionId: null,
        selected: chosen?.id ?? null,
        error: null,
        startedAt: at,
        finishedAt: at,
      },
    };
  }

  /** 用户挑一张：写进 galaxy.json（相对 planet/）；有插件稿时跑插件的 select 写稿 */
  async select(request: AvatarSelectRequest): Promise<AvatarJobResult> {
    const key = keyOf(request);
    if (isAvatarJobLive(this.live.get(key)?.job ?? null)) return { ok: false, error: "这一组还在出，出完再挑" };
    const located = await this.place(request);
    if (!located.ok) return located;
    const place = located.place;
    const rounds = parseManifest(await readJson(join(place.dir, "manifest.json")));
    const cand = rounds.flatMap((round) => round.candidates).find((each) => each.id === request.candidateId);
    if (cand === undefined) return { ok: false, error: `没有候选 ${request.candidateId}` };
    const full = join(place.dir, cand.file);
    const surface = planetRelative(place.workspace.path, full);
    if (surface === null) return { ok: false, error: "候选图不在 planet/ 里" };
    const exists = await stat(full).then((info) => info.isFile(), () => false);
    if (!exists) return { ok: false, error: `候选图不见了：${cand.file}` };
    const warnings: string[] = [];
    // 插件稿先写（它再校验一遍图；不过就不改 galaxy.json，两边不各说各的）
    if (place.design !== null) {
      const root = await this.deps.pluginRoot();
      if (root !== null) {
        const out = await this.deps.runScript(root, ["select", "--dir", place.dir, "--pick", cand.id, "--design", place.design]);
        if (out.code !== 0) return { ok: false, error: `插件写设计稿没成：${scriptMessage(out)}` };
      } else {
        warnings.push("没装插件，只写了 galaxy.json，插件设计稿没跟着改");
      }
    }
    await withPlanetLock(place.workspace.path, async () => {
      const path = join(place.workspace.path, PLANET_DIR, PLANET_GALAXY_FILE);
      const companion = parseCompanion((await readJson(path)) ?? null);
      // 新地表一律不翻转：flip 是给旧的 Qwen 图（风暴落在嘴区）用的，新图出图时已按嘴区规则避开
      if (request.bodyId === "main") {
        companion.main = { ...(companion.main ?? {}), surface, flip: false };
      } else {
        companion.planets = companion.planets.map((planet) => (planet.id === request.bodyId ? { ...planet, surface, flip: false } : planet));
      }
      await writeJsonAtomic(path, companion);
    });
    const read = await this.get(request);
    const job = read.ok ? read.job : null;
    const done: AvatarJob = { ...(job ?? this.emptyJob(request)), state: "selected", selected: cand.id, notes: [...(job?.notes ?? []), ...warnings] };
    this.deps.emit(done);
    return { ok: true, job: done };
  }

  async cancel(ref: AvatarBodyRef): Promise<AvatarJobResult> {
    const live = this.live.get(keyOf(ref));
    if (live === undefined || !isAvatarJobLive(live.job)) return { ok: true, job: live?.job ?? null };
    await this.end(keyOf(ref), "你停下了，这一位没交图", true);
    return { ok: true, job: this.live.get(keyOf(ref))?.job ?? null };
  }

  /** agent 事件旁听：幕后会话这一轮停了（完成 / 出错 / 被停）→ 收尾；agent 进程整个挂了 → 全部收尾 */
  onAgentEvent(event: AgentEvent): void {
    if (event.type === "phase" && event.phase === "idle") {
      for (const [key, live] of this.live) if (live.job.sessionId === event.sessionId && isAvatarJobLive(live.job)) void this.end(key, "智能体这一轮结束了，这一位没交图");
    }
    if (event.type === "failed" && event.sessionId === null) {
      for (const [key, live] of this.live) if (isAvatarJobLive(live.job)) void this.end(key, "智能体进程断了，这一位没交图");
    }
  }

  /** 读一次账本推一次进度（只在内容变了时推） */
  private async poll(key: string): Promise<void> {
    const live = this.live.get(key);
    if (live === undefined || !isAvatarJobLive(live.job) || live.busy) return;
    live.busy = true;
    try {
      const next = await this.snapshot(live, null);
      if (!isAvatarJobLive(live.job)) return;
      // 每一位都收下或用完了：不等会话停，直接收尾（停计时、定结局）
      if (!isAvatarJobLive(next)) {
        live.busy = false;
        await this.end(key, "智能体这一轮结束了，这一位没交图");
        return;
      }
      if (JSON.stringify(next) !== JSON.stringify(live.job)) {
        live.job = next;
        this.deps.emit(next);
      }
    } finally {
      live.busy = false;
    }
  }

  private async snapshot(live: Live, ended: string | null, cancelled = false): Promise<AvatarJob> {
    const rounds = parseManifest(await readJson(join(live.place.dir, "manifest.json")));
    const round = rounds.length > live.roundsBefore ? rounds[rounds.length - 1] : undefined;
    if (round === undefined) {
      if (ended === null) return live.job;
      // 智能体没跑到 plan 就停了：候选位按原则占着的都记失败。用户自己停的不算出错，只是这一组没出（待出图）
      return {
        ...live.job,
        state: cancelled ? "pending" : "failed",
        slots: live.job.slots.map((slot) => ({ ...slot, state: "failed", reason: ended })),
        error: cancelled ? null : "智能体没有跑插件的 plan，这一组没有开始出图",
        finishedAt: this.deps.now(),
      };
    }
    const slots = await this.slotsWithImages(live.place, round, ended);
    const finished = ended !== null || slots.every((slot) => slot.state !== "working");
    return {
      ...live.job,
      round: round.round,
      slots,
      notes: round.notes,
      policy: round.policy ?? live.job.policy,
      state: !finished ? "running" : slots.some((slot) => slot.state === "done") ? "ready" : "pending",
      finishedAt: finished ? this.deps.now() : null,
    };
  }

  private async slotsWithImages(place: BodyPlace, round: ManifestRound, ended: string | null): Promise<AvatarSlot[]> {
    for (const cand of round.candidates) {
      const full = join(place.dir, cand.file);
      if (!this.images.has(full)) this.images.set(full, await this.deps.loadImage(full));
    }
    const byFile = new Map(round.candidates.map((cand) => [cand.file, this.images.get(join(place.dir, cand.file)) ?? null]));
    return slotsOf(round, byFile, ended);
  }

  /** 收尾：停计时、按最后一次账本定结局；一张都没出来且原来没有地表，插件稿标「待出图」 */
  private async end(key: string, reason: string, cancelled = false): Promise<void> {
    const live = this.live.get(key);
    if (live === undefined || !isAvatarJobLive(live.job)) return;
    if (live.timer !== null) clearInterval(live.timer);
    if (live.deadline !== null) clearTimeout(live.deadline);
    live.timer = null;
    live.deadline = null;
    const next = await this.snapshot(live, reason, cancelled);
    const final: AvatarJob = { ...next, state: isAvatarJobLive(next) ? "pending" : next.state, finishedAt: next.finishedAt ?? this.deps.now() };
    live.job = final;
    if (final.state === "pending" && final.round !== null && live.place.surface === null && live.place.design !== null) {
      const root = await this.deps.pluginRoot();
      if (root !== null) await this.deps.runScript(root, ["select", "--dir", live.place.dir, "--pending", "--design", live.place.design]);
    }
    // 超时 / 取消 / 每一位都出完时会话可能还在跑：停掉，别让它在用户挑完之后又交一张（已停的会话 abort 是空操作）
    if (final.sessionId !== null) await Promise.resolve(this.deps.abort(final.sessionId)).catch(() => undefined);
    this.deps.emit(final);
  }

  private emptyJob(ref: AvatarBodyRef): AvatarJob {
    const now = this.deps.now();
    return { workspaceId: ref.workspaceId, bodyId: ref.bodyId, state: "selected", round: null, slots: [], notes: [], policy: null, model: null, sessionId: null, selected: null, error: null, startedAt: now, finishedAt: now };
  }

  /** 应用退出：停掉所有计时（会话由 agent 进程一起收） */
  dispose(): void {
    for (const live of this.live.values()) {
      if (live.timer !== null) clearInterval(live.timer);
      if (live.deadline !== null) clearTimeout(live.deadline);
    }
  }
}

/** 跑插件脚本最长多久（select 要重校验一张 1024 的图、出看板小图，实测一两秒） */
export const SCRIPT_TIMEOUT_MS = 60_000;

/** index.ts 的 runScript：python3 跑插件里的 render_surface.py，带超时；不抛 */
export function execPluginScript(root: string, args: readonly string[]): Promise<ScriptResult> {
  return new Promise((resolveResult) => {
    execFile("python3", [join(root, AVATAR_SCRIPT), ...args], { cwd: root, timeout: SCRIPT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolveResult({ code, stdout: String(stdout), stderr: error !== null && stderr === "" ? error.message : String(stderr) });
    });
  });
}

/** 插件脚本的输出 → 一句话（它打印 JSON，message 字段是人话） */
export function scriptMessage(out: ScriptResult): string {
  try {
    const parsed: unknown = JSON.parse(out.stdout);
    if (isRecord(parsed) && typeof parsed["message"] === "string") return parsed["message"];
  } catch {
    // 不是 JSON：原样截一段
  }
  return (out.stderr.trim() || out.stdout.trim() || `退出码 ${out.code}`).slice(0, 300);
}

