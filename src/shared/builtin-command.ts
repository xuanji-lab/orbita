/**
 * 内置命令的「结果 details 约定」—— agent 工具（`src/agent/*-tools.ts`）与渲染层共用的契约。
 *
 * 一个内置命令（slides_create、doc_open 这类）除了给模型返回文字，还要让界面做三件事：
 * 1. 过程行显示**中文命令名 + 参数摘要**（渲染层的注册表 `builtin-commands.ts` 管，不在这里）；
 * 2. 完成后出一张**卡**（`card`）：图标 + 标题 + 副标题，点击在右栏打开；
 * 3. agent 新建 / 打开东西时**右栏自动打开**它（`openPanel`）。
 *
 * 2 与 3 经工具结果的 `details` 传（只给界面，模型看不见）：
 *
 *   details: {
 *     openPanel?: { kind, path, force? },
 *     card?: { kind, path, title, subtitle? },
 *   }
 *
 * 两个字段都由 `readOpenPanel` / `readCommandCard` **逐字段校验**后才用——坏值判 null：
 * 卡坏了不碍事，编造路径（点了打开别的文件）才碍事。
 */

/** 右栏要打开的面板：演示文稿面板 / 文件面板（文档在文件面板里开，见 doc_open） */
export type OpenPanelKind = "slides" | "files";

export interface OpenPanelHint {
  kind: OpenPanelKind;
  /** 要打开的文件（绝对路径） */
  path: string;
  /**
   * 强制：用户已经在看别的东西也切过去（新建时用）。缺席 = 只在本会话第一次碰到这个文件时打开，
   * 之后 agent 每改一页不再把右栏抢回来（用户可能正在看别的）。
   */
  force?: boolean;
}

/** 卡的图标类别：渲染层按它挑 lucide 图标 */
export type CommandCardKind = "slides" | "doc" | "export";

export interface CommandCardData {
  kind: CommandCardKind;
  path: string;
  title: string;
  /** 副标题（「演示文稿 · 5 页」）；缺席由渲染层按文件补 */
  subtitle?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readOpenPanel(details: unknown): OpenPanelHint | null {
  if (!isRecord(details)) return null;
  const raw = details["openPanel"];
  if (!isRecord(raw)) return null;
  const kind = raw["kind"];
  const path = raw["path"];
  if (kind !== "slides" && kind !== "files") return null;
  if (typeof path !== "string" || path === "") return null;
  return { kind, path, ...(raw["force"] === true ? { force: true } : {}) };
}

export function readCommandCard(details: unknown): CommandCardData | null {
  if (!isRecord(details)) return null;
  const raw = details["card"];
  if (!isRecord(raw)) return null;
  const kind = raw["kind"];
  const path = raw["path"];
  const title = raw["title"];
  if (kind !== "slides" && kind !== "doc" && kind !== "export") return null;
  if (typeof path !== "string" || path === "") return null;
  if (typeof title !== "string") return null;
  const subtitle = raw["subtitle"];
  return { kind, path, title, ...(typeof subtitle === "string" ? { subtitle } : {}) };
}
