/**
 * 意图系统的产出文件 —— 会话工作台下的「意图系统/上下文.md」与「上下文.jsonl」。
 *
 * 契约 7 起 intent-lab（服务端）是这两份文件的作者：done / feedback 带回全文，
 * Orbita 原样覆盖写——本地不拼内容，只负责落盘与删除（会话回退作废后）。
 * 写失败由调用方兜住只记日志，绝不挡回答。
 *
 * 纯模块：IO 只有文本原子写（临时文件 + rename）；不 import electron。
 */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 产出文件 md 的路径（会话工作台下的固定位置；文件面板按目录树自然显示它）。 */
export function intentContextPath(workbenchDir: string): string {
  return join(workbenchDir, "意图系统", "上下文.md");
}

/**
 * done / feedback 带回的上下文文件全文**覆盖写**到会话工作台 意图系统/上下文.md
 * 与 上下文.jsonl。临时文件 + rename 的原子写（AGENTS 纪律）。
 */
export async function writeIntentContextFiles(
  workbenchDir: string,
  context: { md: string; jsonl: string },
): Promise<void> {
  const dir = join(workbenchDir, "意图系统");
  await mkdir(dir, { recursive: true });
  const mdTmp = join(dir, "上下文.md.tmp");
  await writeFile(mdTmp, context.md, "utf8");
  await rename(mdTmp, join(dir, "上下文.md"));
  const jsonlTmp = join(dir, "上下文.jsonl.tmp");
  await writeFile(jsonlTmp, context.jsonl, "utf8");
  await rename(jsonlTmp, join(dir, "上下文.jsonl"));
}

/**
 * 作废（契约 v6）：该会话的上下文文件在服务端已不复存在（小节全部被回退掉）——
 * 本地副本一并删掉，免得回答模型按附件读到一份过时的世界。md 与 jsonl 都删；
 * 目录留着。失败抛给调用方（只记日志，不影响回退）。
 */
export async function removeIntentContextFiles(workbenchDir: string): Promise<void> {
  const dir = join(workbenchDir, "意图系统");
  await rm(join(dir, "上下文.md"), { force: true });
  await rm(join(dir, "上下文.jsonl"), { force: true });
}
