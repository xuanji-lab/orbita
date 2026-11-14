/**
 * agent 的 office 请求 → 授权 → OfficeService → 回执载荷。
 *
 * 与 latex/agent-requests.ts 同一条边界：**文件读写与子进程都在主进程**，agent 进程
 * 只剩「工具定义 → requestId 问答」一层薄包装。授权用与 LaTeX / 终端同一份根名单
 * （工作区 cwd + 附加目录），另加本会话的工作台——那是会话私有的草稿区，模型本来就能写。
 *
 * 参数校验在这里做完再进 service：路径必须是 `/` 开头的 DOM path、`add` 必须有 type、
 * 一次最多 OFFICE_MAX_OPS 项。这些是模型最常拼错的地方，报错要说清是哪一项错了。
 */
import { realpathInside } from "../path-boundary.ts";
import {
  normalizeOfficePath,
  OFFICE_MAX_OPS,
  officeFormatOf,
  type OfficeAgentOutcome,
  type OfficeAgentRequest,
} from "../../shared/office.ts";
import type { OfficeService } from "./service.ts";
import type { SessionRootsSource, WorkspaceRootsSource } from "../agent/session-roots.ts";
import { sessionAuthorizedRoots } from "../agent/session-roots.ts";

/** 会话工作台目录（备份落在这里）。SessionStore 结构上满足它，测试不必造整个 store */
export interface OfficeWorkbenchSource {
  workbenchPath(sessionId: string): string;
}

/** 校验并整理 ops；有问题回一句指名道姓的错误 */
function validateOps(request: Extract<OfficeAgentRequest, { kind: "edit" }>): { ok: true } | { ok: false; error: string } {
  if (request.ops.length === 0) return { ok: false, error: "ops must contain at least one operation" };
  if (request.ops.length > OFFICE_MAX_OPS) {
    return { ok: false, error: `Too many operations (${request.ops.length}); split them into batches of at most ${OFFICE_MAX_OPS}` };
  }
  for (const [index, op] of request.ops.entries()) {
    const where = `ops[${index}]`;
    if (op.op !== "set" && op.op !== "add" && op.op !== "remove") {
      return { ok: false, error: `${where}.op must be "set", "add" or "remove"` };
    }
    if (normalizeOfficePath(op.path) === null) {
      return { ok: false, error: `${where}.path must be a /-rooted DOCX-style path such as /Sheet1/B2 or /slide[1]/shape[@id=2] (got "${op.path}")` };
    }
    if (op.op === "add" && (op.type ?? "").trim() === "") {
      return { ok: false, error: `${where}.type is required for add (e.g. "slide", "shape", "table")` };
    }
  }
  return { ok: true };
}

/**
 * 一次 office 请求。**任何路径都回执**——挂着不回的话 agent 进程里那次工具调用
 * 会永远等下去（terminalRequest 同一条纪律）。
 */
export async function applyOfficeRequest(
  office: OfficeService,
  sessions: SessionRootsSource & OfficeWorkbenchSource,
  workspaces: WorkspaceRootsSource,
  event: { sessionId: string; request: OfficeAgentRequest },
): Promise<OfficeAgentOutcome> {
  try {
    const { request } = event;
    if (officeFormatOf(request.file) === null) {
      return { ok: false, error: `Only .xlsx and .pptx are handled here (got "${request.file}")` };
    }
    const roots = await sessionAuthorizedRoots(sessions, workspaces, event.sessionId);
    // 工作台也放行（会话自己的草稿区；文件面板同样能看到它）
    let workbench: string | null = null;
    try {
      workbench = sessions.workbenchPath(event.sessionId);
    } catch {
      workbench = null;
    }
    const real = await realpathInside(request.file, [...roots, ...(workbench === null ? [] : [workbench])]);
    if (real === null) {
      return {
        ok: false,
        error: `"${request.file}" is outside the session's authorized folders (workspace, attached directories, workbench) or does not exist`,
      };
    }
    if (request.kind === "read") {
      const path = request.path === undefined ? "/" : normalizeOfficePath(request.path);
      if (path === null) return { ok: false, error: `path must be a /-rooted document path (got "${String(request.path)}")` };
      const depth = Number.isFinite(request.depth) ? Math.max(1, Math.min(6, Math.floor(request.depth ?? 2))) : 2;
      const result = await office.read(real, path, depth);
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, kind: "read", text: result.text };
    }
    const valid = validateOps(request);
    if (!valid.ok) return { ok: false, error: valid.error };
    return await office.edit(event.sessionId, real, request.ops);
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}
