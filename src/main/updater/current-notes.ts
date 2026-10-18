/**
 * 「本版更新内容」——装上以后还能看的那份说明。
 *
 * 更新源（GitHub Releases）只会告诉应用「有个新版本，它带来了这些」。版本一旦装上，
 * 那条发布就不再是「新版本」了，用户再想问「我现在这版带来了什么」就没有出处——
 * 于是下载完成时把 `{ version, releaseNotes }` 留在 userData 的一个 JSON 上，
 * 下次启动版本号对得上就把它当作「本版更新内容」读回来（读的地方见 service.ts）。
 *
 * **读的一侧一律不抛错**：文件不存在、半截 JSON、形状不对、版本号不是当前这一版——
 * 全都返回 null（= 没有说明，界面不画那行展开器）。这是设置页上一行可有可无的说明，
 * 它出问题不该让更新卡整块画不出来。
 *
 * 写的一侧不在这里兜错：调用方接（下载已经完成了，说明没落盘只是少一段可读内容）。
 */
import { readFile } from "node:fs/promises";
import type { UpdateNote } from "../../shared/updater.ts";
import { writeJsonAtomic } from "../atomic-write.ts";

/**
 * 文件名。userData 根下的一个 JSON——和别的配置一样是可移植文件（AGENTS.md「本地优先」），
 * 不引数据库。
 */
export const CURRENT_NOTES_FILE = "update-notes.json";

/**
 * 把某一版的说明原子落到 `filePath`（临时文件 + rename，见 atomic-write.ts）。
 * **记录只有一份**：下载新版本时覆盖旧的——盘上留着的永远是「下一个要装的版本」的说明，
 * 装完重启它就变成「当前版本」的说明。
 */
export async function saveCurrentNotes(
  filePath: string,
  version: string,
  releaseNotes: readonly UpdateNote[] | null,
): Promise<void> {
  await writeJsonAtomic(filePath, { version, releaseNotes });
}

/** 一条说明的形状对得上吗：`icon` 是字符串或 null、`text` 是字符串（正文不能为空） */
function toNote(value: unknown): UpdateNote | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const text = record["text"];
  if (typeof text !== "string" || text === "") return null;
  const icon = record["icon"];
  if (icon !== null && typeof icon !== "string") return null;
  return { icon: icon ?? null, text };
}

/** 数组形状的说明：单条不合格就丢那一条（手写的验收文件里多一条空行不该毁掉整份） */
function toNotes(value: unknown): UpdateNote[] | null {
  if (!Array.isArray(value)) return null;
  const notes: UpdateNote[] = [];
  for (const item of value) {
    const note = toNote(item);
    if (note !== null) notes.push(note);
  }
  return notes.length === 0 ? null : notes;
}

/**
 * 读回「本版更新内容」：`version` 与当前应用版本一致才认（不一致 = 存的是别的版本的说明，
 * 当没有）。文件不存在 / 读不了 / JSON 坏了 / 形状不对，全部 null。
 */
export async function readCurrentNotes(filePath: string, version: string): Promise<readonly UpdateNote[] | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    // 绝大多数机器上这个文件根本不存在（没更新过）：不是异常路径，安静返回
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(`[更新] 本版更新内容读不出来（JSON 坏了），当作没有：`, error);
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record["version"] !== version) return null;
  return toNotes(record["releaseNotes"]);
}
