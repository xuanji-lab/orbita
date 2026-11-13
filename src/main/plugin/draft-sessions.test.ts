import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { DRAFT_SESSIONS_MAX, DraftSessionBook } from "./draft-sessions.ts";

let dir = "";
let file = "";
let clock = 1000;
const book = (): DraftSessionBook => new DraftSessionBook(file, () => (clock += 1));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "draft-sessions-"));
  file = join(dir, "plugin-draft-sessions.json");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("DraftSessionBook：草稿路径 → 最近在做它的会话", () => {
  test("记下后读得回；没记过的路径为 null；重新 new 一个（重启后）仍在", async () => {
    await book().remember("/ws/plugins/a", "s1");
    assert.equal(await book().sessionOf("/ws/plugins/a"), "s1");
    assert.equal(await book().sessionOf("/ws/plugins/b"), null);
  });

  test("同一路径再记一次覆盖（只留最近一次）", async () => {
    const b = book();
    await b.remember("/ws/plugins/a", "s1");
    await b.remember("/ws/plugins/a", "s2");
    assert.equal(await b.sessionOf("/ws/plugins/a"), "s2");
    assert.equal(Object.keys(JSON.parse(await readFile(file, "utf8")).drafts).length, 1);
  });

  test("文件不存在 / 坏 JSON / 形状不对：当空，不抛；下一次记账写出干净的文件", async () => {
    assert.equal(await book().sessionOf("/x"), null);
    await writeFile(file, "{ not json", "utf8");
    assert.equal(await book().sessionOf("/x"), null);
    await writeFile(file, JSON.stringify({ drafts: { "/x": { sessionId: 5, at: "no" }, "/y": "s", "/z": { sessionId: "s9", at: 1 } } }), "utf8");
    assert.equal(await book().sessionOf("/x"), null);
    assert.equal(await book().sessionOf("/z"), "s9");
    await book().remember("/n", "s1");
    assert.equal(JSON.parse(await readFile(file, "utf8")).version, 1);
  });

  test("并发记账不互相覆盖；原子写不留 .tmp", async () => {
    const b = book();
    await Promise.all(Array.from({ length: 20 }, (_, index) => b.remember(`/p${index}`, `s${index}`)));
    for (let index = 0; index < 20; index += 1) assert.equal(await b.sessionOf(`/p${index}`), `s${index}`);
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  });

  test("总量封顶：超了丢最旧的", async () => {
    const b = book();
    for (let index = 0; index < DRAFT_SESSIONS_MAX + 5; index += 1) await b.remember(`/p${index}`, "s");
    assert.equal(Object.keys(JSON.parse(await readFile(file, "utf8")).drafts).length, DRAFT_SESSIONS_MAX);
    assert.equal(await b.sessionOf("/p0"), null);
    assert.equal(await b.sessionOf(`/p${DRAFT_SESSIONS_MAX + 4}`), "s");
  });
});
