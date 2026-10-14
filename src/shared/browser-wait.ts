/**
 * browser_wait_for 的纯逻辑：参数规整、命中判定、页内探针脚本、轮询骨架、给模型的话。
 *
 * 放 shared/ 是因为**两个进程要用同一份**：agent 进程（发请求前校验、按夹取后的 timeoutMs 算
 * broker 超时）与主进程（轮询、判定、排版）。夹取与错误话术只此一处，不复制第二份。
 *
 * 页内脚本只**探一次**——回答「此刻在不在」，不等待、不挂 MutationObserver。等多久由主进程
 * 分段轮询推进，理由见 main/browser/agent-requests.ts 的 waitFor。
 */

/** 不给 timeoutMs 时的等待上限 */
export const WAIT_DEFAULT_TIMEOUT_MS = 8_000;
/** 上限：再长就是模型在盲等，不如把「没出现」拿回去自己决定下一步 */
export const WAIT_MAX_TIMEOUT_MS = 30_000;
/** 下限：比这更短的等待与「现在就探一次」没有区别，给个能走完一轮探针的地板 */
export const WAIT_MIN_TIMEOUT_MS = 100;
/** 轮询间隔：够短（人眼看不出滞后），又不会把 CDP 打成忙等 */
export const WAIT_POLL_MS = 200;
/** 页内 visible 判定最多看几个匹配（页面里几千个 `.item` 时别整页扫） */
const VISIBLE_SCAN_LIMIT = 500;

export interface BrowserWaitSpec {
  selector?: string;
  text?: string;
  /** 只对 selector 生效：要求元素有非零包围盒、不是 visibility:hidden */
  visible: boolean;
  timeoutMs: number;
}

export type BrowserWaitParse =
  | { ok: true; spec: BrowserWaitSpec; note: string | null }
  | { ok: false; error: string };

/**
 * 入参规整。selector / text 去掉首尾空白后至少有一个，否则当场报错（模型能立刻改口，
 * 而不是等 8 秒拿到一句「没出现」）；timeoutMs 夹进 [100, 30000]，夹过就在结果里说一声。
 */
export function parseWaitSpec(input: {
  selector?: unknown;
  text?: unknown;
  visible?: unknown;
  timeoutMs?: unknown;
}): BrowserWaitParse {
  const selector = trimmed(input.selector);
  const text = trimmed(input.text);
  if (selector === undefined && text === undefined) {
    return { ok: false, error: "Pass selector or text — at least one of them says what to wait for." };
  }
  const clamped = clampWaitTimeout(input.timeoutMs);
  return {
    ok: true,
    spec: {
      ...(selector === undefined ? {} : { selector }),
      ...(text === undefined ? {} : { text }),
      visible: input.visible === true,
      timeoutMs: clamped.timeoutMs,
    },
    note: clamped.note,
  };
}

/** 模型偶尔把数字写成字符串（"5000"）：认；其余一律当没给（用默认值） */
export function clampWaitTimeout(value: unknown): { timeoutMs: number; note: string | null } {
  const asked = numberOf(value);
  if (asked === undefined) return { timeoutMs: WAIT_DEFAULT_TIMEOUT_MS, note: null };
  const rounded = Math.round(asked);
  if (rounded > WAIT_MAX_TIMEOUT_MS) {
    return { timeoutMs: WAIT_MAX_TIMEOUT_MS, note: `timeoutMs was capped at ${WAIT_MAX_TIMEOUT_MS}` };
  }
  if (rounded < WAIT_MIN_TIMEOUT_MS) {
    return { timeoutMs: WAIT_MIN_TIMEOUT_MS, note: `timeoutMs was raised to ${WAIT_MIN_TIMEOUT_MS}` };
  }
  return { timeoutMs: rounded, note: null };
}

/**
 * 页内探针。selector 用 JSON 字面量嵌进去（模型给的选择器里有引号也不会串成代码）；
 * 选择器非法时回 `{ error: "invalid-selector" }`——主进程据此当场报错，不干等到超时。
 * visible 时在所有匹配里找第一个可见的（第一个匹配可能恰好被藏起来了）。
 */
export function waitProbeScript(spec: BrowserWaitSpec): string {
  const selector = spec.selector === undefined ? "null" : JSON.stringify(spec.selector);
  const text = spec.text === undefined ? "null" : JSON.stringify(spec.text);
  return `(() => {
  const selector = ${selector};
  const text = ${text};
  const needVisible = ${spec.visible ? "true" : "false"};
  const out = { selector: null, text: null };
  if (selector !== null) {
    try {
      const nodes = document.querySelectorAll(selector);
      const limit = Math.min(nodes.length, ${VISIBLE_SCAN_LIMIT});
      let found = false;
      for (let i = 0; i < limit; i += 1) {
        if (!needVisible) { found = true; break; }
        const box = nodes[i].getBoundingClientRect();
        if (box.width > 0 && box.height > 0 && getComputedStyle(nodes[i]).visibility !== "hidden") {
          found = true;
          break;
        }
      }
      out.selector = found;
    } catch (cause) {
      return { error: "invalid-selector" };
    }
  }
  if (text !== null) out.text = (document.body ? document.body.innerText : "").includes(text);
  return out;
})()`;
}

/** 一次探针的回答。两个条件各自的三态：没问（null）/ 没到 / 到了 */
export interface BrowserWaitSample {
  selector: boolean | null;
  text: boolean | null;
}

/** 探针回值 → 样本。认不出来（页面没答上来、结构不对）回 null，当这一轮没探到 */
export function parseWaitSample(value: unknown): BrowserWaitSample | { error: "invalid-selector" } | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record["error"] === "invalid-selector") return { error: "invalid-selector" };
  const selector = typeof record["selector"] === "boolean" ? record["selector"] : null;
  const text = typeof record["text"] === "boolean" ? record["text"] : null;
  return selector === null && text === null ? null : { selector, text };
}

/** 命中了没有。两个条件都给了就是「任一命中」——等到一个就可以往下走了 */
export function waitSampleHit(sample: BrowserWaitSample, spec: BrowserWaitSpec): boolean {
  const selectorHit = spec.selector !== undefined && sample.selector === true;
  const textHit = spec.text !== undefined && sample.text === true;
  return selectorHit || textHit;
}

/**
 * 轮询等待的骨架：探针说「到了」就返回命中，deadline 到点返回未命中，选择器非法立即返回错误。
 * 探针由调用方给（主进程那侧就是一次 CDP `Runtime.evaluate`）——等待骨架不碰 Electron，
 * 能按真实时钟测；探针自己报错（页面正在换文档、崩了）不算结果，交给下一轮。
 */
export async function waitUntilHit(
  probe: () => Promise<BrowserWaitSample | { error: "invalid-selector" } | null>,
  spec: BrowserWaitSpec,
): Promise<{ hit: boolean; elapsedMs: number } | { error: "invalid-selector" }> {
  const started = Date.now();
  const deadline = started + spec.timeoutMs;
  for (;;) {
    const sample = await probe();
    if (sample !== null && "error" in sample) return { error: "invalid-selector" };
    if (sample !== null && waitSampleHit(sample, spec)) return { hit: true, elapsedMs: Date.now() - started };
    const left = deadline - Date.now();
    if (left <= 0) return { hit: false, elapsedMs: Date.now() - started };
    await delay(Math.min(WAIT_POLL_MS, left));
  }
}

/** 等的是什么，一句话（结果正文用） */
export function describeWaitTarget(spec: BrowserWaitSpec): string {
  const parts: string[] = [];
  if (spec.selector !== undefined) parts.push(`${spec.selector}${spec.visible ? " (visible)" : ""}`);
  if (spec.text !== undefined) parts.push(`the text ${JSON.stringify(spec.text)}`);
  return parts.join(" or ");
}

/**
 * 给模型的正文。等到与没等到都带页面的标题 / URL——模型不用再问一次「现在在哪」。
 * 没等到时明说「这不是错误」，并给出下一步（看看实际有什么 / 再等一次）。
 */
export function formatWaitResult(
  page: { url: string; title: string },
  spec: BrowserWaitSpec,
  outcome: { hit: boolean; elapsedMs: number },
  note?: string | null,
): string {
  const where = `${page.url} — "${page.title}"`;
  const target = describeWaitTarget(spec);
  const seconds = Math.round(outcome.elapsedMs / 100) / 10;
  const lines = outcome.hit
    ? [
        `${target} appeared after ${seconds}s on ${where}.`,
        "Call browser_observe to see the structure (and get element refs), or browser_extract to read the text.",
      ]
    : [
        `${target} did not appear within ${spec.timeoutMs / 1000}s on ${where}.`,
        "That is not an error: the page may still be loading, need a login, or simply never show it. " +
          "Call browser_observe or browser_extract to see what is actually there — or wait again with a longer timeout.",
      ];
  if (note !== null && note !== undefined && note !== "") lines.push(`${note}.`);
  return lines.join("\n");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}
