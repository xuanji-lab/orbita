/**
 * docx 编辑宿主登记表：**谁在这台窗口里开着那份文档，由谁去写**。
 *
 * 主进程把 agent 的 `edit_docx` 请求推过来（`api.docx.onEditRequest`），这里按路径找到
 * 当前挂着的 docx 编辑器，把请求交给它（`applyDocxEdit`），再用 `replyEdit` 把结论送回去。
 * 没开着的文档一律回 `not-open`——**没有任何兜底写盘**：docx 的权威副本在编辑器内存里。
 *
 * 只登记当前可见的那一个（文件面板同一时刻只渲染激活标签的预览），所以这里是一张
 * 「路径 → 宿主」的小表，不做多窗口 / 多实例调度。
 */
import { sameDocxPath, type DocxAgentEditRequest, type DocxEditOutcome } from "@shared/docx";
import type { DocxEditRequestMessage } from "@shared/docx";
import { api } from "../../api";

export interface DocxEditHost {
  /** 宿主开着的那份文档（与 `request.dir` 同一个字符串） */
  path: string;
  /**
   * 把一条请求写进活编辑器；抛错由这里兜成 `engine` 失败，别让主进程等到超时。
   * `author` 是主进程给的修订署名（用户本人，模型不能选）。
   */
  apply: (request: DocxAgentEditRequest, author: string) => DocxEditOutcome | Promise<DocxEditOutcome>;
}

const hosts: DocxEditHost[] = [];
let unsubscribe: (() => void) | null = null;

function hostFor(path: string): DocxEditHost | null {
  // 后登记的优先（同一个路径重挂时旧的退订回调可能还没跑完）
  for (let i = hosts.length - 1; i >= 0; i -= 1) {
    const host = hosts[i] as DocxEditHost;
    if (sameDocxPath(host.path, path)) return host;
  }
  return null;
}

async function handle(message: DocxEditRequestMessage): Promise<void> {
  const host = hostFor(message.request.path);
  if (host === null) {
    api.docx.replyEdit({
      requestId: message.requestId,
      outcome: {
        ok: false,
        reason: "not-open",
        error: `这份文档现在没有在应用内打开：${message.request.path}。请让用户在文件面板里打开它再改。`,
      },
    });
    return;
  }
  let outcome: DocxEditOutcome;
  try {
    outcome = await host.apply(message.request, message.author);
  } catch (cause) {
    outcome = { ok: false, reason: "engine", error: cause instanceof Error ? cause.message : String(cause) };
  }
  api.docx.replyEdit({ requestId: message.requestId, outcome });
}

function ensureSubscribed(): void {
  if (unsubscribe !== null) return;
  unsubscribe = api.docx.onEditRequest((message) => {
    void handle(message);
  });
}

/** 登记一个 host；返回值必须在该编辑器卸载时调用（否则请求会投给已经卸掉的视图） */
export function registerDocxEditHost(host: DocxEditHost): () => void {
  ensureSubscribed();
  const entry: DocxEditHost = host;
  hosts.push(entry);
  return () => {
    const at = hosts.indexOf(entry);
    if (at !== -1) hosts.splice(at, 1);
  };
}
