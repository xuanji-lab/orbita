/**
 * agent 的 Office 工具：`read_office` / `edit_office`。
 *
 * 形态与 latex-tools.ts 完全同构：这一层**只翻译**——参数 → officeRequest → 等 officeResult
 * → pi 工具结果。OfficeCLI 子进程、备份、改动清单与并发排队全在主进程（office/service.ts）。
 *
 * 为什么模型不该直接改 .xlsx / .pptx（走 write / edit / bash）：
 *   1. 这两个格式是 zip + OOXML，改坏一个字节就是一个打不开的文件；
 *   2. 用户是在预览里**点了一个格子 / 一个形状**才让你改的——坐标系只有 officecli 的
 *      DOM path 一个，其它改法都要模型自己数格子；
 *   3. 我们的预览与「改动清单 / 整批回退」只认 batch 这条路（谁改的要能一键撤回）。
 *
 * 工具成对出现：`edit_office` 没有读的能力时，模型只能猜值。`read_office` 用 officecli
 * 自己的 `get` 输出（路径 + 值），与预览里的 `data-path` 同一个坐标系。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  normalizeOfficePath,
  OFFICE_MAX_OPS,
  officeFormatOf,
  type OfficeAgentOutcome,
  type OfficeAgentRequest,
  type OfficeOp,
} from "../shared/office.ts";
import type { RequestBroker } from "./request-broker.ts";

/** 本工具的名字。权限档描述与测试都认这一份 */
export const OFFICE_TOOL_NAMES = ["read_office", "edit_office"] as const;

/**
 * 等回执的上限：验活（15 s，最坏每个候选都挂死）+ 读旧值（60 s）+ 写（60 s）+ 余量。
 * RequestBroker 默认 30 秒远远不够——用默认值的话，第 31 秒工具就拿到「主进程没回执」，
 * 而 officecli 还在跑。这里只是「主进程失联」的兜底，真正的上限在主进程的四个超时常量
 * （shared/office.ts），到点会杀进程树并回一句可读的超时原因。
 */
const BROKER_TIMEOUT_MS = 240_000;

/** read_office 一次最多回多少字符（与 read_docx 同量级：模型一次读得完的量） */
const READ_MAX_CHARS = 20_000;

/** 只收 string / number / boolean 的 props（别的形状模型给不出来，也不该透传） */
function cleanProps(value: unknown): Record<string, string | number | boolean> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") out[key] = entry;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** 模型给的 ops → 契约里的 OfficeOp[]（逐项校验，错误指明第几项） */
export function parseOfficeOps(raw: unknown): { ok: true; ops: OfficeOp[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: '"ops" must be a non-empty array' };
  if (raw.length > OFFICE_MAX_OPS) {
    return { ok: false, error: `Too many ops (${raw.length}); at most ${OFFICE_MAX_OPS} per call — split the edit` };
  }
  const ops: OfficeOp[] = [];
  for (const [index, entry] of raw.entries()) {
    const where = `ops[${index}]`;
    if (typeof entry !== "object" || entry === null) return { ok: false, error: `${where} must be an object` };
    const record = entry as Record<string, unknown>;
    const op = record["op"];
    if (op !== "set" && op !== "add" && op !== "remove") {
      return { ok: false, error: `${where}.op must be "set", "add" or "remove"` };
    }
    const rawPath = typeof record["path"] === "string" ? record["path"] : "";
    const path = normalizeOfficePath(rawPath);
    if (path === null) {
      return {
        ok: false,
        error: `${where}.path must be a /-rooted path (e.g. /Sheet1/B2, /slide[3]/table[@id=3]) — got "${rawPath}"`,
      };
    }
    const type = typeof record["type"] === "string" ? record["type"].trim() : "";
    if (op === "add" && type === "") return { ok: false, error: `${where}.type is required for add (e.g. shape, textbox, slide)` };
    const props = cleanProps(record["props"]);
    if (op !== "remove" && props === undefined) return { ok: false, error: `${where}.props is required for ${op}` };
    ops.push({
      op,
      path,
      ...(type === "" ? {} : { type }),
      ...(props === undefined ? {} : { props }),
    });
  }
  return { ok: true, ops };
}

/** 结果 → 给模型的正文。每段都要回答「下一步干什么」，不是状态回显 */
function describeEdit(outcome: Extract<OfficeAgentOutcome, { ok: true; kind: "edit" }>): string {
  const seconds = (outcome.elapsedMs / 1000).toFixed(1);
  const lines: string[] = [
    `Office edit applied: ${outcome.items.length} change(s) in ${seconds}s (OfficeCLI ${outcome.version}).`,
  ];
  for (const item of outcome.items.slice(0, 20)) {
    const before = item.before === null ? "∅" : item.before;
    const after = item.after === null ? "∅" : item.after;
    lines.push(`- ${item.command} ${item.path}: ${before} → ${after}`);
  }
  if (outcome.items.length > 20) lines.push(`- … and ${outcome.items.length - 20} more (see the change list in the preview panel)`);
  if (outcome.failures.length > 0) {
    lines.push(`Failed (not applied): ${outcome.failures.map((f) => `${f.path} — ${f.error}`).join("; ")}`);
  }
  if (outcome.canRevert) {
    lines.push("The document preview refreshes automatically; every change is listed in the preview panel with a one-click revert. Tell the user what changed.");
  } else {
    lines.push("Warning: this batch has no backup (the session workbench is unavailable), so the user cannot revert it in one click.");
  }
  return lines.join("\n");
}

export interface OfficeToolContext {
  /** 会话 cwd：path 相对路径的解析基准（主进程按同一基准解析并授权） */
  cwd: string;
}

export function createOfficeTools(
  broker: Pick<RequestBroker, "request">,
  sessionId: string,
  context: OfficeToolContext,
): ToolDefinition[] {
  /** 发请求并等回执；这一轮被停掉（abort）就立刻放手（latex-tools.ts 同款） */
  const call = async (request: OfficeAgentRequest, signal: AbortSignal | undefined): Promise<OfficeAgentOutcome> => {
    if (signal?.aborted === true) throw new Error("Stopped");
    const pending = broker.request<OfficeAgentOutcome>(
      { type: "officeRequest", sessionId, request },
      BROKER_TIMEOUT_MS,
    );
    if (signal === undefined) return pending;
    return Promise.race([
      pending,
      new Promise<never>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("Stopped")), { once: true }),
      ),
    ]);
  };

  const resolveFile = (raw: unknown): string => {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value === "") throw new Error('"path" is required (the .xlsx / .pptx file)');
    if (officeFormatOf(value) === null) throw new Error(`Only .xlsx and .pptx can be read / edited here: ${value}`);
    // 相对路径按会话 cwd 解析（主进程还要再核一遍授权）；绝对路径原样交给它
    return /^([a-zA-Z]:[\\/]|[\\/]|~)/.test(value) ? value : `${context.cwd}/${value}`;
  };

  const readOffice: ToolDefinition = {
    name: "read_office",
    label: "read_office",
    description:
      "Read nodes of an .xlsx / .pptx by officecli document path: paths, values, element properties — " +
      "the same paths the app's preview uses (a clicked cell shows up as /Sheet1/B2, a shape as " +
      "/slide[3]/table[@id=3]). Use it before edit_office whenever you need the surrounding values or the " +
      "exact path of a slide / shape / table. Default path is / (top level), depth 2.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The .xlsx / .pptx file (absolute, or relative to the session working directory)." },
        node: {
          type: "string",
          description:
            'Document path to read: default "/". Examples: "/Sheet1" (a sheet), "/Sheet1/A1:B5" (a range), ' +
            '"/slide[3]" (one slide).',
        },
        depth: { type: "number", description: "How many levels of children to include (1-6, default 2)." },
      },
      required: ["path"],
    } as never,
    async execute(_toolCallId, params, signal) {
      const args = (params ?? {}) as Record<string, unknown>;
      const file = resolveFile(args["path"]);
      const node = typeof args["node"] === "string" && args["node"].trim() !== "" ? args["node"].trim() : "/";
      if (normalizeOfficePath(node) === null) throw new Error(`"node" must be a /-rooted document path (got "${node}")`);
      const depth = typeof args["depth"] === "number" && Number.isFinite(args["depth"]) ? args["depth"] : 2;
      const outcome = await call({ kind: "read", file, path: node, depth }, signal);
      if (!outcome.ok) throw new Error(outcome.error);
      if (outcome.kind !== "read") throw new Error("Unexpected reply from the app");
      const text = outcome.text.length > READ_MAX_CHARS ? `${outcome.text.slice(0, READ_MAX_CHARS)}\n… (truncated; read a narrower node)` : outcome.text;
      return { content: [{ type: "text" as const, text: text.trim() === "" ? "(no output)" : text }], details: {} };
    },
  };

  const editOffice: ToolDefinition = {
    name: "edit_office",
    label: "edit_office",
    description:
      "Edit an .xlsx / .pptx with officecli batch: set / add / remove nodes addressed by document path. " +
      "Never edit these files with write / edit / bash — this tool writes through OfficeCLI (one atomic batch), " +
      "backs the file up first, and every change shows up in the preview's change list with a one-click revert. " +
      "op examples: " +
      '{op:"set",path:"/Sheet1/B2",props:{value:42}} (xlsx cell), ' +
      '{op:"set",path:"/slide[1]/shape[@id=100000]",props:{text:"Q3 results"}} (pptx text), ' +
      '{op:"add",path:"/slide[1]",type:"textbox",props:{text:"Hi",x:"2cm",y:"1cm",w:"20cm",h:"3cm"}} (path = parent), ' +
      '{op:"remove",path:"/slide[2]/shape[@id=100004]"}. ' +
      "props use officecli property names (value, formula, numberformat, bold, text, x, y, width, height, size…). " +
      "A batch is atomic: if one op fails nothing is written, so retry with the failing op fixed.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The .xlsx / .pptx file (absolute, or relative to the session working directory)." },
        ops: {
          type: "array",
          description: `Operations, 1-${OFFICE_MAX_OPS} per call. Each: {op:"set"|"add"|"remove", path, type?, props?}.`,
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["set", "add", "remove"] },
              path: { type: "string", description: "Target path (for add: the parent to add into)." },
              type: { type: "string", description: 'Element type for add: "slide", "shape", "textbox", "table" …' },
              props: { type: "object", description: "officecli properties, e.g. {\"value\":42} or {\"text\":\"Hi\",\"x\":\"2cm\"}." },
            },
            required: ["op", "path"],
          },
        },
      },
      required: ["path", "ops"],
    } as never,
    async execute(_toolCallId, params, signal) {
      const args = (params ?? {}) as Record<string, unknown>;
      const file = resolveFile(args["path"]);
      const parsed = parseOfficeOps(args["ops"]);
      if (!parsed.ok) throw new Error(parsed.error);
      const outcome = await call({ kind: "edit", file, ops: parsed.ops }, signal);
      if (!outcome.ok) throw new Error(outcome.error);
      if (outcome.kind !== "edit") throw new Error("Unexpected reply from the app");
      return { content: [{ type: "text" as const, text: describeEdit(outcome) }], details: {} };
    },
  };

  return [readOffice, editOffice];
}
