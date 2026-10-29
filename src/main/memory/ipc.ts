/**
 * 记忆库 IPC —— 四层契约的第 2 层。读在主进程（library 纯模块直读 JSONL，
 * 不经记忆服务——读不该付一次跨进程往返）；写转发给记忆服务（唯一写者），
 * mutate 注入的闭包负责保证服务在跑。入参校验在 requests.ts（可直测）。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { MemoryMutation, MemoryMutationOutcome } from "../../shared/memory.ts";
import { tokenOfScope } from "../../memory/entries.ts";
import { MemoryLibrary, type MemoryLibraryDeps } from "./library.ts";
import { parseEntriesRequest, parseMutation, parseSessionId } from "./requests.ts";

export function registerMemoryIpc(input: {
  /** 数据目录（<userData>/memory） */
  dir: string;
  /** 会话 / 工作区的只读连接（标题、作用域解析） */
  deps: MemoryLibraryDeps;
  /** 写操作转发（index.ts 注入：先确保服务在跑再 host.mutate） */
  mutate: (mutation: MemoryMutation) => Promise<MemoryMutationOutcome>;
}): void {
  const library = new MemoryLibrary(input.dir, input.deps);

  ipcMain.handle(ipcChannels.memoryScopes, () => library.scopes());

  ipcMain.handle(ipcChannels.memoryEntries, (_event, raw: unknown) =>
    library.listEntries(parseEntriesRequest(raw)).then((items) => ({ items })),
  );

  ipcMain.handle(ipcChannels.memorySession, (_event, raw: unknown) =>
    library.sessionView(parseSessionId(raw)),
  );

  ipcMain.handle(ipcChannels.memoryPending, () =>
    library.pending().then((items) => ({ items })),
  );

  ipcMain.handle(ipcChannels.memoryMutate, async (_event, raw: unknown) => {
    const mutation = parseMutation(raw);
    // addManual 补 scopeId：token 对得上工作区表就带（manual 条目的展示与拍板参考；
    // Home 作用域解不出就省略——寻址靠 token，scopeId 不是必需）
    const enriched =
      mutation.op === "addManual" && mutation.scopeId === undefined
        ? await withWorkspaceScopeId(input.deps, mutation)
        : mutation;
    return input.mutate(enriched);
  });
}

async function withWorkspaceScopeId<
  T extends { op: "addManual"; token: string },
>(deps: MemoryLibraryDeps, mutation: T): Promise<T & { scopeId?: string }> {
  const workspaces = await deps.workspaces().catch(() => []);
  const hit = workspaces.find((workspace) => tokenOfScope(workspace.id) === mutation.token);
  return hit === undefined ? mutation : { ...mutation, scopeId: hit.id };
}
