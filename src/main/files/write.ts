/**
 * `fs:write` 的实做（契约在 `shared/files.ts`）。**纯模块**（同 read.ts / list.ts 的先例）：
 * 不 import electron，白名单由 ipc.ts 校验完才把真实路径传进来，`node --test` 直接可测。
 *
 * 三条纪律：
 *  1. **只改已有文件**：stat 不到 / 不是文件都拒绝。编辑器是「打开的文件」，不是新建入口
 *     （agent 的 write 工具另有通道）。
 *  2. **写前重读**：`expectedHash` 与盘上当前内容的指纹不符 → 回 conflict，一个字都不写。
 *     这是「你正在打字时 agent 改了同一个文件」的兜底：迟到的自动保存不能覆盖它。
 *  3. **原子写**（临时文件 + rename，复用 atomic-write.ts）：编译进程 / 编辑器 / agent
 *     任何一方读到的都是完整的旧版或完整的新版，不会是半截源码。
 *
 * 同一路径的写请求在进程内排队：两个标签页 / 自动保存与手动编译前保存撞在一起时，
 * 「读 - 比对 - 写」不会交错（否则两边都通过比对、后写的赢，前一个的基线就错了）。
 */
import { readFile, stat } from "node:fs/promises";
import { writeTextAtomic } from "../atomic-write.ts";
import { contentHash, EDITOR_WRITE_LIMIT, type FileWriteResult } from "../../shared/files.ts";

/** 正在进行的写：键是路径，值是这条路径最后那次写完成的 Promise */
const writeChains = new Map<string, Promise<unknown>>();

function queueWrite<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(path) ?? Promise.resolve();
  const next = previous.then(task, task);
  // 队尾只关心「排到哪了」；失败由调用方接，不能让一次失败卡死这条路径后面的写
  const tail = next.catch(() => undefined);
  writeChains.set(path, tail);
  void tail.then(() => {
    if (writeChains.get(path) === tail) writeChains.delete(path);
  });
  return next;
}

/**
 * 把编辑器里的文本写回 `path`。
 *
 * `expectedHash === null` 是**跳过比对**的强制写（保留着给真正的「我知道我在覆盖」用）。
 * 编辑器的「保留我的」不走它：它带的是**冲突那一刻**的盘上指纹——盘上在那之后又被改过
 * 就再冲突一次，不替用户把更新的一份抹掉。除这两种情况外，所有写都必须过冲突检查。
 */
export async function writeEditedFile(
  path: string,
  text: string,
  expectedHash: string | null,
): Promise<FileWriteResult> {
  return queueWrite(path, async (): Promise<FileWriteResult> => {
    const before = await stat(path);
    if (!before.isFile()) throw new Error(`Not a file: ${path}`);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > EDITOR_WRITE_LIMIT) {
      return { kind: "too-large", limit: EDITOR_WRITE_LIMIT, size: bytes };
    }
    if (expectedHash !== null) {
      const current = await readFile(path, "utf8");
      const currentHash = contentHash(current);
      if (currentHash !== expectedHash) {
        return {
          kind: "conflict",
          text: current,
          hash: currentHash,
          modifiedAt: before.mtimeMs,
          size: before.size,
        };
      }
    }
    await writeTextAtomic(path, text);
    const after = await stat(path);
    return {
      kind: "written",
      modifiedAt: after.mtimeMs,
      hash: contentHash(text),
      size: bytes,
    };
  });
}
