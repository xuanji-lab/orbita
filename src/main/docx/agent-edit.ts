/**
 * agent 的 `edit_docx`：主进程这一层（白名单 + 找窗口 + 回执中转）。
 *
 * **docx 的唯一写入口是 renderer 里活着的那个编辑器**（`applyAIEditOperations`）。agent
 * 直接改磁盘会从两头发作：文件面板里那份文档带着用户未保存的改动，磁盘上的 hash 早过时了；
 * 写盘再撞 #308 的 `expectedHash` 冲突，用户改了半天的段落就没了。所以这里什么都不写，
 * 只把请求送进窗口（`dispatchDocxEdit`），等 renderer 回执。
 *
 * 白名单与 `fs:read` 同一道：路径必须落在这条会话的根之内（realpath 之后判，改名的
 * 软链接一样被拒），且只认 `.docx`。
 */
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { systemUserName } from "./metadata.ts";
import {
  isDocxFile,
  type DocxAgentEditRequest,
  type DocxEditOutcome,
  type DocxEditRequestMessage,
} from "../../shared/docx.ts";
import type { FileRoot } from "../../shared/files.ts";
import { isInside } from "../path-boundary.ts";

export interface DocxEditDeps {
  /** 这条会话允许的根（主进程现算，见 resolveFileRoots） */
  roots: readonly FileRoot[];
  /** 把请求交给 renderer（测试注入一个假的） */
  dispatch: (message: DocxEditRequestMessage) => Promise<DocxEditOutcome>;
}

/** 路径 → 白名单内的真实路径；不在根内 / 不是 docx / 不存在都回一句人话 */
async function resolveTarget(roots: readonly FileRoot[], path: string): Promise<{ path: string } | { error: string }> {
  if (!isAbsolute(path)) return { error: `需要一个绝对路径：${path}` };
  if (!isDocxFile(path)) return { error: `只能编辑 Word 文档（.docx）：${path}` };
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    return { error: `这份文档不在磁盘上了（或无权读取）：${path}` };
  }
  const allowed = await Promise.all(
    roots.map(async (root) => {
      if (!root.exists) return null;
      try {
        return await realpath(root.path);
      } catch {
        return null;
      }
    }),
  );
  if (!allowed.some((root) => root !== null && isInside(root, real))) {
    return { error: `这份文档不在当前会话的可写目录里：${path}` };
  }
  return { path: real };
}

/**
 * 一条 `edit_docx` 请求的完整处理（任何路径都回值、不抛——抛出去 agent 进程里那次
 * 工具调用就只能拿到一句 Electron 的原始报错）。
 */
export async function applyDocxEditRequest(
  deps: DocxEditDeps,
  event: { sessionId: string; workspaceId: string | null; request: DocxAgentEditRequest },
): Promise<DocxEditOutcome> {
  const target = await resolveTarget(deps.roots, event.request.path);
  if ("error" in target) return { ok: false, reason: "invalid", error: target.error };
  const message: DocxEditRequestMessage = {
    requestId: `docx-edit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: event.sessionId,
    // 修订署名是用户本人（与保存时的作者戳同一口径，见 metadata.ts）；模型不能指定
    author: systemUserName(),
    // 路径已在主进程核准（realpath 之后），renderer 拿它去认「是不是我这份文档」
    request: { ...event.request, path: target.path, sessionId: event.sessionId, workspaceId: event.workspaceId },
  };
  return deps.dispatch(message);
}
