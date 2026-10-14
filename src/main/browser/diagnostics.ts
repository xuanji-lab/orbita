/**
 * 页面诊断的采集缓冲（控制台消息 + 网络请求）——**纯 TypeScript**，不 import electron，
 * `node --test` 直接覆盖（diagnostics.test.ts）。
 *
 * 为什么有它：页面加载成功但内容空白时（JS 报错、XHR 401/403、CORS 被拒、被 Cloudflare 挡），
 * 模型手里只有一句 "Loaded … HTTP 200" 和空大纲——只能瞎猜、反复重试或谎报。控制台与网络
 * 是唯一能说明「为什么白屏」的两份证据（参考 Obscura 的 browser_console_messages /
 * browser_network_requests）。
 *
 * 这里管三件事：环形缓冲（每个 tab 每个域各一份，满了丢最旧）、CDP 事件 → 条目的映射、
 * 过滤与给模型的文字。CDP 的接线（懒 enable、事件监听、tab 销毁清理）在 diagnostics-recorder.ts。
 */
import {
  BROWSER_DIAGNOSTICS_BUFFER_LIMIT,
  type BrowserConsoleLevel,
} from "../../shared/browser.ts";

/** 单条正文的上限：异常栈可以很长，一次工具结果不该被一条消息撑爆 */
const MAX_ENTRY_CHARS = 400;

/** 一条控制台消息 */
export interface ConsoleEntry {
  level: BrowserConsoleLevel;
  /** 已拼好的参数文本。对象只到 CDP 的 `description`（"Object"、"Array(3)"），没有 preview */
  text: string;
  /** 出处 `脚本URL:行`；拿不到时空串 */
  where: string;
}

/**
 * 一条网络请求。**同一个 requestId 只有一条**：重定向会再发一次 `requestWillBeSent`，
 * 那条在原条目上更新（否则一次 302 会变成两条请求，模型会误判请求数）。
 */
export interface NetworkEntry {
  id: string;
  method: string;
  url: string;
  /** 响应状态码；还没回来或加载失败时缺席 */
  status?: number;
  /** 响应 MIME 类型；空串当没有 */
  mimeType?: string;
  /** 加载失败原因（net::ERR_FAILED、CORS 拒绝…）；成功时缺席 */
  failure?: string;
}

/** 定长环形缓冲：满了丢最旧，容量固定、内存不随页面活多久长 */
export class RingBuffer<T> {
  readonly capacity: number;
  private readonly slots: (T | undefined)[];
  /** 最旧一条所在的下标 */
  private start = 0;
  private count = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("RingBuffer 容量必须是正整数");
    this.capacity = capacity;
    this.slots = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  /** 压入一条；回被挤掉的那条（没满时 undefined），调用方据此同步自己的索引 */
  push(item: T): T | undefined {
    if (this.count < this.capacity) {
      this.slots[(this.start + this.count) % this.capacity] = item;
      this.count += 1;
      return undefined;
    }
    const evicted = this.slots[this.start];
    this.slots[this.start] = item;
    this.start = (this.start + 1) % this.capacity;
    return evicted;
  }

  clear(): void {
    this.slots.fill(undefined);
    this.start = 0;
    this.count = 0;
  }

  /** 从旧到新 */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i += 1) {
      const item = this.slots[(this.start + i) % this.capacity];
      if (item !== undefined) out.push(item);
    }
    return out;
  }
}

/** 级别高低：过滤按「这个级别及以上」 */
const LEVEL_RANK: Record<BrowserConsoleLevel, number> = { debug: 0, log: 1, info: 2, warn: 3, error: 4 };

/**
 * 一个 tab 的诊断缓冲。**跨文档导航时由接线层 clear()**：上一页的消息不再代表当前页
 * （SPA 的 did-navigate-in-page 不算换文档，历史保留）。
 */
export class TabDiagnostics {
  private readonly console = new RingBuffer<ConsoleEntry>(BROWSER_DIAGNOSTICS_BUFFER_LIMIT);
  private readonly network = new RingBuffer<NetworkEntry>(BROWSER_DIAGNOSTICS_BUFFER_LIMIT);
  /** requestId → 条目：响应 / 失败 / 重定向都在原条目上更新，不另起一条 */
  private readonly byRequest = new Map<string, NetworkEntry>();

  get consoleCount(): number {
    return this.console.size;
  }

  get networkCount(): number {
    return this.network.size;
  }

  clear(): void {
    this.console.clear();
    this.network.clear();
    this.byRequest.clear();
  }

  // ── CDP 事件（参数形状见 CDP 的 Runtime / Log / Network 域）────────────

  /** Runtime.consoleAPICalled：console.log / warn / error … */
  onConsoleApiCalled(params: unknown): void {
    const event = asRecord(params);
    const args = Array.isArray(event["args"]) ? event["args"] : [];
    this.pushConsole({
      level: levelOfConsoleType(typeof event["type"] === "string" ? event["type"] : "log"),
      text: args.map(describeRemoteObject).filter((part) => part !== "").join(" "),
      where: frameWhere(event["stackTrace"]),
    });
  }

  /** Runtime.exceptionThrown：未捕获异常。`exception.description` 带栈，优先用它 */
  onExceptionThrown(params: unknown): void {
    const details = asRecord(asRecord(params)["exceptionDetails"]);
    const exception = asRecord(details["exception"]);
    const description = typeof exception["description"] === "string" ? exception["description"] : "";
    const text = description !== "" ? description : typeof details["text"] === "string" ? details["text"] : "Uncaught exception";
    const url = typeof details["url"] === "string" ? details["url"] : "";
    const line = typeof details["lineNumber"] === "number" ? details["lineNumber"] + 1 : 0;
    this.pushConsole({ level: "error", text, where: url === "" ? "" : `${url}:${line}` });
  }

  /** Log.entryAdded：浏览器级错误（请求失败、CORS、混合内容…）只在这里出现 */
  onLogEntryAdded(params: unknown): void {
    const entry = asRecord(asRecord(params)["entry"]);
    const url = typeof entry["url"] === "string" ? entry["url"] : "";
    const line = typeof entry["lineNumber"] === "number" ? entry["lineNumber"] : 0;
    this.pushConsole({
      level: levelOfLogSource(typeof entry["level"] === "string" ? entry["level"] : "info"),
      text: typeof entry["text"] === "string" ? entry["text"] : "",
      where: url === "" ? "" : `${url}:${line}`,
    });
  }

  /** Network.requestWillBeSent：新请求建条目；同 requestId 的重定向在原条目上改 URL / 方法 */
  onRequestWillBeSent(params: unknown): void {
    const event = asRecord(params);
    const id = typeof event["requestId"] === "string" ? event["requestId"] : "";
    if (id === "") return;
    const request = asRecord(event["request"]);
    const url = typeof request["url"] === "string" ? request["url"] : "";
    const method = typeof request["method"] === "string" ? request["method"] : "GET";
    const existing = this.byRequest.get(id);
    if (existing !== undefined) {
      existing.url = url;
      existing.method = method;
      return;
    }
    const entry: NetworkEntry = { id, method, url };
    const evicted = this.network.push(entry);
    if (evicted !== undefined) this.byRequest.delete(evicted.id);
    this.byRequest.set(id, entry);
  }

  /** Network.responseReceived：状态码与 MIME 落到对应条目上 */
  onResponseReceived(params: unknown): void {
    const event = asRecord(params);
    const entry = this.byRequest.get(typeof event["requestId"] === "string" ? event["requestId"] : "");
    if (entry === undefined) return;
    const response = asRecord(event["response"]);
    if (typeof response["status"] === "number") entry.status = response["status"];
    const mimeType = typeof response["mimeType"] === "string" ? response["mimeType"] : "";
    if (mimeType !== "") entry.mimeType = mimeType;
  }

  /**
   * Network.loadingFailed：加载失败原因。**canceled 的丢掉**——导航换页会取消在途请求，
   * 那不是错误，报给模型只会把一次正常跳转说成一片红。
   */
  onLoadingFailed(params: unknown): void {
    const event = asRecord(params);
    if (event["canceled"] === true) return;
    const entry = this.byRequest.get(typeof event["requestId"] === "string" ? event["requestId"] : "");
    if (entry === undefined) return;
    const errorText = typeof event["errorText"] === "string" ? event["errorText"] : "failed";
    const blocked = typeof event["blockedReason"] === "string" && event["blockedReason"] !== "" ? ` (${event["blockedReason"]})` : "";
    entry.failure = `${errorText}${blocked}`;
  }

  // ── 读取（过滤，从旧到新；limit 由格式化层取最近若干条）────────────────

  /** 按最低级别过滤；`level` 缺席 = 不过滤 */
  consoleMessages(level?: BrowserConsoleLevel): ConsoleEntry[] {
    const entries = this.console.toArray();
    return level === undefined ? entries : entries.filter((entry) => LEVEL_RANK[entry.level] >= LEVEL_RANK[level]);
  }

  /** 按 URL 子串（不区分大小写）与状态码闭区间过滤 */
  networkRequests(query: NetworkQuery): NetworkEntry[] {
    const needle = query.url === undefined ? "" : query.url.trim().toLowerCase();
    return this.network.toArray().filter((entry) => {
      if (needle !== "" && !entry.url.toLowerCase().includes(needle)) return false;
      if (query.statusMin === undefined && query.statusMax === undefined) return true;
      // 加载失败没有状态码：给了状态范围就不匹配（失败原因按 url 过滤或不给范围来看）
      if (entry.status === undefined) return false;
      if (query.statusMin !== undefined && entry.status < query.statusMin) return false;
      if (query.statusMax !== undefined && entry.status > query.statusMax) return false;
      return true;
    });
  }

  private pushConsole(entry: ConsoleEntry): void {
    this.console.push({ ...entry, text: clampText(entry.text) });
  }
}

export interface ConsoleQuery {
  level?: BrowserConsoleLevel;
  limit: number;
}

export interface NetworkQuery {
  url?: string;
  statusMin?: number;
  statusMax?: number;
  limit: number;
}

/**
 * 控制台报告：URL / 标题 + 消息块 + 计数。`entries` 已按级别过滤、**未按 limit 截断**——
 * 计数要如实说出「还有多少条没给」，截断在这里做。
 */
export function formatConsoleReport(
  page: { url: string; title: string },
  entries: readonly ConsoleEntry[],
  query: ConsoleQuery,
  justEnabled: boolean,
  /** 缓冲里的原始条数（未过滤）：用来区分「一条都没有」与「都被级别滤掉了」 */
  total: number,
): string {
  const lines = [`URL: ${page.url}`, `Title: ${page.title}`];
  const shown = entries.slice(Math.max(0, entries.length - query.limit));
  if (shown.length === 0) {
    lines.push(emptyConsoleLine(total, query, justEnabled));
    return lines.join("\n");
  }
  lines.push("<console-messages untrusted>");
  for (const entry of shown) lines.push(`[${entry.level}] ${entry.text}${entry.where === "" ? "" : ` (${entry.where})`}`);
  lines.push("</console-messages>");
  lines.push(
    `${shown.length} of ${entries.length} message(s) shown${entries.length > shown.length ? " (most recent)" : ""}` +
      `${query.level === undefined ? "" : ` at level ${query.level} and above`}.`,
  );
  if (justEnabled) lines.push("Capture was just turned on for this tab: only what happened from now on is recorded.");
  return lines.join("\n");
}

/** 网络报告：URL / 标题 + 请求块 + 计数 */
export function formatNetworkReport(
  page: { url: string; title: string },
  entries: readonly NetworkEntry[],
  query: NetworkQuery,
  justEnabled: boolean,
  /** 缓冲里的原始条数（未过滤） */
  total: number,
): string {
  const lines = [`URL: ${page.url}`, `Title: ${page.title}`];
  const shown = entries.slice(Math.max(0, entries.length - query.limit));
  if (shown.length === 0) {
    lines.push(emptyNetworkLine(total, query, justEnabled));
    return lines.join("\n");
  }
  lines.push("<network-requests untrusted>");
  for (const entry of shown) lines.push(networkLine(entry));
  lines.push("</network-requests>");
  lines.push(
    `${shown.length} of ${entries.length} request(s) shown${entries.length > shown.length ? " (most recent)" : ""}` +
      `${describeFilters(query)}.`,
  );
  if (justEnabled) lines.push("Capture was just turned on for this tab: only what happened from now on is recorded.");
  return lines.join("\n");
}

function networkLine(entry: NetworkEntry): string {
  if (entry.failure !== undefined) return `${entry.method} ${entry.url} → FAILED ${entry.failure}`;
  if (entry.status === undefined) return `${entry.method} ${entry.url} → (no response yet)`;
  return `${entry.method} ${entry.url} → ${entry.status}${entry.mimeType === undefined ? "" : ` ${entry.mimeType}`}`;
}

function describeFilters(query: NetworkQuery): string {
  const parts: string[] = [];
  if (query.url !== undefined && query.url.trim() !== "") parts.push(`url contains "${query.url.trim()}"`);
  if (query.statusMin !== undefined || query.statusMax !== undefined) {
    parts.push(`status ${query.statusMin ?? "…"}–${query.statusMax ?? "…"}`);
  }
  return parts.length === 0 ? "" : ` matching ${parts.join(", ")}`;
}

function emptyConsoleLine(total: number, query: ConsoleQuery, justEnabled: boolean): string {
  if (total > 0) {
    return `No console messages at level ${query.level ?? "log"} or above (${total} lower-level message(s) in the buffer).`;
  }
  if (justEnabled) {
    return (
      "No console messages yet. Capture was just turned on for this tab and only records what happens from now on — " +
      "reload the page (browser_navigate with the same URL) and call this tool again."
    );
  }
  return "No console messages in the buffer.";
}

function emptyNetworkLine(total: number, query: NetworkQuery, justEnabled: boolean): string {
  if (total > 0) return `No network requests matched the filter${describeFilters(query)} (${total} in the buffer).`;
  if (justEnabled) {
    return (
      "No network requests yet. Capture was just turned on for this tab and only records what happens from now on — " +
      "reload the page (browser_navigate with the same URL) and call this tool again."
    );
  }
  return "No network requests in the buffer.";
}

// ── CDP 参数 → 条目（都是 unknown 收进来再逐字段认）────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** 一个 console 参数 → 一行文本。对象只有 description（CDP 不给 preview），够认出来是什么 */
function describeRemoteObject(value: unknown): string {
  const object = asRecord(value);
  const type = typeof object["type"] === "string" ? object["type"] : "";
  if (type === "undefined") return "undefined";
  if (type === "string") return typeof object["value"] === "string" ? object["value"] : "";
  // NaN / Infinity / -0 只有 unserializableValue，没有 value
  if (typeof object["unserializableValue"] === "string") return object["unserializableValue"];
  if (type === "number" || type === "boolean") return String(object["value"]);
  if (object["value"] === null && type === "object") return "null";
  if (typeof object["description"] === "string" && object["description"] !== "") return object["description"];
  return type;
}

/** console 的 type → 级别；非标准的（table / group / count…）一律算 log */
function levelOfConsoleType(type: string): BrowserConsoleLevel {
  if (type === "error" || type === "assert") return "error";
  if (type === "warning" || type === "warn") return "warn";
  if (type === "info") return "info";
  if (type === "debug" || type === "verbose") return "debug";
  return "log";
}

/** Log.entryAdded 的 level → 级别 */
function levelOfLogSource(level: string): BrowserConsoleLevel {
  if (level === "error") return "error";
  if (level === "warning") return "warn";
  if (level === "verbose") return "debug";
  return "info";
}

/** 堆栈首帧的 `url:行`（行号从 0 数，转成人类习惯的 1 起） */
function frameWhere(stackTrace: unknown): string {
  const frames = asRecord(stackTrace)["callFrames"];
  const first = Array.isArray(frames) ? asRecord(frames[0]) : {};
  const url = typeof first["url"] === "string" ? first["url"] : "";
  const line = typeof first["lineNumber"] === "number" ? first["lineNumber"] + 1 : 0;
  return url === "" ? "" : `${url}:${line}`;
}

function clampText(text: string): string {
  return text.length <= MAX_ENTRY_CHARS ? text : `${text.slice(0, MAX_ENTRY_CHARS)}…`;
}
