/**
 * 记忆库 IPC —— 四层契约的第 2 层。读在主进程（library 纯模块直读 JSONL，
 * 不经记忆服务——读不该付一次跨进程往返）；写转发给记忆服务（唯一写者），
 * mutate 注入的闭包负责保证服务在跑。入参校验在 requests.ts（可直测）。
 */
import { existsSync } from "node:fs";
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type {
  MemoryMutation,
  MemoryMutationOutcome,
  MemoryModelFileState,
  MemoryVectorSettings,
  MemoryVectorStatus,
} from "../../shared/memory.ts";
import { MEMORY_VECTOR_MODELS } from "../../shared/memory.ts";
import { tokenOfScope } from "../../memory/entries.ts";
import { MemoryLibrary, type MemoryLibraryDeps } from "./library.ts";
import { parseEntriesRequest, parseMutation, parseSessionId } from "./requests.ts";
import {
  deviceStatusOf,
  effectiveVectorSettings,
  modelFilePath,
  modelFileStateOf,
  parseVectorPatch,
} from "./vector-setup.ts";
import type { VectorStateReply } from "./host-core.ts";

export interface MemoryVectorDeps {
  /** 读 / 写设置里的 vector 子对象（读全量、写 patch） */
  readVectorSettings: () => Promise<Partial<MemoryVectorSettings> | undefined>;
  writeVectorSettings: (patch: Partial<MemoryVectorSettings>) => Promise<void>;
  /** userData 绝对路径（模型落 <userData>/vector/） */
  userDataDir: string;
  /** 设备事实（powerMonitor / os 在调用方采集） */
  device: () => { chip: string; memoryGb: number; onBattery: boolean; platform: string; arch: string };
  /** llama-server 备取候选（llama-bin.ts 产出，依序 existsSync） */
  llamaCandidates: () => { path: string; source: "env" | "packaged" | "dev" }[];
  /** 服务运行态（服务不在 / 超时回 null） */
  vectorState: () => Promise<VectorStateReply | null>;
  /** 下载中的最近一次进度（缓存给 status 用；null = 不在下载） */
  downloadState: () => MemoryModelFileState | null;
  /** 触发模型下载（源表与目标路径在这里算好交给服务） */
  startDownload: (model: (typeof MEMORY_VECTOR_MODELS)[number]) => Promise<{ ok: boolean; error?: string }>;
}

export function registerMemoryIpc(input: {
  /** 数据目录（<userData>/memory） */
  dir: string;
  /** 会话 / 工作区的只读连接（标题、作用域解析） */
  deps: MemoryLibraryDeps;
  /** 写操作转发（index.ts 注入：先确保服务在跑再 host.mutate） */
  mutate: (mutation: MemoryMutation) => Promise<MemoryMutationOutcome>;
  /** 向量召回的装配依赖（status / set / download 三条 IPC 用） */
  vector: MemoryVectorDeps;
}): void {
  const library = new MemoryLibrary(input.dir, input.deps);

  ipcMain.handle(ipcChannels.memoryScopes, () => library.scopes());

  ipcMain.handle(ipcChannels.memoryEntries, (_event, raw: unknown) =>
    library.listEntries(parseEntriesRequest(raw)).then((items) => ({ items })),
  );

  ipcMain.handle(ipcChannels.memorySession, (_event, raw: unknown) =>
    library.sessionView(parseSessionId(raw)),
  );

  ipcMain.handle(ipcChannels.memoryVectorStatus, async (): Promise<MemoryVectorStatus> => {
    const settings = effectiveVectorSettings(await input.vector.readVectorSettings());
    const model = MEMORY_VECTOR_MODELS.find((candidate) => candidate.id === settings.model)!;
    const ggufPath = modelFilePath(model, input.vector.userDataDir);
    const downloadState = input.vector.downloadState();
    const modelFile = modelFileStateOf({
      model,
      fileExists: existsSync(ggufPath),
      download: downloadState,
    });
    const llama = input.vector.llamaCandidates().find((candidate) => existsSync(candidate.path)) ?? null;
    const serviceState = await input.vector.vectorState();
    return {
      settings,
      device: deviceStatusOf(input.vector.device()),
      llamaServer: llama === null ? { found: false, path: null, source: null } : { found: true, path: llama.path, source: llama.source },
      modelFile,
      backfill: serviceState?.backfill ?? null,
      vectors: serviceState?.vectors ?? null,
    };
  });

  ipcMain.handle(ipcChannels.memoryVectorSet, async (_event, raw: unknown) => {
    const patch = parseVectorPatch(raw);
    await input.vector.writeVectorSettings(patch);
    return { ok: true };
  });

  ipcMain.handle(ipcChannels.memoryVectorDownload, async (): Promise<{ ok: boolean; error?: string }> => {
    const settings = effectiveVectorSettings(await input.vector.readVectorSettings());
    const model = MEMORY_VECTOR_MODELS.find((candidate) => candidate.id === settings.model)!;
    const ggufPath = modelFilePath(model, input.vector.userDataDir);
    if (existsSync(ggufPath)) return { ok: true }; // 幂等：已就绪不重下
    const downloading = input.vector.downloadState();
    if (downloading !== null && downloading.state === "downloading") return { ok: true };
    return input.vector.startDownload(model);
  });

  ipcMain.handle(ipcChannels.memoryMutate, async (_event, raw: unknown) => {
    const mutation = parseMutation(raw);
    // addManual 补 scopeId：token 对得上工作区表就带（manual 条目的展示参考；
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
