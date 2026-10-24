/**
 * 任务引用：用户把侧栏里的一条会话拖进输入框，这条消息就带上「去读那条任务」的指针。
 *
 * **载体就是消息正文**（同 quote.ts 的理由：pi 的 `prompt(text)` 只收一段文字，转录与
 * pi 本子必须是同一段话）。发送时每条引用展开成一行 `<referenced_task id="…" title="…" />`
 * 排在最前面，显示时解析回 chip。**只给指针不给内容**：几十轮的转录直接内联会把每轮请求
 * 撑爆，模型按需用 read_task 读概览或指定轮次——读法写在 read_task 的 promptGuidelines
 * （agent/task-tools.ts），格式与说明分处两地但都只认这里的标签名。
 *
 * id 用完整 uuid：read_task 的精确 id 匹配是全仓的（read-task.ts 的 resolveTaskReference），
 * 跨工作区拖进来的会话也能一次读中；标题只给模型与 chip 看，不参与解析。
 */

export interface TaskRef {
  id: string;
  title: string;
}

/** 侧栏会话行 → 输入框的拖拽数据类型（payload 是 JSON 的 TaskRef） */
export const TASK_REF_MIME = "application/x-orbita-task";

export const TASK_REF_TAG = "referenced_task";

function encodeAttribute(value: string): string {
  // 换行压成空格：一行一条是解析的前提
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

function taskRefLine(task: TaskRef): string {
  return `<${TASK_REF_TAG} id="${encodeAttribute(task.id)}" title="${encodeAttribute(task.title)}" />`;
}

/** 任务引用 + 其余正文 → 整段正文：引用行在最前（一行一条），空行后接其余。没有引用原样返回 */
export function composeTaskRefMessage(tasks: readonly TaskRef[], text: string): string {
  if (tasks.length === 0) return text;
  return `${tasks.map(taskRefLine).join("\n")}\n\n${text}`.trimEnd();
}

const LINE = new RegExp(`<${TASK_REF_TAG}\\b([^>]*?)/>(?:\\r?\\n)*`, "g");

function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return match?.[1] === undefined ? undefined : decodeAttribute(match[1]);
}

/** 整段正文 → 任务引用 + 其余正文。没有 id 的行原样留着（宁可显示标签，也不吞内容） */
export function parseTaskRefs(message: string): { tasks: TaskRef[]; text: string } {
  if (!message.includes(`<${TASK_REF_TAG}`)) return { tasks: [], text: message };
  const tasks: TaskRef[] = [];
  const text = message.replace(LINE, (whole, attrs: string) => {
    const id = attribute(attrs, "id");
    if (id === undefined || id === "") return whole;
    tasks.push({ id, title: attribute(attrs, "title") ?? "" });
    return "";
  });
  return { tasks, text: text.trim() };
}

/** 拖拽 payload → TaskRef；不是我们写的形状返回 null */
export function parseTaskRefPayload(raw: string): TaskRef | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const id = (value as Record<string, unknown>)["id"];
    const title = (value as Record<string, unknown>)["title"];
    if (typeof id !== "string" || id === "") return null;
    return { id, title: typeof title === "string" ? title : "" };
  } catch {
    return null;
  }
}
