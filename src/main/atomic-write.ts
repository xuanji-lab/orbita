/**
 * 原子写 —— 临时文件 + rename。
 *
 * AGENTS.md：「配置与会话元数据走原子写（临时文件 + rename），禁裸 `writeFileSync`」。
 * 理由是 rename 在同一文件系统内是原子的：进程在写到一半时被杀，磁盘上要么是旧的完整文件、
 * 要么是新的完整文件，**不会是半截 JSON**。半截 JSON 会让下次启动读不出配置。
 *
 * 抽到这里是因为已经有三个消费者（provider 除外的 settings / workspace / session）；
 * 在此之前它是三份逐字相同的代码。
 */
import { randomBytes } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** 把 `value` 序列化成带尾换行的格式化 JSON，原子落到 `filePath`。 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(filePath: string, text: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  // 随机后缀：同一目标被并发写时两个临时文件不会互相踩
  const tempPath = `${filePath}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tempPath, text, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
