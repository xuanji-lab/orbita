import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { KernelPool, type KernelAgent } from "./kernel.ts";
import { addTombstones, purgeFile, purgeTombstoned } from "./kernel-purge.ts";

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const AGENT: KernelAgent = { provider: null, modelId: "m", thinkingLevel: "off", cwd: "/", role: "root", compaction: { enabled: false, reservePercent: 20 } };

/** 一个库：会话 a（有两条条目），以及从 a 的第一条 fork 出来的 b */
async function forkedLibrary(): Promise<{ file: string; a: number; b: number }> {
  const dir = await mkdtemp(join(tmpdir(), "orbita-kernel-purge-"));
  dirs.push(dir);
  const pool = new KernelPool({ dir, models: () => createModels() });
  const opened = await pool.open({ library: "t.sqlite", sessionId: "a", legacy: null, agent: AGENT });
  assert.ok(opened.ok);
  const { harness } = await pool.library("t.sqlite");
  const conversation = await harness.conversation(opened.conversationId as ConversationId, BACKGROUND_CONTEXT);
  assert.ok(conversation !== undefined);
  const ids: EntryId[] = [];
  await harness.commit(async (tx) => {
    for (const text of ["A-ONLY-FIRST", "A-ONLY-SECOND"]) {
      const record = await tx.appendEntry(conversation.id, { kind: "orbita.note", model: [{ role: "user", content: text, timestamp: 1 }] } as never);
      ids.push(record.id);
    }
  }, BACKGROUND_CONTEXT);
  const fork = await conversation.fork(ids[0] as EntryId, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  await pool.closeAll();
  return { file: join(dir, "t.sqlite"), a: opened.conversationId, b: fork.id };
}

const count = (file: string, sql: string): number => {
  const db = new DatabaseSync(file);
  try {
    return Number((db.prepare(sql).get() as Record<string, unknown>)["n"]);
  } finally {
    db.close();
  }
};

describe("purgeTombstoned：按墓碑清行的「还有会话 fork 自它」守卫", () => {
  it("要删的会话还被留下来的会话 fork 着（它的历史读得到要删的条目）：整次回滚，一行不删，墓碑留着", async () => {
    const { file, a } = await forkedLibrary();
    const before = count(file, "SELECT COUNT(*) AS n FROM entries");
    await addTombstones(file, [a]);
    await assert.rejects(purgeTombstoned(file), /forked from/);
    assert.equal(count(file, "SELECT COUNT(*) AS n FROM entries"), before, "一条都没删");
    assert.equal(count(file, `SELECT COUNT(*) AS n FROM conversations WHERE id = ${a}`), 1);
    assert.ok(existsSync(purgeFile(file)), "墓碑留着，下次再试");
  });

  it("fork 出来的那条也一起删：照常清掉两条会话的行", async () => {
    const { file, a, b } = await forkedLibrary();
    await addTombstones(file, [a, b]);
    const result = await purgeTombstoned(file);
    assert.ok(result !== null && result.conversations >= 2);
    assert.equal(count(file, `SELECT COUNT(*) AS n FROM conversations WHERE id IN (${a}, ${b})`), 0);
    assert.ok(!existsSync(purgeFile(file)));
  });
});
