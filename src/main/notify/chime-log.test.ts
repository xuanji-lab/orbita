import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CHIME_SUBJECTS_MAX, CHIME_TITLE_MAX, ChimeLog, normalizeChimeLog } from "./chime-log.ts";

const dirs: string[] = [];
async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "chime-log-"));
  dirs.push(dir);
  return join(dir, "nested", "chime-log.jsonl");
}
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function readLines(file: string): Promise<unknown[]> {
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as unknown);
}

describe("normalizeChimeLog", () => {
  it("合法请求原样放行", () => {
    deepStrictEqual(normalizeChimeLog({ reason: "session-settled", subjects: [{ id: "a", title: "落实C" }] }), {
      reason: "session-settled",
      subjects: [{ id: "a", title: "落实C" }],
    });
  });

  it("未知 reason / 非对象一律拒", () => {
    strictEqual(normalizeChimeLog({ reason: "boom", subjects: [] }), null);
    strictEqual(normalizeChimeLog("session-settled"), null);
    strictEqual(normalizeChimeLog(null), null);
  });

  it("坏 subject 单条丢弃，缺 subjects 当空，标题截断、人数封顶", () => {
    deepStrictEqual(normalizeChimeLog({ reason: "focus-done" }), { reason: "focus-done", subjects: [] });
    const longTitle = "长".repeat(CHIME_TITLE_MAX + 10);
    const result = normalizeChimeLog({
      reason: "session-settled",
      subjects: [{ id: "" }, { title: "无 id" }, 42, { id: "b", title: longTitle }, { id: "c", title: 7 }],
    });
    deepStrictEqual(result?.subjects, [
      { id: "b", title: "长".repeat(CHIME_TITLE_MAX) },
      { id: "c", title: "" },
    ]);
    const many = Array.from({ length: CHIME_SUBJECTS_MAX + 5 }, (_, i) => ({ id: `s${i}`, title: "" }));
    strictEqual(normalizeChimeLog({ reason: "session-settled", subjects: many })?.subjects.length, CHIME_SUBJECTS_MAX);
  });
});

describe("ChimeLog", () => {
  it("一声一行，时刻由主进程打；目录不存在时自己建", async () => {
    const file = await tempFile();
    const log = new ChimeLog(file);
    await log.append({ reason: "session-settled", subjects: [{ id: "a", title: "A" }] }, new Date("2026-10-29T08:03:09Z"));
    await log.append({ reason: "focus-done", subjects: [] }, new Date("2026-10-29T08:09:06Z"));
    deepStrictEqual(await readLines(file), [
      { at: "2026-10-29T08:03:09.000Z", reason: "session-settled", subjects: [{ id: "a", title: "A" }] },
      { at: "2026-10-29T08:09:06.000Z", reason: "focus-done", subjects: [] },
    ]);
  });

  it("并发追加不丢行（串行写入链）", async () => {
    const file = await tempFile();
    const log = new ChimeLog(file, 300);
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => log.append({ reason: "session-settled", subjects: [{ id: `s${i}`, title: "" }] })),
    );
    const lines = await readLines(file);
    // 裁剪会丢旧行，但最后一声一定在、且每行都是完整 JSON
    const last = lines[lines.length - 1] as { subjects: { id: string }[] };
    strictEqual(last.subjects[0]?.id, "s29");
  });

  it("过上限只留后一半的行，留下的是最近的", async () => {
    const file = await tempFile();
    const log = new ChimeLog(file, 1024);
    await log.append({ reason: "focus-done", subjects: [] });
    const old = Array.from({ length: 40 }, (_, i) => JSON.stringify({ at: "x", reason: "focus-done", subjects: [], n: i }));
    await writeFile(file, `${old.join("\n")}\n`);
    await log.append({ reason: "session-settled", subjects: [{ id: "new", title: "" }] });
    const lines = (await readLines(file)) as { n?: number; subjects: { id: string }[] }[];
    strictEqual(lines[0]?.n, 20);
    strictEqual(lines[lines.length - 1]?.subjects[0]?.id, "new");
    strictEqual(lines.length, 21);
    strictEqual((await stat(file)).size < 1024 * 2, true);
  });
});
