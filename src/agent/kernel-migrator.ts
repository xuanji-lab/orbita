/**
 * 用完即退的迁移进程：把一条旧会话的 pi 本子迁进它的库，回一个结果就退出（electron.vite.config 的 main 多入口之一，
 * kernel 进程按需用 child_process.fork 拉起它，见 forkMigrator）。
 *
 * 为什么单开一个进程：迁移要把整本本子流过一遍、逐批写进 SQLite，进程的内存高水位（V8 大对象区、分配器缓存）
 * 迁完也不还给系统。在 kernel 进程里迁，kernel 的峰值就被迁移顶上去，而且一直到闲置回收才落下来
 * （第四步验收：92 MB 的会话 kernel 峰值 557 MB，旧内核 406 MB）。在这里迁，迁完进程退出，高水位随之归零；
 * kernel 进程只付打开迁好的会话、发这一轮请求的那一段。
 *
 * 协议（Node 的 IPC 通道）：收一条 MigratorRequest，回一条 MigratorReply，然后退出。父进程断开（kernel 退出 /
 * 被杀）就立即退出——迁到一半的那份在墓碑里，库下次打开时清掉（kernel.ts 的 migrate）。
 */
import { createModels } from "@earendil-works/pi-ai/models";
import { KernelPool, type KernelOpenResult, type MigratorReply, type MigratorRequest } from "./kernel.ts";

type Channel = { send?: (message: unknown, callback?: () => void) => boolean; on(event: "message" | "disconnect", listener: (message: unknown) => void): unknown };

const channel = process as unknown as Channel;

async function migrateOnce(request: MigratorRequest, gc: (() => void) | undefined): Promise<KernelOpenResult> {
  const pool = new KernelPool({
    dir: request.dir,
    models: () => createModels(),
    log: (text) => console.error(text),
    // 每提交一批报一次进展：父进程据此判断没卡死（forkMigrator 的 stallMs）
    onMigrationProgress: () => channel.send?.({ type: "progress" } satisfies MigratorReply),
    ...(gc === undefined ? {} : { collectGarbage: gc }),
  });
  try {
    return await pool.open({ library: request.library, sessionId: request.sessionId, legacy: { piSessionFile: request.piSessionFile }, agent: { ...request.agent, provider: null } });
  } finally {
    await pool.closeAll();
  }
}

if (typeof channel.send === "function") {
  const exposed = (globalThis as { gc?: () => void }).gc;
  channel.on("disconnect", () => process.exit(1));
  channel.on("message", (message) => {
    void migrateOnce(message as MigratorRequest, exposed)
      .then((result): MigratorReply => ({ type: "result", result }))
      .catch((error: unknown): MigratorReply => ({ type: "error", message: error instanceof Error ? error.message : String(error) }))
      .then((reply) => channel.send?.(reply, () => process.exit(0)));
  });
}
