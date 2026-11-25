/**
 * 状态卡里「这个子会话挂在计划的哪一步」的推导（纯模块：不 import React，可被 node --test 直接加载）。
 * 规则与理由见 delegationSteps；从 chat-status.ts 拆出来，那边只留状态卡的其余推导。
 */
import type { TranscriptRecord } from "@shared/session";
import { PLAN_TOOL_NAME } from "../../../../shared/plan.ts";
import { parseDelegatePlanStep } from "../../../../shared/channel.ts";
import { dice } from "../../../../shared/plan-diff.ts";
import { planHistory, type PlanStep, type PlanTimeline, type PlanVersion } from "./plan-timeline.ts";

const DELEGATE_TOOL_NAME = "delegate";

/** 一步在某张计划里的位置：第几张计划（planHistory 里 n 重新从 1 数起算一张新的）+ 那张里的步 id + 当时的文字 */
interface StepRef {
  plan: number;
  id: string;
  text: string;
  waitingFor: string | null;
}

/** 派出时还没定下挂哪一步的子会话：等「这一轮里的下一次 update_plan」 */
interface PendingChild {
  childId: string;
  title: string;
  /** 模型显式给的 planStep（delegate 的可选参数）；派出时对不上当时的计划，留到下一版再试 */
  explicit: string | null;
  /** 派出时的候选：那一刻在做的步，加上同一轮里刚写的计划里新变成在做 / 在等的步（先改计划、后派人：交出去的步已经标了 waiting） */
  active: StepRef[];
}

interface Inferred {
  explicit: StepRef | null;
  /** 显式参数的文字（对不上任何一版计划时，收口再对当前计划） */
  explicitText: string | null;
  inferred: StepRef | null;
}

/**
 * 子会话 → 计划步骤 id。**挂靠规则按优先级**（用户 2026-11-23：「子会话几乎不会被和某个 todo 挂钩，即使他们是有关系的」；
 * 原来只看「派出那一刻在做的那一步」，而模型常先派后改计划、把交给子会话的步标成 waiting、一张新计划又让旧步 id 全作废）：
 *
 * 1. 显式：delegate 的 planStep 参数（计划里那一步的文字）。先对派出时最近一版计划，对不上再对这一轮里的下一版，最后对当前计划；
 *    文字对不上（模型写歪了）按相似度兜，仍对不上才往下走；
 * 2. 计划条目的文字或 waitingFor 里写了子会话 id 的前缀（8 位及以上，「子会话 22bcc8ca 在做」）。从最新一版往旧版找，
 *    同一版里几步都提到它，取第一个没做完的；
 * 3. 推断：派出那一刻在做（in_progress）的步，加上**这一轮里下一次 update_plan 新变成**在做 / 在等的步（覆盖「先派人、后改计划」，
 *    也覆盖交出去的步被标 waiting）。候选不止一个时看标题与步骤文字像不像（字符二元组 Dice），像的优先；都不像按候选顺序，
 *    并尽量不让两个子会话挂同一步。「这一轮」到下一条用户消息 / 通道标记为止；
 * 4. 都没有 = null（归「其他子会话」）。
 *
 * **换计划**：规则 1–3 先在派出时那张计划里落到一步；这张计划被新计划顶掉（planHistory 里一张新计划，步 id 作废）时，
 * 新计划里有**文字相同**的步（用它在原计划里最后的说法再试一次）就按文字接过去，没有才算没挂上。返回的 id 是 timeline.current 里的步 id。
 *
 * 仍会错的情况：模型既不带 planStep、也不写子会话 id，又不标 waiting，派出时在做的步与子会话无关
 * （推断会挂到那一步，只有候选里有更像的才纠正）；一步做完没打勾就派下一步的人——挂到上一步。
 */
export function delegationSteps(records: readonly TranscriptRecord[], timeline: PlanTimeline | null): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const history = planHistory(records.filter(isPlanRecord));
  const versions = history?.versions ?? [];
  const versionByCall = new Map(versions.map((version) => [version.toolCallId, version]));
  // 第几张计划：版本号回到 1 = 一张新计划（步 id 与上一张无关）
  const planOf = new Map<PlanVersion, number>();
  let planNo = -1;
  for (const version of versions) {
    if (version.n === 1) planNo += 1;
    planOf.set(version, planNo);
  }
  const target = timeline?.current.items ?? history?.current.items ?? [];

  const refOf = (version: PlanVersion, item: PlanStep): StepRef => ({
    plan: planOf.get(version) ?? 0,
    id: item.id,
    text: item.text,
    waitingFor: item.waitingFor ?? null,
  });
  const knownIds = new Set<string>();
  for (const record of records) {
    if (record.role === "tool" && record.toolName === DELEGATE_TOOL_NAME) {
      const id = delegateChildId(record.details);
      if (id !== null) knownIds.add(id);
    }
  }
  /** 这一步的文字里点了别的子会话的名（没点我）：不是我的步 */
  const isOthers = (item: Pick<PlanStep, "text" | "waitingFor">, childId: string): boolean => {
    const mentioned = mentionedChildren(item, knownIds);
    return mentioned.size > 0 && !mentioned.has(childId);
  };

  // ── 走一遍转录：显式参数、派出时在做的步、同一轮里刚写的在等的步、下一版计划里新出现的在做 / 在等的步 ──
  const found = new Map<string, Inferred>();
  const taken = new Map<string, number>();
  const take = (ref: StepRef | null): StepRef | null => {
    if (ref !== null) taken.set(`${ref.plan}:${ref.id}`, (taken.get(`${ref.plan}:${ref.id}`) ?? 0) + 1);
    return ref;
  };
  let latest: PlanVersion | null = null;
  /** 同一轮里最近一版计划新变成在做 / 在等的步（先改计划、后派人时，交出去的步已经标好了） */
  let turnNew: PlanStep[] = [];
  let pending: PendingChild[] = [];
  const settle = (version: PlanVersion) => {
    const candidates = newlyActive(version, latest);
    for (const child of pending) {
      const entry = found.get(child.childId);
      if (entry === undefined) continue;
      if (child.explicit !== null) {
        const hit = matchStep(version.items, child.explicit);
        if (hit !== null) entry.explicit = refOf(version, hit);
      }
      if (entry.explicit === null) {
        // 派出时的候选在下一版里已不存在（改了说法对不上 / 被删）就不要了：下一版的新步才是它的去处
        const stillThere = (ref: StepRef): boolean => version.items.some((item) => (planOf.get(version) === ref.plan && item.id === ref.id) || item.text === ref.text);
        const pool = [...child.active.filter(stillThere), ...candidates.filter((item) => !isOthers(item, child.childId)).map((item) => refOf(version, item))];
        entry.inferred = take(pickByTitle(pool, child.title, taken));
      }
    }
    pending = [];
  };
  // 这一轮到头也没等来下一版计划：推断只剩派出时的候选
  const flush = () => {
    for (const child of pending) {
      const entry = found.get(child.childId);
      if (entry !== undefined && entry.explicit === null) entry.inferred = take(pickByTitle(child.active, child.title, taken));
    }
    pending = [];
    turnNew = [];
  };
  for (const record of records) {
    if (record.role === "user" || record.role === "channel-mark") {
      flush();
      continue;
    }
    if (record.role !== "tool") continue;
    if (record.toolName === PLAN_TOOL_NAME) {
      const version = versionByCall.get(record.toolCallId);
      if (version === undefined) continue;
      if (pending.length > 0) settle(version);
      turnNew = newlyActive(version, latest);
      latest = version;
      continue;
    }
    if (record.toolName !== DELEGATE_TOOL_NAME) continue;
    const childId = delegateChildId(record.details);
    if (childId === null) continue;
    const title = (record.input as { title?: unknown } | null)?.title;
    const explicit = parseDelegatePlanStep(record.input);
    const entry: Inferred = { explicit: null, explicitText: explicit, inferred: null };
    found.set(childId, entry);
    if (explicit !== null && latest !== null) {
      const hit = matchStep(latest.items, explicit);
      if (hit !== null) {
        entry.explicit = refOf(latest, hit);
        continue; // 显式已落到一步，不必再等下一版
      }
    }
    const inProgress = latest?.items.find((item) => item.status === "in_progress");
    const active =
      latest === null
        ? []
        : [...(inProgress === undefined ? [] : [inProgress]), ...turnNew.filter((item) => item !== inProgress && !isOthers(item, childId))].map((item) => refOf(latest as PlanVersion, item));
    pending.push({ childId, title: typeof title === "string" ? title : "", explicit, active });
  }
  flush();

  // ── 收口：显式 > id 前缀 > 推断，再换成当前计划里的步 id ──
  const finalTextOf = (ref: StepRef): string => {
    for (let index = versions.length - 1; index >= 0; index -= 1) {
      const version = versions[index];
      if (version === undefined || planOf.get(version) !== ref.plan) continue;
      const item = version.items.find((candidate) => candidate.id === ref.id);
      if (item !== undefined) return item.text;
    }
    return ref.text;
  };
  const toTarget = (ref: StepRef | null): string | null => {
    if (ref === null) return null;
    for (const text of new Set([finalTextOf(ref), ref.text])) {
      const hit = target.find((item) => item.text === text);
      if (hit !== undefined) return hit.id;
    }
    return null;
  };
  const prefixRef = (childId: string): StepRef | null => {
    for (let index = versions.length - 1; index >= 0; index -= 1) {
      const version = versions[index];
      if (version === undefined) continue;
      const hits = version.items.filter((item) => mentionedChildren(item, new Set([childId])).size > 0);
      const hit = hits.find((item) => item.status !== "done") ?? hits[0];
      if (hit !== undefined) return refOf(version, hit);
    }
    return null;
  };
  for (const [childId, entry] of found) {
    let step = toTarget(entry.explicit);
    if (step === null && entry.explicitText !== null) step = matchStep(target, entry.explicitText)?.id ?? null;
    if (step === null) step = toTarget(prefixRef(childId));
    if (step === null) step = toTarget(entry.inferred);
    out.set(childId, step);
  }
  return out;
}

function isPlanRecord(record: TranscriptRecord): boolean {
  return record.role === "tool" && record.toolName === PLAN_TOOL_NAME;
}

/** 这一版里**新变成**在做 / 在等的步：上一版里没有它、或它当时不是这个状态；新一张计划（n === 1）里在做 / 在等的全算新的 */
function newlyActive(version: PlanVersion, previous: PlanVersion | null): PlanStep[] {
  const fresh = previous === null || version.n === 1;
  const isNew = (item: PlanStep): boolean => {
    if (fresh) return true;
    const before = previous?.items.find((candidate) => candidate.id === item.id);
    return before === undefined || before.status !== item.status;
  };
  const active = version.items.filter((item) => (item.status === "in_progress" || item.status === "waiting") && isNew(item));
  // 同一版里交出去的步通常标 waiting，主会话自己接着做的是 in_progress：非新计划里先排 waiting；新计划里在做的排前
  const rank = (item: PlanStep): number => (item.status === "in_progress" ? (fresh ? 0 : 1) : fresh ? 1 : 0);
  return [...active].sort((a, b) => rank(a) - rank(b));
}

/** 一步的文字 / waitingFor 里提到了哪些子会话（id 的前 8 位及以上；只在 ids 里找） */
function mentionedChildren(item: Pick<PlanStep, "text" | "waitingFor">, ids: ReadonlySet<string>): Set<string> {
  const found = new Set<string>();
  const haystack = `${item.text} ${item.waitingFor ?? ""}`;
  for (const match of haystack.matchAll(/[0-9a-f]{8,}/gi)) {
    const token = match[0].toLowerCase();
    for (const id of ids) if (id.toLowerCase().startsWith(token)) found.add(id);
  }
  return found;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** planStep 的文字对计划里的哪一步：逐字相同 > 去标点空白后相同 > 互相包含（≥ 4 字）> 相似度 ≥ 0.6；对不上 = null */
export function matchStep<T extends Pick<PlanStep, "text">>(items: readonly T[], text: string): T | null {
  const exact = items.find((item) => item.text === text);
  if (exact !== undefined) return exact;
  const want = normalizeText(text);
  if (want === "") return null;
  const same = items.find((item) => normalizeText(item.text) === want);
  if (same !== undefined) return same;
  const contained = items.find((item) => {
    const have = normalizeText(item.text);
    return Math.min(have.length, want.length) >= 4 && (have.includes(want) || want.includes(have));
  });
  if (contained !== undefined) return contained;
  let best: T | null = null;
  let bestScore = 0;
  for (const item of items) {
    const score = dice(item.text, text);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return bestScore >= 0.6 ? best : null;
}

/** 候选里挑与子会话标题最像的（Dice 大者优先；同分先挑还没被别的子会话占的，再按候选顺序） */
function pickByTitle(pool: readonly StepRef[], title: string, taken: ReadonlyMap<string, number>): StepRef | null {
  let best: StepRef | null = null;
  let bestScore = 0;
  let bestTaken = 0;
  for (const ref of pool) {
    const score = title === "" ? 0 : dice(title, `${ref.text} ${ref.waitingFor ?? ""}`);
    const used = taken.get(`${ref.plan}:${ref.id}`) ?? 0;
    if (best === null || score > bestScore + 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && used < bestTaken)) {
      best = ref;
      bestScore = score;
      bestTaken = used;
    }
  }
  return best;
}

function delegateChildId(details: unknown): string | null {
  if (typeof details !== "object" || details === null) return null;
  const raw = (details as Record<string, unknown>)["delegate"];
  if (typeof raw !== "object" || raw === null) return null;
  const id = (raw as Record<string, unknown>)["childId"];
  return typeof id === "string" && id !== "" ? id : null;
}
