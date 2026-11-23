import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { outboxLanded, parseOutbox, OUTBOX_MAX } from "../../shared/outbox.ts";
import { OutboxStore } from "./outbox.ts";

const entry = (id: string, at = 1000) => ({ id, sessionId: "s1", draftKey: "home:main", text: `话 ${id}`, at });

describe("发件箱：先落盘再开跑", () => {
  test("put 落盘、remove 删掉；重开 store 还读得到没删的；连发几条不互相覆盖", async () => {
    const dir = await mkdtemp(join(tmpdir(), "outbox-"));
    const store = new OutboxStore(dir);
    await Promise.all([store.put(entry("a", 1)), store.put(entry("b", 2)), store.put(entry("c", 3))]);
    await store.remove("b");
    assert.deepEqual((await new OutboxStore(dir).list()).map((e) => e.id), ["a", "c"]);
    const raw = JSON.parse(await readFile(join(dir, "outbox.json"), "utf8"));
    assert.equal(raw.entries.length, 2);
  });

  test("坏文件 / 坏行：读成空或丢掉坏行，不抛；超出上限只留最新的", async () => {
    const dir = await mkdtemp(join(tmpdir(), "outbox-"));
    await writeFile(join(dir, "outbox.json"), "{not json");
    assert.deepEqual(await new OutboxStore(dir).list(), []);
    assert.deepEqual(parseOutbox({ entries: [entry("ok"), { id: "", sessionId: "s", draftKey: "", text: "", at: 1 }, null, "x"] }).map((e) => e.id), ["ok"]);
    const many = { entries: Array.from({ length: OUTBOX_MAX + 5 }, (_, i) => entry(`e${i}`, i)) };
    const parsed = parseOutbox(many);
    assert.equal(parsed.length, OUTBOX_MAX);
    assert.equal(parsed[0]?.id, "e5");
  });

  test("核对落没落账：会话里有不早于发送时刻（容 2 秒）且包含原文开头的用户消息才算落了", () => {
    const e = { text: "修一下侧栏", at: 10_000 };
    assert.equal(outboxLanded(e, [{ role: "user", timestamp: 10_500, text: "<指令块>\n修一下侧栏" }]), true);
    assert.equal(outboxLanded(e, [{ role: "user", timestamp: 7_000, text: "修一下侧栏" }]), false, "更早的同名消息不算");
    assert.equal(outboxLanded(e, [{ role: "assistant", timestamp: 10_500, text: "修一下侧栏" }]), false);
    assert.equal(outboxLanded(e, []), false);
  });
});
