/**
 * 任务引用：用户把侧栏里的一条会话拖进输入框，在松手处插一颗胶囊；这条消息就带上「去读那条任务」的指针。
 *
 * 两种写法，一进一出（设计取舍见 2026-11-23 提交说明）：
 * - **输入框里是短 token `[任务 xxxxxxxx]`**（会话 id 去连字符后的前 12 位十六进制）。草稿、撤销、排队、撤回都只认
 *   这一段字符串，不另设状态表——与「图 N」小签的区别是它不依赖附件序号，自己就带着指向。
 *   textarea 里的 token 占多宽，胶囊就占多宽（镜像层逐字对齐），所以必须短；整条 uuid 加标题会把胶囊撑到一整行。
 *   名字不存在 token 里，由渲染侧按会话列表现查（标题改了胶囊跟着变；查不到的 token 只是普通文字，不画成胶囊）。
 * - **发送时就地展开成 `<referenced_task id="…" title="…" />`**（token 在句中的位置保留，「把 A 和 B 对比」
 *   读得通）。转录与 pi 本子存的就是展开后的整段话；气泡 / 撤回再把标签折回 token。
 *   **只给指针不给内容**：几十轮的转录直接内联会把每轮请求撑爆，模型按需用 read_task 读概览或指定轮次
 *   （读法写在 agent/task-tools.ts 的 promptGuidelines，那里只认这里的标签名）。
 *
 * 前缀 12 位十六进制在一个人的会话库里不会撞；万一撞了（多于一条会话以它开头）按「查不到」处理，
 * 不乱指——宁可不画胶囊，不指错会话。
 */

import { insertInlineTokens } from "./prompt-image-refs.ts";

export interface TaskRef {
  id: string;
  title: string;
}

/** 侧栏会话行 → 输入框的拖拽数据类型（payload 是 JSON 的 TaskRef） */
export const TASK_REF_MIME = "application/x-orbita-task";

export const TASK_REF_TAG = "referenced_task";

/**
 * token 里写会话 id（去掉连字符）的前几位。12 位而不是 8 位：token 占多宽胶囊就占多宽，
 * 8 位时胶囊里只放得下标题的前四五个字（2026-11-23 实测），12 位能多放两三个字，
 * 前缀撞车的概率仍可忽略（48 bit）。
 */
export const TASK_TOKEN_ID_LENGTH = 12;

/** 会话 id → token 里写的那一段（去连字符的前 TASK_TOKEN_ID_LENGTH 位）；气泡按它把标签对回 token */
export function taskIdKey(id: string): string {
  return id.replace(/-/g, "").slice(0, TASK_TOKEN_ID_LENGTH);
}

/** 会话 id → 输入框里的 token */
export function taskRefToken(id: string): string {
  return `[任务 ${taskIdKey(id)}]`;
}

const TOKEN_SOURCE = `\\[任务 ([0-9a-f]{${TASK_TOKEN_ID_LENGTH}})\\]`;

/** 够长、全是十六进制（去连字符后）——手写的残缺标签 / 乱 payload 不认 */
function isTaskId(id: string): boolean {
  return new RegExp(`^[0-9a-f]{${TASK_TOKEN_ID_LENGTH}}`).test(id.replace(/-/g, ""));
}

/** 正文里的一处任务 token：[start, end) 按 UTF-16 下标（与 textarea 的 selectionStart 同一套） */
export interface TaskTokenSpan {
  start: number;
  end: number;
  /** token 里的 id 前缀 */
  prefix: string;
}

/** 扫出正文里所有形状对的 token（不查会话是否存在） */
export function parseTaskTokens(text: string): TaskTokenSpan[] {
  const out: TaskTokenSpan[] = [];
  const pattern = new RegExp(TOKEN_SOURCE, "g");
  let hit: RegExpExecArray | null;
  while ((hit = pattern.exec(text)) !== null) {
    out.push({ start: hit.index, end: hit.index + hit[0].length, prefix: hit[1] ?? "" });
  }
  return out;
}

/** 前缀 → 唯一对得上的会话；没有或不止一条返回 null */
export function resolveTaskPrefix(prefix: string, tasks: readonly TaskRef[]): TaskRef | null {
  const matches = tasks.filter((task) => taskIdKey(task.id) === prefix);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export interface ResolvedTaskToken extends TaskTokenSpan {
  task: TaskRef;
}

/** 只留查得到会话的 token（输入框画胶囊、发送展开都以它为准） */
export function resolveTaskTokens(text: string, tasks: readonly TaskRef[]): ResolvedTaskToken[] {
  const out: ResolvedTaskToken[] = [];
  for (const span of parseTaskTokens(text)) {
    const task = resolveTaskPrefix(span.prefix, tasks);
    if (task !== null) out.push({ ...span, task });
  }
  return out;
}

/** 在指定位置插一颗任务 token（与前后文字补空格的规矩同图小签）；返回新正文、插入后的光标与插入的那段字 */
export function insertTaskToken(
  text: string,
  at: number,
  task: TaskRef,
): { text: string; caret: number; inserted: string; from: number } {
  const next = insertInlineTokens(text, at, [taskRefToken(task.id)]);
  const from = Math.max(0, Math.min(at, text.length));
  return { ...next, from, inserted: next.text.slice(from, next.caret) };
}

function encodeAttribute(value: string): string {
  // 换行压成空格：标签必须在一行里
  return value
    .replace(/\r?\n/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function decodeAttribute(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

function taskRefTag(task: TaskRef): string {
  return `<${TASK_REF_TAG} id="${encodeAttribute(task.id)}" title="${encodeAttribute(task.title)}" />`;
}

/** 发送时：把正文里查得到会话的 token 就地换成 `<referenced_task … />`；其余原样 */
export function expandTaskTokens(text: string, tasks: readonly TaskRef[]): string {
  const hits = resolveTaskTokens(text, tasks);
  if (hits.length === 0) return text;
  let out = "";
  let last = 0;
  for (const hit of hits) {
    out += text.slice(last, hit.start) + taskRefTag(hit.task);
    last = hit.end;
  }
  return out + text.slice(last);
}

const TAG = new RegExp(`<${TASK_REF_TAG}\\b([^>]*?)/>`, "g");

function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return match?.[1] === undefined ? undefined : decodeAttribute(match[1]);
}

/**
 * 已发出的正文 → 折回 token，并交出每个标签里的 {id,title}（气泡画胶囊要标题——会话可能已被删，
 * 所以标题取自标签而不是会话列表）。没有 id 的标签原样留着（宁可显示标签也不吞内容）。
 * id 短于前缀长度（手写的标签）也原样留着。
 */
export function collapseTaskTags(message: string): { text: string; tasks: TaskRef[] } {
  if (!message.includes(`<${TASK_REF_TAG}`)) return { text: message, tasks: [] };
  const tasks: TaskRef[] = [];
  const text = message.replace(TAG, (whole, attrs: string) => {
    const id = attribute(attrs, "id");
    if (id === undefined || !isTaskId(id)) return whole;
    tasks.push({ id, title: attribute(attrs, "title") ?? "" });
    return taskRefToken(id);
  });
  return { text, tasks };
}

/** 拖拽 payload（JSON） */
export function taskRefPayload(task: TaskRef): string {
  return JSON.stringify({ id: task.id, title: task.title });
}

/** 拖拽 payload → TaskRef；不是我们写的形状返回 null */
export function parseTaskRefPayload(raw: string): TaskRef | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const id = (value as Record<string, unknown>)["id"];
    const title = (value as Record<string, unknown>)["title"];
    if (typeof id !== "string" || !isTaskId(id)) return null;
    return { id, title: typeof title === "string" ? title : "" };
  } catch {
    return null;
  }
}
