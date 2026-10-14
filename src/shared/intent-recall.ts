/**
 * 意图系统（Tier B）的共享纯核 —— intent-lab /recall 的对接层。
 *
 * 契约真源是审核会话持有的 tier-b-contract.ts（v1）；本文件是它在我们 IPC 四层里的
 * 第 1 层投影：事件形状、NDJSON 分块解析、卡片状态机、60 秒静默判定、recent /
 * backfill 的推导。runtime（发送侧）、主进程（装配与落盘）、renderer（卡片）三边
 * 都只认这一份，不各写第二套。
 *
 * 纯模块：不 import electron、不 import pi，可被 `node --test` 直接加载。
 */
import type { SessionRecord } from "./session.ts";

/** 门卫判定（契约 v3）：只看原话的轻量调用，needIntent=false 时整轮跳过。 */
export interface IntentGateEvent {
  needIntent: boolean;
  why: string;
  forced: boolean;
}

/** S4 全局审核选中的一条旧 QA（展示用视图；契约 SelectedView）。 */
export interface IntentSelectedView {
  qaId: string;
  /** 人看的时间（GMT+8「MM-DD HH:mm」，intent-lab 已格式化好） */
  when: string;
  /** 该 QA 所在会话标题 */
  title: string;
  /** 岗名 */
  slots: string[];
  why: string;
  /** 在确认卡里、用户还没表态 */
  pending: boolean;
  /* ---------- v3.2（块 4）：守门员摘句。旧服务端没有这些字段——可选，显示侧退回 why ---------- */
  /** 该岗分数（0–1，一位小数） */
  score?: number;
  /** 用户原话里逐字摘的一段；摘不到时为原话全文 */
  human?: string;
  /** 动手回答里逐字补的一段；不需要时为空串 */
  assistant?: string;
  connection?: string;
  prediction?: string;
  /** 去重合并的份数，≥ 1 */
  dupCount?: number;
  /* ---------- 契约 7：进行中的图先用 review 画。旧服务端没有——缺席 */
  /** 该 QA 的发生时刻（epoch ms）；右栏图按它排时间轴 */
  ts?: number;
  /** 该 QA 所在会话 id（跨会话连线用） */
  sessionId?: string;
  /** 来源标签（Orbita / Claude Code / Codex …） */
  source?: string;
}

/** S4 要问用户的一条确认项（契约 AskView）。确认卡 UI 是下一批；本批只计数与展示。 */
export interface IntentAskView {
  askId: string;
  qaId: string;
  slot: string;
  statement: string;
  quote: string;
  when: string;
  title: string;
  whyUncertain: string;
}

/** recall 一次的时长账（done 事件随行）。全毫秒。 */
export interface IntentRecallTiming {
  totalMs: number;
  /** 门卫那一步的耗时（v3）；v2 服务端没有——解析时补 0 */
  gateMs: number;
  s1Ms: number;
  s3Ms: number;
  s4Ms: number;
}

/** intent-lab /recall NDJSON 流里的一行（契约 RecallEvent；heartbeat 也透传，reducer 忽略）。 */
export type IntentRecallStreamEvent =
  | {
      type: "accepted";
      runId: string;
      qaTotal: number;
      swarm: { endpoint: string; model: string };
      budgetMs: number;
      peak: boolean;
      startedAt: number;
    }
  | { type: "stage"; stage: "gate" | "s1" | "s3" | "s4"; status: "start" | "done"; round: 1 | 2; ms?: number }
  | { type: "gate"; needIntent: boolean; why: string; forced: boolean }
  | { type: "intent"; scene: string; want: string }
  | {
      type: "progress";
      /** v3.2 起 S3 两步；v3.4 起 S4 也有进度（done=已写条数，passed=已收字符数，无 step） */
      stage: "s3" | "s4";
      round: 1 | 2;
      /** v3.2：1 = 打分（全部 QA），2 = 写理由（只有过线的）。旧服务端没有——解析时补 1 */
      step: 1 | 2;
      done: number;
      total: number;
      passed: number;
      etaMs: number | null;
    }
  | { type: "retry"; missing: string }
  | {
      type: "review";
      summary: string;
      selected: IntentSelectedView[];
      ask: IntentAskView[];
      retried: boolean;
      missing: string;
      /** v3.2：待问队列里还没问到的条数（本轮之外）；旧服务端没有——解析补 0 */
      askRemaining: number;
      /** v3.3：去重前后的入选条数（before ≥ after；没合并时相等）。旧服务端没有 */
      dedup?: { before: number; after: number };
    }
  | { type: "heartbeat"; t: number }
  | {
      type: "done";
      runId: string;
      injection: string;
      needsFeedback: boolean;
      /** 门卫跳过时为 "gate"（injection 为空串）；正常走完不给 */
      skipped?: "gate";
      /** 门卫跳过时附上它的理由（与 gate 事件同一句） */
      gateWhy?: string;
      /** v3.2：上下文文件全文（门卫跳过时不给；旧服务端没有——客户端退回简版文件） */
      context?: IntentContextFile;
      /** v3.3：本次 done 回写的边数（契约 §六）。门卫跳过 / 旧服务端不给 */
      edgesWritten?: number;
      /** 契约 7：DeepSeek / Proma 管线的 token 用量（花的是用户自己的钱，记 7 天账）；
       *  三项都是合法数才带 */
      usage?: IntentUsageCount;
      timing: IntentRecallTiming;
    }
  | {
      type: "error";
      stage: "gate" | "s1" | "s3" | "s4" | "config" | "budget";
      message: string;
      retryable: boolean;
      elapsedMs: number;
    };

/**
 * 一行 NDJSON → 流事件。**逐字段校验，认不出返回 null**（调用方跳过该行）：
 * intent-lab 是本地另一个进程，版本错位时吐出半新半旧的行不该把整轮对话打断。
 */
export function parseIntentRecallEvent(line: string): IntentRecallStreamEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const str = (key: string): string | null => (typeof value[key] === "string" ? (value[key] as string) : null);
  const num = (key: string): number | null =>
    typeof value[key] === "number" && Number.isFinite(value[key] as number) ? (value[key] as number) : null;
  const type = str("type");
  if (type === "heartbeat") {
    return { type: "heartbeat", t: num("t") ?? 0 };
  }
  if (type === "accepted") {
    const swarm = value["swarm"];
    if (typeof swarm !== "object" || swarm === null) return null;
    const s = swarm as Record<string, unknown>;
    return {
      type: "accepted",
      runId: str("runId") ?? "",
      qaTotal: num("qaTotal") ?? 0,
      swarm: { endpoint: typeof s.endpoint === "string" ? s.endpoint : "", model: typeof s.model === "string" ? s.model : "" },
      budgetMs: num("budgetMs") ?? 0,
      peak: value["peak"] === true,
      startedAt: num("startedAt") ?? 0,
    };
  }
  if (type === "stage") {
    const stage = str("stage");
    const status = str("status");
    const round = num("round");
    if (stage !== "gate" && stage !== "s1" && stage !== "s3" && stage !== "s4") return null;
    if (status !== "start" && status !== "done") return null;
    if (round !== 1 && round !== 2) return null;
    const ms = num("ms");
    return { type: "stage", stage, status, round, ...(ms === null ? {} : { ms }) };
  }
  if (type === "intent") {
    const scene = str("scene");
    if (scene === null) return null;
    // want 是 v3 字段；v2 服务端没有 → 空串（卡片对空串省略显示）
    return { type: "intent", scene, want: str("want") ?? "" };
  }
  if (type === "gate") {
    const why = str("why");
    if (why === null) return null;
    return { type: "gate", needIntent: value["needIntent"] !== false, why, forced: value["forced"] === true };
  }
  if (type === "progress") {
    const stage = str("stage");
    const round = num("round");
    const stepRaw = num("step");
    const done = num("done");
    const total = num("total");
    const passed = num("passed");
    const etaMs = num("etaMs");
    if ((stage !== "s3" && stage !== "s4") || (round !== 1 && round !== 2)) return null;
    if (done === null || total === null || passed === null) return null;
    // v3.2 的 step：旧服务端（contract ≤ 3.3）没有——按 step 1（打分）处理（s4 不用 step）
    const step = stepRaw === 2 ? 2 : 1;
    return { type: "progress", stage, round, step, done, total, passed, etaMs: etaMs === null ? null : etaMs };
  }
  if (type === "retry") {
    const missing = str("missing");
    return missing === null ? null : { type: "retry", missing };
  }
  if (type === "review") {
    const summary = str("summary");
    if (summary === null) return null;
    return {
      type: "review",
      summary,
      selected: parseSelectedList(value["selected"]),
      ask: parseAskList(value["ask"]),
      retried: value["retried"] === true,
      // v3.1：S4 没找到的缺失条件（missing）——卡片显示「没找到：<missing>」用
      missing: typeof value["missing"] === "string" ? value["missing"] : "",
      // v3.2：待问队列剩余（旧服务端补 0）
      askRemaining: num("askRemaining") ?? 0,
      // v3.3：去重前后条数（两个字段都合法才带）
      ...(typeof value["dedup"] === "object" && value["dedup"] !== null
        ? (() => {
            const d = value["dedup"] as Record<string, unknown>;
            return typeof d["before"] === "number" && Number.isFinite(d["before"]) &&
              typeof d["after"] === "number" && Number.isFinite(d["after"])
              ? { dedup: { before: d["before"] as number, after: d["after"] as number } }
              : {};
          })()
        : {}),
    };
  }
  if (type === "done") {
    const runId = str("runId");
    const injection = str("injection");
    const timing = value["timing"];
    if (runId === null || injection === null || typeof timing !== "object" || timing === null) return null;
    const t = timing as Record<string, unknown>;
    const totalMs = t["totalMs"];
    const s1Ms = t["s1Ms"];
    const s3Ms = t["s3Ms"];
    const s4Ms = t["s4Ms"];
    if (
      typeof totalMs !== "number" || !Number.isFinite(totalMs) ||
      typeof s1Ms !== "number" || !Number.isFinite(s1Ms) ||
      typeof s3Ms !== "number" || !Number.isFinite(s3Ms) ||
      typeof s4Ms !== "number" || !Number.isFinite(s4Ms)
    ) {
      return null;
    }
    const skipped = str("skipped");
    const gateWhy = str("gateWhy");
    const gateMs = t["gateMs"];
    // v3.2：上下文文件（question/md/jsonl/added/notice 全合法才带；旧服务端没有）
    const rawContext = value["context"];
    const context =
      typeof rawContext === "object" && rawContext !== null
        ? (() => {
            const c = rawContext as Record<string, unknown>;
            const question = c["question"];
            const md = c["md"];
            const jsonl = c["jsonl"];
            const added = c["added"];
            const notice = c["notice"];
            if (
              typeof question !== "number" || !Number.isFinite(question) ||
              typeof md !== "string" || typeof jsonl !== "string" ||
              typeof added !== "number" || !Number.isFinite(added) ||
              typeof notice !== "string"
            ) {
              return undefined;
            }
            return { question, md, jsonl, added, notice } satisfies IntentContextFile;
          })()
        : undefined;
    const edgesWritten = num("edgesWritten");
    // 契约 7：token 用量（三项都是合法有限数才带；缺席 = 服务端没报，不猜）
    const rawUsage = value["usage"];
    const usage =
      typeof rawUsage === "object" && rawUsage !== null
        ? (() => {
            const u = rawUsage as Record<string, unknown>;
            const promptTokens = u["promptTokens"];
            const completionTokens = u["completionTokens"];
            const cachedTokens = u["cachedTokens"];
            return typeof promptTokens === "number" && Number.isFinite(promptTokens) &&
              typeof completionTokens === "number" && Number.isFinite(completionTokens) &&
              typeof cachedTokens === "number" && Number.isFinite(cachedTokens)
              ? { promptTokens, completionTokens, cachedTokens } satisfies IntentUsageCount
              : undefined;
          })()
        : undefined;
    return {
      type: "done",
      runId,
      injection,
      needsFeedback: value["needsFeedback"] === true,
      ...(skipped === "gate" ? { skipped: "gate" as const } : {}),
      ...(gateWhy !== null ? { gateWhy } : {}),
      ...(context === undefined ? {} : { context }),
      ...(edgesWritten === null ? {} : { edgesWritten }),
      ...(usage === undefined ? {} : { usage }),
      // v2 服务端没有 gateMs——补 0（卡片与记录的字段恒在，消费侧不用分版本）
      timing: {
        totalMs,
        gateMs: typeof gateMs === "number" && Number.isFinite(gateMs) ? gateMs : 0,
        s1Ms,
        s3Ms,
        s4Ms,
      },
    };
  }
  if (type === "error") {
    const stage = str("stage");
    const message = str("message");
    if (message === null) return null;
    if (stage !== "gate" && stage !== "s1" && stage !== "s3" && stage !== "s4" && stage !== "config" && stage !== "budget") return null;
    return { type: "error", stage, message, retryable: value["retryable"] === true, elapsedMs: num("elapsedMs") ?? 0 };
  }
  return null;
}

function parseSelectedList(raw: unknown): IntentSelectedView[] {
  if (!Array.isArray(raw)) return [];
  const out: IntentSelectedView[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const v = item as Record<string, unknown>;
    if (
      typeof v["qaId"] !== "string" ||
      typeof v["when"] !== "string" ||
      typeof v["title"] !== "string" ||
      !Array.isArray(v["slots"]) ||
      typeof v["why"] !== "string"
    ) {
      continue;
    }
    const strOpt = (key: string): string | undefined => (typeof v[key] === "string" ? (v[key] as string) : undefined);
    const numOpt = (key: string): number | undefined =>
      typeof v[key] === "number" && Number.isFinite(v[key] as number) ? (v[key] as number) : undefined;
    out.push({
      qaId: v["qaId"],
      when: v["when"],
      title: v["title"],
      slots: v["slots"].filter((slot): slot is string => typeof slot === "string"),
      why: v["why"],
      pending: v["pending"] === true,
      // v3.2（守门员摘句）：旧服务端没有——缺席
      ...(strOpt("human") === undefined ? {} : { human: strOpt("human") }),
      ...(strOpt("assistant") === undefined ? {} : { assistant: strOpt("assistant") }),
      ...(strOpt("connection") === undefined ? {} : { connection: strOpt("connection") }),
      ...(strOpt("prediction") === undefined ? {} : { prediction: strOpt("prediction") }),
      ...(numOpt("score") === undefined ? {} : { score: numOpt("score") }),
      ...(numOpt("dupCount") === undefined ? {} : { dupCount: numOpt("dupCount") }),
      // 契约 7：图的时间轴 / 会话连线用；旧服务端没有——缺席
      ...(numOpt("ts") === undefined ? {} : { ts: numOpt("ts") }),
      ...(strOpt("sessionId") === undefined ? {} : { sessionId: strOpt("sessionId") }),
      ...(strOpt("source") === undefined ? {} : { source: strOpt("source") }),
    });
  }
  return out;
}

function parseAskList(raw: unknown): IntentAskView[] {
  if (!Array.isArray(raw)) return [];
  const out: IntentAskView[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const v = item as Record<string, unknown>;
    if (
      typeof v["askId"] !== "string" ||
      typeof v["qaId"] !== "string" ||
      typeof v["slot"] !== "string" ||
      typeof v["statement"] !== "string" ||
      typeof v["quote"] !== "string" ||
      typeof v["when"] !== "string" ||
      typeof v["title"] !== "string" ||
      typeof v["whyUncertain"] !== "string"
    ) {
      continue;
    }
    out.push({
      askId: v["askId"],
      qaId: v["qaId"],
      slot: v["slot"],
      statement: v["statement"],
      quote: v["quote"],
      when: v["when"],
      title: v["title"],
      whyUncertain: v["whyUncertain"],
    });
  }
  return out;
}

/**
 * NDJSON 分块装配器：网络 chunk 的边界与行边界无关，一个事件可能劈在两个 chunk 里。
 * 返回一个喂 chunk 的函数；完整行回调 onLine，残段留在内部缓冲。
 */
export function createNdjsonAssembler(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.trim() !== "") onLine(line);
      newline = buffer.indexOf("\n");
    }
  };
}

/**
 * 发给回答模型的整段正文：注入块 + 空行 + 用户原话（契约原文）。
 * 两本账对齐的关键：Orbita 转录里存的是 `text`（原话），pi 本子里存的是这里
 * 的返回值——branch-cut 按 role 按位对账，不比文本，两份各存各的形态是成立的。
 *
 * **空注入直通原话**（线一 2026-09-25 改为「选中 0 条 → injection 为空串」）：
 * 空串再拼会发出 "\n\n原话"——多两个换行还把回声对账的键带脏。调用方据此
 * 分流（runTierBTurn）：普通路径 prompt(原话)、echoed 记原话；重试路径用
 * INTENT_EMPTY_INJECTION 那句话经 sendCustomMessage 触发一轮。
 */
export function composeIntentPrompt(injection: string, text: string): string {
  if (injection === "") return text;
  return `${injection}\n\n${text}`;
}

/**
 * 客户端自产错误的机器码（agent 侧产生、renderer 侧翻译成界面语言文案）：
 * intentRecall error 事件的 message 以这些开头时按对应文案显示，否则原样显示。
 */
export const INTENT_LAB_UNREACHABLE = "INTENT_LAB_UNREACHABLE";
export const INTENT_LAB_SILENT = "INTENT_LAB_SILENT";
export const INTENT_LAB_STREAM_ENDED = "INTENT_LAB_STREAM_ENDED";
/** /feedback 提交失败的机器码前缀（detail 附在括号里）——第二批确认卡用 */
export const INTENT_FEEDBACK_FAILED = "INTENT_FEEDBACK_FAILED";

/** 契约 7：done 事件的 token 用量（DeepSeek / Proma 管线，花的是用户自己的钱）。 */
export interface IntentUsageCount {
  promptTokens: number;
  completionTokens: number;
  /** prompt 里命中缓存的部分（已含在 promptTokens 内） */
  cachedTokens: number;
}

/** 用量 → 日账本的 UsageCounts 口径：input = 未命中的 prompt，cacheRead = 命中部分，
 *  output = completion。四项相加 = prompt + completion，与「总 token」语义一致。 */
export function usageCountsOfIntent(usage: IntentUsageCount): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} {
  return {
    input: Math.max(0, usage.promptTokens - usage.cachedTokens),
    output: usage.completionTokens,
    cacheRead: Math.max(0, usage.cachedTokens),
    cacheWrite: 0,
  };
}

/** 60 秒收不到任何一行（含 heartbeat）即判死。调度器可注入（测试用假时钟）。 */
export interface SilenceTimer {
  /** 收到一行就调用：重置计时。 */
  activity(): void;
  dispose(): void;
}

export interface SilenceScheduler {
  schedule(callback: () => void, ms: number): { cancel(): void };
}

export const systemSilenceScheduler: SilenceScheduler = {
  schedule: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    return { cancel: () => clearTimeout(handle) };
  },
};

export function createSilenceTimer(timeoutMs: number, onSilent: () => void, scheduler: SilenceScheduler = systemSilenceScheduler): SilenceTimer {
  let pending: { cancel(): void } | null = null;
  const arm = (): void => {
    pending?.cancel();
    pending = scheduler.schedule(onSilent, timeoutMs);
  };
  arm();
  return {
    activity: arm,
    dispose: () => {
      pending?.cancel();
      pending = null;
    },
  };
}

/** user 记录首个 text 块的文本；没有（纯图片消息）返回 null。 */
function userRecordText(record: Extract<SessionRecord, { role: "user" }>): string | null {
  const block = record.content.find((b) => b.type === "text");
  if (block === undefined || block.type !== "text") return null;
  return block.text;
}

/** assistant 终态记录的最后一个 text 块（trim 后）。 */
function assistantLastBlock(record: Extract<SessionRecord, { role: "assistant" }>): string | null {
  let last: string | null = null;
  for (const block of record.content) {
    if (block.type === "text" && block.text.trim() !== "") last = block.text.trim();
  }
  return last;
}

/**
 * 转录 → pi 本子还没消化的 user 原话（旧→新）。
 *
 * 事实前提（两本账对齐的核心）：Orbita 转录里「最后一条 assistant 之后」的 user
 * 消息一定没有进 pi 本子——pi 的 user 条目只随 prompt() 落盘，而 Tier B 下
 * recall 失败 / 取消就不调 prompt；abort 的半截 assistant 两边都落、空 error
 * assistant 两边都不落，所以「最后 assistant」在两本账里是对齐的。
 * 开轮时把这份尾巴逐条 `SessionManager.appendMessage` 补记进 pi 本子，两本账
 * 重新一条对一条（细节与被否决的「失败时立即补记」写在该次 commit message）。
 *
 * 文本用**原样文本**（含引用块）：pi 本子里其它轮的 user 也是组合文本，形态一致；
 * 回声对账不经过这条路径（appendMessage 不触发 message_start）。
 */
export function pendingBackfillFromRecords(records: readonly SessionRecord[]): string[] {
  let lastAssistantIndex = -1;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record !== undefined && record.role === "assistant" && record.status !== "streaming") {
      lastAssistantIndex = i;
      break;
    }
  }
  const out: string[] = [];
  for (let i = lastAssistantIndex + 1; i < records.length; i++) {
    const record = records[i];
    if (record === undefined || record.role !== "user") continue;
    const text = userRecordText(record);
    if (text === null || text.trim() === "") continue;
    out.push(text);
  }
  return out;
}

/**
 * 回答存档（/ingest）的 `a`：本轮最后一条 assistant 的「最后一段文字」。
 * 与 ingestAnswerText 的推导同一个口径（assistantLastBlock）。
 */
export function ingestAnswerText(records: readonly SessionRecord[]): string | null {
  let last: string | null = null;
  for (const record of records) {
    if (record.role !== "assistant" || record.status === "streaming") continue;
    const text = assistantLastBlock(record);
    if (text !== null) last = text;
  }
  return last;
}

/** 卡片四步里一步的相位。 */
export type RecallStepState = "idle" | "running" | "done";

/** 流水线卡片的显示状态（运行中由事件流归约；终态可铸成 IntentRecallRecord）。 */
export interface RecallCardState {
  /** 对账键：本轮回显 user item 的 id。同一 turnId 重跑 recall 只留最后一张卡。 */
  turnId: string;
  status: "running" | "done" | "error" | "cancelled";
  scene: string | null;
  /** S1 的 want（v3；v2 为空串） */
  want: string;
  /** 门卫判定（v3；null = 还没到 / v2 服务端） */
  gate: IntentGateEvent | null;
  /** 门卫跳过（done.skipped = "gate"）：终态卡的收起行与产出文件吃它 */
  skipped: "gate" | null;
  gateWhy: string | null;
  steps: { gate: RecallStepState; s1: RecallStepState; s3: RecallStepState; s4: RecallStepState };
  /** 当前 S3 轮（1 = 首面，2 = 判缺重跑） */
  round: 1 | 2;
  /** S4 判缺后带补充指令重跑过 S3（v3.1 起不再重跑；旧流兼容保留字段） */
  s3Retried: boolean;
  /** S4 没找到的缺失条件（v3.1 的 review.missing）——卡片显示「没找到」用 */
  s4Missing: string;
  progress: { step: 1 | 2; done: number; total: number; passed: number; etaMs: number | null } | null;
  /** v3.3 阶段条拆细：S3 两步各自的进度账（终条冻结；含该步的起止时刻——终态卡算每步用时） */
  s3Steps: {
    step1: { done: number; total: number; passed: number; firstAt: number; lastAt: number } | null;
    step2: { done: number; total: number; passed: number; firstAt: number; lastAt: number } | null;
  };
  /** v3.4：S4 摘句进度（stage s4 的 progress；done=已写条数、chars=已收字符数）；没到 S4 为 null */
  s4Progress: { done: number; total: number; chars: number } | null;
  /** v3.3：review 的去重前后条数；没到 review 为 null */
  dedup: { before: number; after: number } | null;
  /** v3.3：done.edgesWritten；没到 done 为 null */
  edgesWritten: number | null;
  /** v3.2/v3.3：done.context.added（写上下文的条数）；没给为 null */
  contextAdded: number | null;
  /** 各阶段的用时（stage 事件的 ms；门卫来自 done.timing.gateMs）——终态卡逐格附注用 */
  stageMs: { gate: number | null; s1: number | null; s3: number | null; s4: number | null };
  accepted: { qaTotal: number; budgetMs: number; peak: boolean; model: string } | null;
  review: { summary: string; selected: IntentSelectedView[]; ask: IntentAskView[]; retried: boolean; askRemaining: number } | null;
  timings: IntentRecallTiming | null;
  /** needsFeedback：本批直接用「全部不表态」版注入继续，卡片标待确认条数 */
  pendingAsks: number;
  error: { stage: string; message: string; retryable: boolean } | null;
  runId: string | null;
  startedAt: number;
}

export function initialRecallCard(turnId: string, startedAt: number): RecallCardState {
  return {
    turnId,
    status: "running",
    scene: null,
    want: "",
    gate: null,
    skipped: null,
    gateWhy: null,
    steps: { gate: "idle", s1: "idle", s3: "idle", s4: "idle" },
    round: 1,
    s3Retried: false,
    s4Missing: "",
    progress: null,
    s3Steps: { step1: null, step2: null },
    s4Progress: null,
    dedup: null,
    edgesWritten: null,
    contextAdded: null,
    stageMs: { gate: null, s1: null, s3: null, s4: null },
    accepted: null,
    review: null,
    timings: null,
    pendingAsks: 0,
    error: null,
    runId: null,
    startedAt,
  };
}

/** v3.2（契约 §四）：服务端维护的上下文文件全文——Orbita 原样覆盖写到会话工作台。 */
export interface IntentContextFile {
  /** 该会话第几问（从 1 起） */
  question: number;
  md: string;
  jsonl: string;
  /** 本问新增条数 */
  added: number;
  /** 给主模型的一句通知（附件方式的固定说明之后带上的那句） */
  notice: string;
}

/** v3.2（契约 §五）：附件方式的前置段——固定说明 + notice。发给模型的这一轮 = composeIntentPrompt(它, 原话）。
 *  2026-10-09 用户裁决改成硬要求（主模型没去读 上下文.md、直接自己去 grep）：
 *  - 有新增条目（added > 0）：先读指定行再决定要不要另外搜，回答建立在它之上；
 *  - 没有新增条目：明说这一问不用读。
 *  行号从 notice 里解析（intent-lab 的 context-file 生成「（在上下文.md 第 a–b 行）」；
 *  intent-lab 不改），解析不到就退回整文件路径。added 从服务端给的 context.added 直接取。 */
export function composeAttachmentPrompt(contextMdPath: string, notice: string, added: number): string {
  const where = /上下文\.md\s*第\s*(\d+)\s*[–\-]\s*(\d+)\s*行/.exec(notice);
  const head =
    added > 0
      ? `意图系统已为这一问从你的历史对话里取回了 ${added} 条相关内容，写在附件 意图系统/上下文.md ${
          where ? `第 ${where[1]}–${where[2]} 行` : ""
        }（路径：${contextMdPath}）。回答前先用 read 工具读这一段，再决定要不要另外搜索；回答要建立在这些条目之上，引用其中内容时注明出自意图系统。`
      : `意图系统为这一问做了分析，没有取回相关条目——这一问不用读 意图系统/上下文.md（${contextMdPath}）。`;
  return notice === "" ? head : `${head}\n${notice}`;
}

/**
 * 意图系统上下文附件的读法（2026-10-09，与 QUOTE_GUIDELINE 同款注入方式）：只在
 * 本轮开着意图系统且上下文走附件方式时讲（runtime 逐轮拼系统提示词），讲清这个文件
 * 是什么、为什么先读它再自己搜、以及别把它当成用户这轮说的话。固定英文——与
 * QUOTE_GUIDELINE 并列，同属给模型的常驻说明。
 */
export const INTENT_CONTEXT_GUIDELINE = [
  "<orbita-intent-context>",
  'The workspace may contain an attachment "意图系统/上下文.md" (the intent context file; its path is ' +
    "given in the user message when it matters): the intent system's digest of THIS user's own past " +
    "conversations — verbatim excerpts of what the user said and how each discussion resolved, each with " +
    "the reason it connects to the current question, grouped by question. It is more reliable than " +
    "searching files yourself: when a user message says the intent system retrieved entries for this " +
    "question, read the indicated lines of that file FIRST, before running any search of your own. " +
    "The file is background material about past conversations, not something the user said this turn — " +
    "never quote it as the user's current words.",
  "</orbita-intent-context>",
].join("\n");

/** 卡片 → 派生输入（运行卡实时用；终态 record 由 runtime 在落卡时调用并存 stages）。 */
export function stagesOfCard(card: RecallCardState, errorStage: string | null): RecallStageCell[] {
  return deriveRecallStages({
    status: card.status,
    gate: card.gate === null ? null : { needIntent: card.gate.needIntent, why: card.gate.why },
    steps: card.steps,
    s3Steps: card.s3Steps,
    s4Progress: card.s4Progress,
    review: card.review === null ? null : { selectedCount: card.review.selected.length, askCount: card.review.ask.length },
    dedup: card.dedup,
    pendingAsks: card.pendingAsks,
    contextAdded: card.contextAdded,
    edgesWritten: card.edgesWritten,
    stageMs: card.stageMs,
    errorStage,
  });
}

/* ================================================================ v3.3 阶段条（11 格）的纯派生 */
/**
 * 把卡片状态派生成 11 格阶段条（用户 01:54：「不是不清楚进行到哪步，而是拆分得
 * 不够细」）。纯函数——运行卡与终态卡共用；测试直接盖状态与数字。
 *
 * 每格：key（UI 查文案）+ 状态（pending 灰 / running 转圈 / done 勾 / error 红）
 * + 数字载荷（知道了才有）。error 停在哪格标哪格，其后保持灰。老服务端
 * （无 step / dedup / edgesWritten / context）格子照常走，数字缺省。
 */
export type RecallStageStatus = "pending" | "running" | "done" | "error";

export interface RecallStageCell {
  key:
    | "gate" | "understand" | "score" | "passline" | "reasons"
    | "dedup" | "keeper" | "confirm" | "context" | "answer" | "edges";
  status: RecallStageStatus;
  /** 该步的数字载荷（分母/计数），显示侧按 key 组文案；null = 不显示数字 */
  numbers: {
    /** 打分 / 写理由的 N/M */
    done?: number;
    total?: number;
    /** 过线 K（step 1 终条 passed） */
    passed?: number;
    /** 去重后条数；before-after > 0 时 merged 给出差值 */
    after?: number;
    merged?: number;
    /** 守门员选了几条 */
    selected?: number;
    /** v3.4：S4 进行中的「已写 N 条」与「M 字」 */
    s4done?: number;
    s4chars?: number;
    /** 确认问了几条；askNone = 不用问 */
    asked?: number;
    askNone?: boolean;
    /** 写上下文新增条数 */
    added?: number;
    /** 回写边数 */
    edges?: number;
    /** 门卫跳过的原因（gate 格用） */
    why?: string;
  } | null;
  /** 该步用时（终态卡展开后附注）：stage 事件的 ms；打分/写理由用 progress 时间差 */
  ms: number | null;
}

export interface RecallStagesInput {
  status: RecallCardState["status"];
  gate: { needIntent: boolean; why: string } | null;
  steps: RecallCardState["steps"];
  s3Steps: RecallCardState["s3Steps"];
  review: { selectedCount: number; askCount: number } | null;
  /** v3.4：S4 摘句进度（done=已写条数、chars=已收字符数）；没到为 null */
  s4Progress: { done: number; total: number; chars: number } | null;
  /** review 的去重前后条数（v3.3；没到 review / 旧服务端为 null） */
  dedup: { before: number; after: number } | null;
  pendingAsks: number;
  contextAdded: number | null;
  edgesWritten: number | null;
  stageMs: RecallCardState["stageMs"];
  /** error 事件 / 终态 record 的 error.stage（没有为 null） */
  errorStage: string | null;
}

/** error 的阶段 → 标红的格（S3 按当前在跑的步选打分或写理由格） */
function errorCellKey(input: RecallStagesInput): RecallStageCell["key"] | null {
  switch (input.errorStage) {
    case "gate":
    case "config":
      return "gate";
    case "s1":
      return "understand";
    case "s3":
      return input.s3Steps.step2 !== null ? "reasons" : "score";
    case "s4":
      return "keeper";
    case "budget":
      return input.s3Steps.step2 !== null ? "reasons" : "score";
    default:
      return null;
  }
}

export function deriveRecallStages(input: RecallStagesInput): RecallStageCell[] {
  const s3Done = input.steps.s3 === "done";
  const b1 = input.s3Steps.step1;
  const b2 = input.s3Steps.step2;
  const err = errorCellKey(input);
  const mark = (key: RecallStageCell["key"], status: RecallStageStatus): RecallStageStatus =>
    err === key && status !== "done" ? "error" : status;
  const cells: RecallStageCell[] = [
    {
      key: "gate",
      status: input.gate === null ? mark("gate", "pending") : "done",
      numbers: input.gate !== null && !input.gate.needIntent ? { why: input.gate.why } : input.gate !== null ? {} : null,
      ms: input.stageMs.gate,
    },
    { key: "understand", status: mark("understand", input.steps.s1 === "idle" ? "pending" : input.steps.s1), numbers: null, ms: input.stageMs.s1 },
    {
      // step 2 已开工 ⇒ 打分步必然收尾（终条不必等到 stage s3 done）
      key: "score",
      status: mark("score", input.steps.s3 === "idle" ? "pending" : s3Done || b2 !== null ? "done" : "running"),
      numbers: b1 !== null ? { done: b1.done, total: b1.total } : null,
      ms: b1 !== null ? b1.lastAt - b1.firstAt : null,
    },
    {
      key: "passline",
      status: mark("passline", b1 === null ? "pending" : s3Done || b2 !== null ? "done" : "running"),
      numbers: b1 !== null ? { passed: b1.passed } : null,
      ms: null,
    },
    {
      key: "reasons",
      status: mark(
        "reasons",
        b2 === null ? (s3Done ? "done" : "pending") : s3Done || b2.done >= b2.total ? "done" : "running",
      ),
      numbers: b2 !== null ? { done: b2.done, total: b2.total } : null,
      ms: b2 !== null ? b2.lastAt - b2.firstAt : null,
    },
    {
      key: "dedup",
      status: input.review === null ? "pending" : "done",
      numbers:
        input.review !== null && input.dedup !== null
          ? { after: input.dedup.after, ...(input.dedup.before > input.dedup.after ? { merged: input.dedup.before - input.dedup.after } : {}) }
          : null,
      ms: null,
    },
    {
      key: "keeper",
      status: mark("keeper", input.steps.s4 === "idle" ? "pending" : input.steps.s4),
      // v3.4：s4 期间显示「已写 N 条 · M 字」；review 到了（s4 done 前后）显示「选 N 条」
      numbers:
        input.steps.s4 === "done" || (input.review !== null && input.status !== "running")
          ? input.review !== null
            ? { selected: input.review.selectedCount }
            : null
          : input.s4Progress !== null
            ? { s4done: input.s4Progress.done, s4chars: input.s4Progress.chars }
            : null,
      ms: input.stageMs.s4,
    },
    {
      key: "confirm",
      status:
        input.review === null
          ? "pending"
          : input.review.askCount === 0
            ? "done"
            : input.status === "done"
              ? "done"
              : "running",
      numbers:
        input.review === null ? null : input.review.askCount === 0 ? { askNone: true } : { asked: input.review.askCount },
      ms: null,
    },
    {
      key: "context",
      status: input.contextAdded !== null ? "done" : input.status === "done" ? "done" : "pending",
      numbers: input.contextAdded !== null ? { added: input.contextAdded } : null,
      ms: null,
    },
    { key: "answer", status: input.status === "done" ? "done" : "pending", numbers: null, ms: null },
    {
      key: "edges",
      status: input.edgesWritten !== null ? "done" : input.status === "done" ? "done" : "pending",
      numbers: input.edgesWritten !== null ? { edges: input.edgesWritten } : null,
      ms: null,
    },
  ];
  return cells;
}

/* ================================================================ 运行卡（四胶囊版）的纯派生 */
/**
 * 运行卡的显示态（2026-10-14 重写：进度环 + 四胶囊「理解 / 打分 / 写理由 / 确认」
 * + 一行当前步细节）。11 格阶段条还在——终态卡展开后的明细用它；运行中是给人
 * 「到哪一步了」的一眼答案，不铺全部格子。
 */
export type RecallPillKey = "understand" | "score" | "reasons" | "confirm";

/** 细节行的载荷（文案在渲染层按 kind 组，数字在这里算好）。 */
export type RecallRunDetail =
  | { kind: "gate" }
  | { kind: "understand" }
  | { kind: "score"; done: number; total: number; passed: number }
  | { kind: "reasons"; done: number; total: number }
  | { kind: "keeper"; done: number; chars: number }
  /** 等确认：有几条拿不准 */
  | { kind: "confirm"; asked: number }
  /** S4 完了、review/done 还没到的间隙 */
  | { kind: "settling" };

export interface RecallRunView {
  /** 四胶囊各自的状态 */
  pills: Record<RecallPillKey, RecallStageStatus>;
  /** 当前在走的相位；null = 等确认或收尾间隙（没有胶囊在转） */
  current: RecallPillKey | "gate" | "keeper" | null;
  /**
   * 进度环 0–1。**相位刻度不是真实百分比**：每步一个固定区间，步内按 progress
   * 的 done/total 走；等确认停在 0.86（表不随秒针走——看起来会像要求用户在期限
   * 内表态）。
   */
  fraction: number;
  detail: RecallRunDetail;
  /** 等确认：recall 已 done、确认卡浮着等表态（环停、确认胶囊换气泡图标） */
  awaitingConfirm: boolean;
}

const ratio = (done: number, total: number): number => (total > 0 ? Math.min(1, Math.max(0, done / total)) : 0);

/** 卡片状态 → 运行卡显示态。纯函数，单测直接盖事件序列。 */
export function recallRunView(card: RecallCardState): RecallRunView {
  const b1 = card.s3Steps.step1;
  const b2 = card.s3Steps.step2;
  const s3Done = card.steps.s3 === "done";
  const awaiting = card.status === "done" && card.pendingAsks > 0;
  const pills: Record<RecallPillKey, RecallStageStatus> = {
    // 门卫是理解的前奏：门卫还没回来，「理解」也不转（细节行说门卫在判断）
    understand: card.gate === null ? "pending" : card.steps.s1 === "done" ? "done" : "running",
    score:
      b1 === null
        ? s3Done
          ? "done"
          : "pending"
        : s3Done || b2 !== null || b1.done >= b1.total
          ? "done"
          : "running",
    reasons:
      b2 === null
        ? s3Done
          ? "done"
          : "pending"
        : s3Done || b2.done >= b2.total
          ? "done"
          : "running",
    // 确认胶囊只在「真在等你」时转（等确认态）；review 到了但不用问 = 直接勾
    confirm:
      card.review === null
        ? "pending"
        : card.review.ask.length === 0
          ? "done"
          : awaiting
            ? "running"
            : card.status === "done"
              ? "done"
              : "pending",
  };
  let current: RecallRunView["current"] = null;
  if (card.status === "running") {
    if (card.gate === null) current = "gate";
    else if (card.steps.s1 !== "done") current = "understand";
    else if (!s3Done) current = b2 !== null ? "reasons" : "score";
    else if (card.steps.s4 !== "done") current = "keeper";
  }
  const fraction =
    awaiting || card.status === "done"
      ? 0.86
      : current === "gate"
        ? 0.04
        : current === "understand"
          ? 0.12
          : current === "score"
            ? 0.16 + 0.48 * ratio(b1?.done ?? 0, b1?.total ?? 0)
            : current === "reasons"
              ? 0.64 + 0.16 * ratio(b2?.done ?? 0, b2?.total ?? 0)
              : current === "keeper"
                ? 0.8 + 0.05 * ratio(card.s4Progress?.done ?? 0, card.s4Progress?.total ?? 0)
                : 0.84;
  const detail: RecallRunDetail = awaiting
    ? { kind: "confirm", asked: card.pendingAsks }
    : current === "gate"
      ? { kind: "gate" }
      : current === "understand"
        ? { kind: "understand" }
        : current === "score"
          ? { kind: "score", done: b1?.done ?? 0, total: b1?.total ?? card.accepted?.qaTotal ?? 0, passed: b1?.passed ?? 0 }
          : current === "reasons"
            ? { kind: "reasons", done: b2?.done ?? 0, total: b2?.total ?? 0 }
            : current === "keeper"
              ? { kind: "keeper", done: card.s4Progress?.done ?? 0, chars: card.s4Progress?.chars ?? 0 }
              : { kind: "settling" };
  return { pills, current, fraction, detail, awaitingConfirm: awaiting };
}

/**
 * 流事件 → 卡片状态。**纯归约**（renderer 的 reducer 与测试共用）；
 * heartbeat 不改状态（它只保活 60 秒静默判定，那在 runtime 侧）。
 * 终态（done / error）之后再收到的事件按终态原样丢弃——流已结束，迟到行不复活卡片。
 */
export function applyRecallEvent(state: RecallCardState, event: IntentRecallStreamEvent): RecallCardState {
  if (state.status !== "running") return state;
  switch (event.type) {
    case "accepted":
      return {
        ...state,
        accepted: { qaTotal: event.qaTotal, budgetMs: event.budgetMs, peak: event.peak, model: event.swarm.model },
        runId: event.runId,
      };
    case "stage":
      return {
        ...state,
        steps: { ...state.steps, [event.stage]: event.status === "start" ? "running" : "done" },
        // v3.3：阶段用时（终态卡逐格附注）；gate 不走 stage 事件——在 done 的 timing 里补
        ...(event.status === "done" && event.ms !== undefined && (event.stage === "s1" || event.stage === "s3" || event.stage === "s4")
          ? { stageMs: { ...state.stageMs, [event.stage]: event.ms } }
          : {}),
      };
    case "gate":
      return { ...state, gate: { needIntent: event.needIntent, why: event.why, forced: event.forced } };
    case "intent":
      return { ...state, scene: event.scene, want: event.want };
    case "progress": {
      // v3.4：S4 的进度（done=已写条数、passed=字符数）单独记账——不进 S3 两步桶
      if (event.stage === "s4") {
        return { ...state, s4Progress: { done: event.done, total: event.total, chars: event.passed } };
      }
      const now = Date.now();
      const bucket = (current: { done: number; total: number; passed: number; firstAt: number; lastAt: number } | null) =>
        current === null
          ? { done: event.done, total: event.total, passed: event.passed, firstAt: now, lastAt: now }
          : { done: event.done, total: event.total, passed: event.passed, firstAt: current.firstAt, lastAt: now };
      return {
        ...state,
        round: event.round,
        progress: { step: event.step, done: event.done, total: event.total, passed: event.passed, etaMs: event.etaMs },
        s3Steps: {
          step1: event.step === 1 ? bucket(state.s3Steps.step1) : state.s3Steps.step1,
          step2: event.step === 2 ? bucket(state.s3Steps.step2) : state.s3Steps.step2,
        },
      };
    }
    case "retry":
      // v3.1 起线一不再发 retry（S3 只跑一轮）；旧流兼容——只标记，不重置进度
      return { ...state, s3Retried: true };
    case "review":
      return {
        ...state,
        review: { summary: event.summary, selected: event.selected, ask: event.ask, retried: event.retried, askRemaining: event.askRemaining },
        s4Missing: event.missing,
        dedup: event.dedup ?? null,
      };
    case "done":
      return {
        ...state,
        status: "done",
        runId: event.runId,
        timings: event.timing,
        pendingAsks: event.needsFeedback ? (state.review?.ask.length ?? 0) : 0,
        edgesWritten: event.edgesWritten ?? null,
        contextAdded: event.context?.added ?? null,
        stageMs: { ...state.stageMs, gate: event.timing.gateMs },
        skipped: event.skipped ?? null,
        gateWhy: event.gateWhy ?? null,
        // 门卫跳过时 s1/s3/s4 没跑——保持 idle（卡片显示「跳过」而不是假完成）
        steps:
          event.skipped === "gate"
            ? { ...state.steps, gate: "done" }
            : { gate: "done", s1: "done", s3: "done", s4: "done" },
      };
    case "error":
      return {
        ...state,
        status: "error",
        error: { stage: event.stage, message: event.message, retryable: event.retryable },
      };
    case "heartbeat":
      return state;
  }
}

/** 一轮 recall 的终态卡片（status ∈ done / error / cancelled；running 不落盘）。 */
export function recallCardFinalized(state: RecallCardState, finishedAt: number): RecallCardState {
  return state.status === "running" ? { ...state, status: "cancelled" } : state;
}
