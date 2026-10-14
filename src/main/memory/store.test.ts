/**
 * MemoryStore 的回归网：补 id / sessionId、读回、坏行跳过、作用域隔离，
 * 与 v2 的改写路径（编辑 / 批删 / 移动 / 冲突拍板 / 摘抄 / 手动添加）。
 * 真文件系统用临时目录（carryover-store.test.ts 同款），不 mock fs。
 *
 * 寻址口径：**测试与生产一致，全部按 token**（sha1(scopeId)，见 MemoryScopeToken）；
 * 作用域名只用来经 tokenOf 换算，保证「文件名 ↔ 寻址」不会在测试里走后门。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { MEMORY_GLOBAL_SCOPE, type MemoryDraft } from "../../shared/memory.ts";
import { MemoryStore, memoryScopeOf, parseMemoryEntry } from "./store.ts";

let dir = "";
let store: MemoryStore;
let wsA = "";
let wsB = "";
let globalToken = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-memory-"));
  store = new MemoryStore(dir);
  wsA = store.tokenOf("ws-a");
  wsB = store.tokenOf("ws-b");
  globalToken = store.tokenOf(MEMORY_GLOBAL_SCOPE);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const draft = (text: string, keywords: string[], timestamp = 1_700_000_000_000): MemoryDraft => ({
  text,
  keywords,
  timestamp,
});

describe("MemoryStore", () => {
  test("文件还不存在时 list 是空的，不抛", async () => {
    assert.deepEqual(await store.list(wsA), []);
  });

  test("append 补 id 与 sessionId、盖 turn 与 source，读回逐字段一致", async () => {
    const created = await store.append(wsA, "session-1", 3, [
      draft("用户偏好用 bun 作为包管理器，禁用 npm", ["bun", "包管理器"]),
      draft("终端面板的默认字号是 13px", ["字号", "终端"]),
    ]);
    assert.equal(created.length, 2);
    assert.match(created[0]?.id ?? "", /^mem_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notEqual(created[0]?.id, created[1]?.id);
    assert.equal(created[0]?.sessionId, "session-1");
    assert.equal(created[0]?.text, "用户偏好用 bun 作为包管理器，禁用 npm");
    assert.deepEqual(created[0]?.keywords, ["bun", "包管理器"]);
    assert.equal(created[0]?.timestamp, 1_700_000_000_000);
    assert.equal(created[0]?.source, "distilled");
    assert.equal(created[0]?.turn, 3);

    // 落盘后再读：返回的就是盘上的真相（含主进程补的那几个字段）
    assert.deepEqual(await store.list(wsA), created);
  });

  test("draft 带冲突建议时随条目落盘", async () => {
    const [old] = await store.append(wsA, "s1", 1, [draft("用 bun 管包", ["bun"])]);
    assert.ok(old !== undefined);
    const [fresh] = await store.append(wsA, "s2", 2, [
      { ...draft("改回 npm", ["npm"]), supersedes: old.id },
    ]);
    assert.equal(fresh?.supersedes, old.id);
  });

  test("append 是追加而不是覆盖：两次写入按顺序都在", async () => {
    await store.append(wsA, "session-1", 1, [draft("第一条", ["一"])]);
    await store.append(wsA, "session-2", 2, [draft("第二条", ["二"])]);
    const all = await store.list(wsA);
    assert.deepEqual(
      all.map((entry) => entry.text),
      ["第一条", "第二条"],
    );
    assert.deepEqual(
      all.map((entry) => entry.sessionId),
      ["session-1", "session-2"],
    );
  });

  test("空批不碰盘：一条 draft 都没有时连文件都不建", async () => {
    assert.deepEqual(await store.append(wsA, "session-1", 1, []), []);
    await assert.rejects(stat(store.filePath("ws-a")));
    assert.deepEqual(await store.list(wsA), []);
  });

  test("边界清洗：空文本整条丢，关键词去空白、丢非字符串、截到 8 个", async () => {
    const created = await store.append(wsA, "session-1", 1, [
      draft("   ", ["空文本"], 1),
      // 3 as unknown as string：跨进程进来的 keywords 不保证真是字符串数组，清洗在边界上做
      draft("正文", ["", "  ", 3 as unknown as string, ...Array.from({ length: 10 }, (_, index) => `k${index}`)], 2),
    ]);
    assert.equal(created.length, 1);
    assert.equal(created[0]?.text, "正文");
    assert.deepEqual(created[0]?.keywords, ["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7"]);
  });

  test("坏行跳过不炸：半截 JSON 与字段残缺的行各跳一条，好行照常", async () => {
    const [good] = await store.append(wsA, "session-1", 1, [draft("好行", ["好"])]);
    assert.ok(good !== undefined);
    await writeFile(
      store.filePath("ws-a"),
      [
        "this line is not json at all", // 半截行 → 跳
        '{"id":"mem_x","text":"缺关键词","sessionId":"s","timestamp":1}', // 字段不齐 → 跳
        '{"id":"","text":"空 id","keywords":[],"sessionId":"s","timestamp":1}', // 空 id → 跳
        '{"id":"mem_y","text":"坏时间戳","keywords":[],"sessionId":"s","timestamp":"昨天"}', // timestamp 非数字 → 跳
        '{"id":"mem_z","text":"关键词里有非字符串","keywords":["ok",3],"sessionId":"s","timestamp":1}', // → 跳
        JSON.stringify(good), // 好行保留
        "", // 末尾空行（写文件常带的尾换行）
      ].join("\n") + "\n",
      "utf8",
    );
    const all = await store.list(wsA);
    assert.deepEqual(
      all.map((entry) => entry.id),
      [good.id],
    );
  });

  test("作用域隔离：两个作用域各写各的，互不看见，文件名也不同", async () => {
    await store.append(wsA, "session-1", 1, [draft("A 的记忆", ["a"])]);
    await store.append(store.tokenOf("C:/work/project"), "session-2", 1, [draft("B 的记忆", ["b"])]);
    assert.deepEqual(
      (await store.list(wsA)).map((entry) => entry.text),
      ["A 的记忆"],
    );
    assert.deepEqual(
      (await store.list(store.tokenOf("C:/work/project"))).map((entry) => entry.text),
      ["B 的记忆"],
    );
    assert.notEqual(store.filePath("ws-a"), store.filePath("C:/work/project"));
    // 文件名是定长哈希：任意作用域（含 Windows 路径）都不会拼出非法文件名
    assert.match(store.filePath("C:/work/project"), /[0-9a-f]{40}\.jsonl$/);
  });

  test("读不了 ≠ 没有：文件读失败照抛，不装作空库", async () => {
    // 作用域那个路径上是个目录：readFile 撞 EISDIR——那说明盘上的东西不是我们以为的样子，
    // 该让调用方看见，不能装作「这个作用域没有记忆」
    await mkdir(store.filePath("ws-a"), { recursive: true });
    await assert.rejects(store.list(wsA), (cause: unknown) => (cause as { code?: string }).code === "EISDIR");
  });
});

describe("MemoryStore.remove / removeBatch（记忆库的删除）", () => {
  test("删中间一条，其余按原顺序读回", async () => {
    const created = await store.append(wsA, "s1", 1, [
      draft("第一条", ["一"]),
      draft("第二条", ["二"]),
      draft("第三条", ["三"]),
    ]);
    assert.equal(await store.remove(wsA, created[1]?.id ?? ""), true);
    assert.deepEqual(
      (await store.list(wsA)).map((entry) => entry.text),
      ["第一条", "第三条"],
    );
  });

  test("id 不存在回 false，盘上的东西一动不动", async () => {
    const [kept] = await store.append(wsA, "s1", 1, [draft("唯一一条", ["一"])]);
    assert.ok(kept !== undefined);
    const before = await readFile(store.filePath("ws-a"), "utf8");
    assert.equal(await store.remove(wsA, "mem_不存在的id"), false);
    assert.equal(await readFile(store.filePath("ws-a"), "utf8"), before);
  });

  test("文件不存在回 false，而且不顺手建文件", async () => {
    assert.equal(await store.remove(wsA, "mem_whatever"), false);
    await assert.rejects(stat(store.filePath("ws-a")));
  });

  test("空 id 串直接 false，不碰盘", async () => {
    const [kept] = await store.append(wsA, "s1", 1, [draft("唯一一条", ["一"])]);
    assert.ok(kept !== undefined);
    assert.equal(await store.remove(wsA, ""), false);
    assert.equal((await store.list(wsA)).length, 1);
  });

  test("删空之后留空文件、不删文件，下一次 append 照常追加", async () => {
    const [only] = await store.append(wsA, "s1", 1, [draft("删完就没", ["一"])]);
    assert.ok(only !== undefined);
    assert.equal(await store.remove(wsA, only.id), true);
    // 文件还在（读得到、只是空的）——删文件只会让「append 建目录」和「remove 删目录」
    // 两条路径互相咬
    assert.deepEqual(await store.list(wsA), []);
    const appended = await store.append(wsA, "s2", 1, [draft("删完又来一条", ["二"])]);
    assert.equal(appended.length, 1);
    assert.deepEqual(
      (await store.list(wsA)).map((entry) => entry.text),
      ["删完又来一条"],
    );
  });

  test("写盘是整份换掉：坏行不保留，也没有临时文件残留", async () => {
    const [first, second] = await store.append(wsA, "s1", 1, [draft("好行一", ["一"]), draft("好行二", ["二"])]);
    assert.ok(first !== undefined && second !== undefined);
    // 往盘里塞一行坏 JSON：remove 是「读全量 → 滤 → 重写」，坏行该在这次重写里消失
    await writeFile(store.filePath("ws-a"), `${await readFile(store.filePath("ws-a"), "utf8")}not json at all\n`, "utf8");
    assert.equal((await store.list(wsA)).length, 2);

    assert.equal(await store.remove(wsA, first.id), true);
    const after = await readFile(store.filePath("ws-a"), "utf8");
    assert.deepEqual(after.split("\n").filter((line) => line !== ""), [JSON.stringify(second)]);
    // 原子写的临时文件被 rename 走，不留 .tmp 垃圾（否则每删一次目录里就多一个）
    assert.deepEqual(await readdir(dir), [basename(store.filePath("ws-a"))]);
  });

  test("别的作业范围不受影响", async () => {
    const [mine, theirs] = await Promise.all([
      store.append(wsA, "s1", 1, [draft("A 的", ["a"])]),
      store.append(wsB, "s2", 1, [draft("B 的", ["b"])]),
    ]);
    assert.ok(mine[0] !== undefined && theirs[0] !== undefined);
    assert.equal(await store.remove(wsA, mine[0]?.id ?? ""), true);
    assert.deepEqual(await store.list(wsB), theirs);
  });

  test("批量删：多选一次删掉，不存在的 id 不计数", async () => {
    const created = await store.append(wsA, "s1", 1, [
      draft("第一条", ["一"]),
      draft("第二条", ["二"]),
      draft("第三条", ["三"]),
    ]);
    const removed = await store.removeBatch(wsA, [created[0]?.id ?? "", "mem_不在的", created[2]?.id ?? ""]);
    assert.equal(removed, 2);
    assert.deepEqual(
      (await store.list(wsA)).map((entry) => entry.text),
      ["第二条"],
    );
  });
});

describe("MemoryStore.patch（编辑 / 常驻 / 状态）", () => {
  test("编辑正文盖 editedAt，其余字段不动", async () => {
    const [created] = await store.append(wsA, "s1", 2, [draft("原来写的", ["原"])]);
    assert.ok(created !== undefined);
    const patched = await store.patch(wsA, created.id, { text: "  改过的  " });
    assert.ok(patched !== null);
    assert.equal(patched.text, "改过的");
    assert.ok(patched.editedAt !== undefined && patched.editedAt >= created.timestamp);
    assert.equal(patched.sessionId, "s1");
    assert.equal(patched.turn, 2);
    assert.equal((await store.list(wsA))[0]?.text, "改过的");
  });

  test("编辑成空白不生效（不许把记忆改成空串），editedAt 也不盖", async () => {
    const [created] = await store.append(wsA, "s1", 1, [draft("正文", ["k"])]);
    assert.ok(created !== undefined);
    const patched = await store.patch(wsA, created.id, { text: "   " });
    assert.ok(patched !== null);
    assert.equal(patched.text, "正文");
    assert.equal(patched.editedAt, undefined);
  });

  test("常驻开关与状态单独可改，互不牵连", async () => {
    const [created] = await store.append(wsA, "s1", 1, [draft("正文", ["k"])]);
    assert.ok(created !== undefined);
    const muted = await store.patch(wsA, created.id, { status: "muted" });
    assert.equal(muted?.status, "muted");
    assert.equal(muted?.pinned, undefined);
    const pinned = await store.patch(wsA, created.id, { pinned: true });
    assert.equal(pinned?.pinned, true);
    assert.equal(pinned?.status, "muted");
  });

  test("id 不在回 null（幂等），盘不动", async () => {
    await store.append(wsA, "s1", 1, [draft("正文", ["k"])]);
    assert.equal(await store.patch(wsA, "mem_不在的", { text: "x" }), null);
    assert.equal((await store.list(wsA)).length, 1);
  });
});

describe("MemoryStore.move（移到全局）", () => {
  test("条目搬走、id 不变、源文件里消失", async () => {
    const [created] = await store.append(wsA, "s1", 1, [draft("跨工作区的事实", ["全局"])]);
    assert.ok(created !== undefined);
    const moved = await store.move(wsA, globalToken, [created.id]);
    assert.equal(moved, 1);
    assert.deepEqual(await store.list(wsA), []);
    const inGlobal = await store.list(globalToken);
    assert.equal(inGlobal.length, 1);
    assert.equal(inGlobal[0]?.id, created.id);
    assert.equal(inGlobal[0]?.text, "跨工作区的事实");
  });

  test("不存在的 id 不计数；同 token 移动是 0；全局搬回工作区同路", async () => {
    const [created] = await store.append(wsA, "s1", 1, [draft("一条", ["一"])]);
    assert.ok(created !== undefined);
    assert.equal(await store.move(wsA, globalToken, ["mem_不在的"]), 0);
    assert.equal(await store.move(wsA, wsA, [created.id]), 0);
    assert.equal(await store.move(globalToken, wsA, [created.id]), 0);
    const back = await store.list(wsA);
    assert.equal(back.length, 1);
    assert.equal(back[0]?.id, created.id);
  });
});

describe("MemoryStore.resolveConflict（冲突拍板）", () => {
  async function fixture(): Promise<{ newId: string; oldId: string }> {
    const [old] = await store.append(wsA, "s1", 1, [draft("用 bun 管包，bun 是唯一 lock writer", ["bun"])]);
    const [fresh] = await store.append(wsA, "s2", 2, [
      { ...draft("改回 npm，不再用 bun", ["npm"]), supersedes: old?.id },
    ]);
    assert.ok(old !== undefined && fresh !== undefined);
    return { newId: fresh.id, oldId: old.id };
  }

  test("replace：旧条目 superseded + 指回新条目，新条目记下拍板结果", async () => {
    const ids = await fixture();
    assert.equal(await store.resolveConflict(wsA, globalToken, ids, "replace", false), true);
    const entries = await store.list(wsA);
    const old = entries.find((entry) => entry.id === ids.oldId);
    const fresh = entries.find((entry) => entry.id === ids.newId);
    assert.equal(old?.status, "superseded");
    assert.equal(old?.supersededBy, ids.newId);
    // supersedes 本身不抹：那是「蒸馏判过什么」的历史
    assert.equal(fresh?.supersedes, ids.oldId);
    assert.equal(fresh?.conflictResolution, "replace");
  });

  test("keep-both：两边都不动，只记新条目的拍板结果", async () => {
    const ids = await fixture();
    assert.equal(await store.resolveConflict(wsA, globalToken, ids, "keep-both", false), true);
    const entries = await store.list(wsA);
    assert.equal(entries.find((entry) => entry.id === ids.oldId)?.status, undefined);
    assert.equal(entries.find((entry) => entry.id === ids.newId)?.conflictResolution, "keep-both");
  });

  test("drop-new：新条目消失，旧条目原样", async () => {
    const ids = await fixture();
    assert.equal(await store.resolveConflict(wsA, globalToken, ids, "drop-new", false), true);
    const entries = await store.list(wsA);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.id, ids.oldId);
    assert.equal(entries[0]?.status, undefined);
  });

  test("undo：replace 翻回去（旧条目回 active，新条目拍板结果清掉）", async () => {
    const ids = await fixture();
    await store.resolveConflict(wsA, globalToken, ids, "replace", false);
    assert.equal(await store.resolveConflict(wsA, globalToken, ids, "replace", true), true);
    const entries = await store.list(wsA);
    const old = entries.find((entry) => entry.id === ids.oldId);
    const fresh = entries.find((entry) => entry.id === ids.newId);
    assert.equal(old?.status, "active");
    assert.equal(old?.supersededBy, undefined);
    assert.equal(fresh?.conflictResolution, undefined);
    assert.equal(fresh?.supersedes, ids.oldId);
  });

  test("undo keep-both 同样可翻；drop-new 的 undo 不支持（false）", async () => {
    const ids = await fixture();
    await store.resolveConflict(wsA, globalToken, ids, "keep-both", false);
    assert.equal(await store.resolveConflict(wsA, globalToken, ids, "keep-both", true), true);
    assert.equal((await store.list(wsA)).find((entry) => entry.id === ids.newId)?.conflictResolution, undefined);
    assert.equal(await store.resolveConflict(wsA, globalToken, ids, "drop-new", true), false);
  });

  test("新旧任一条不在回 false（连点两下的第二次、删过的条目——幂等）", async () => {
    const ids = await fixture();
    assert.equal(await store.resolveConflict(wsA, globalToken, { newId: ids.newId, oldId: "mem_没了" }, "replace", false), false);
    await store.remove(wsA, ids.newId);
    assert.equal(await store.resolveConflict(wsA, globalToken, ids, "replace", false), false);
  });

  test("旧条目在全局也能拍：跨作用域冲突", async () => {
    const [old] = await store.append(globalToken, "s0", 1, [draft("全局的旧决定", ["旧"])]);
    const [fresh] = await store.append(wsA, "s1", 2, [
      { ...draft("工作区里的新决定", ["新"]), supersedes: old?.id },
    ]);
    assert.ok(old !== undefined && fresh !== undefined);
    assert.equal(await store.resolveConflict(wsA, globalToken, { newId: fresh.id, oldId: old.id }, "replace", false), true);
    assert.equal((await store.list(globalToken))[0]?.status, "superseded");
    assert.equal((await store.list(wsA))[0]?.conflictResolution, "replace");
  });
});

describe("MemoryStore.addExcerpt / addManual（摘抄与手动添加）", () => {
  test("摘抄：逐字原文即正文、常驻、带出处与态度", async () => {
    const entry = await store.addExcerpt(wsA, "s1", {
      verbatim: "先调研再动手，结论用自然语言汇报。",
      role: "user",
      turn: 3,
      stance: "position",
    });
    assert.equal(entry.source, "excerpt");
    assert.equal(entry.pinned, true);
    assert.equal(entry.stance, "position");
    assert.deepEqual(entry.keywords, []);
    assert.deepEqual(entry.origin, { verbatim: "先调研再动手，结论用自然语言汇报。", turn: 3, role: "user" });
    assert.equal(entry.turn, 3);
    assert.deepEqual(await store.list(wsA), [entry]);
  });

  test("同一句摘两次幂等：返回已在库里的那条", async () => {
    const first = await store.addExcerpt(wsA, "s1", { verbatim: "同一句话", role: "assistant", turn: 1, stance: "agree" });
    // 首尾空白美异的重复也算同一条（去重键与蒸馏同源：trim + 空白折叠）
    const again = await store.addExcerpt(wsA, "s2", { verbatim: " 同一句话 ", role: "assistant", turn: 1, stance: "agree" });
    assert.equal(again.id, first.id);
    assert.equal((await store.list(wsA)).length, 1);
  });

  test("手动添加：常驻、算立场、没有出处；空文本回 null", async () => {
    const entry = await store.addManual(wsA, "  记住这条  ");
    assert.ok(entry !== null);
    assert.equal(entry.source, "manual");
    assert.equal(entry.pinned, true);
    assert.equal(entry.stance, "position");
    assert.equal(entry.origin, undefined);
    assert.equal(entry.sessionId, "");
    assert.equal(await store.addManual(wsA, "   "), null);
  });
});

describe("MemoryStore.scopes（作用域枚举）", () => {
  test("只有装着条目的文件算作用域；删空的不列", async () => {
    await store.append(wsA, "s1", 1, [draft("A", ["a"])]);
    const [bOnly] = await store.append(wsB, "s2", 1, [draft("B", ["b"])]);
    assert.ok(bOnly !== undefined);
    await store.remove(wsB, bOnly.id);
    const scopes = await store.scopes();
    assert.deepEqual(scopes, [{ token: wsA, count: 1 }]);
  });

  test("目录不存在回空数组", async () => {
    assert.deepEqual(await store.scopes(), []);
  });
});

describe("memoryScopeOf", () => {
  test("有工作区按工作区，没有才退回 cwd", () => {
    assert.equal(memoryScopeOf({ workspaceId: "ws-a", cwd: "C:/work" }), "ws-a");
    assert.equal(memoryScopeOf({ workspaceId: null, cwd: "C:/work" }), "C:/work");
  });
});

describe("parseMemoryEntry", () => {
  test("字段齐的收下，缺字段 / 类型不对的返回 null", () => {
    const entry = { id: "mem_1", text: "t", keywords: ["k"], sessionId: "s", timestamp: 1 };
    assert.deepEqual(parseMemoryEntry(entry), entry);
    assert.equal(parseMemoryEntry(null), null);
    assert.equal(parseMemoryEntry("nope"), null);
    assert.equal(parseMemoryEntry({ id: "mem_1", text: "t", keywords: "k", sessionId: "s", timestamp: 1 }), null);
    assert.equal(parseMemoryEntry({ id: "mem_1", text: "t", keywords: ["k"], sessionId: "s" }), null);
  });

  test("v2 扩展字段：齐的收下，坏值当缺席（旧行不迁移也照常读）", () => {
    const base = { id: "mem_1", text: "t", keywords: ["k"], sessionId: "s", timestamp: 1 };
    const rich = parseMemoryEntry({
      ...base,
      source: "excerpt",
      status: "muted",
      pinned: true,
      stance: "agree",
      turn: 4,
      editedAt: 2,
      supersedes: "mem_0",
      supersededBy: "mem_2",
      conflictResolution: "replace",
      origin: { verbatim: "原文", turn: 4, role: "assistant" },
    });
    assert.ok(rich !== null);
    assert.equal(rich.source, "excerpt");
    assert.equal(rich.status, "muted");
    assert.equal(rich.pinned, true);
    assert.equal(rich.stance, "agree");
    assert.equal(rich.turn, 4);
    assert.equal(rich.editedAt, 2);
    assert.equal(rich.supersedes, "mem_0");
    assert.equal(rich.supersededBy, "mem_2");
    assert.equal(rich.conflictResolution, "replace");
    assert.deepEqual(rich.origin, { verbatim: "原文", turn: 4, role: "assistant" });

    // 坏值：枚举不认识 / 类型不对 / origin 残缺 → 各自当缺席，条目本体保留
    const junk = parseMemoryEntry({
      ...base,
      source: "梦里的来源",
      status: 3,
      pinned: "yes",
      turn: 0,
      origin: { verbatim: "", turn: -1, role: "谁" },
      supersedes: "",
    });
    assert.ok(junk !== null);
    assert.equal(junk.source, undefined);
    assert.equal(junk.status, undefined);
    assert.equal(junk.pinned, undefined);
    assert.equal(junk.turn, undefined);
    assert.equal(junk.origin, undefined);
    assert.equal(junk.supersedes, undefined);
  });
});

describe("append 去重（验收观察回归：模型复述记忆 → 同一事实重复入库）", () => {
  test("逐字重复（含空白差异）的 draft 不再落盘，批内重复也只落一条", async () => {
    const first = await store.append(wsA, "s1", 1, [
      { text: "用户养了一只叫「雪球」的橘猫", keywords: ["雪球"], timestamp: 1 },
    ]);
    assert.equal(first.length, 1);
    // 复述同一事实：逐字相同 + 一条带多余空白的变体 + 一条批内重复
    const dup = await store.append(wsA, "s2", 2, [
      { text: "用户养了一只叫「雪球」的橘猫", keywords: ["猫"], timestamp: 2 },
      { text: "  用户养了一只叫「雪球」的橘猫 ", keywords: ["猫"], timestamp: 3 },
      { text: "用户养了一只叫「雪球」的橘猫", keywords: ["猫"], timestamp: 4 },
      { text: "新项目事实：dev 端口固定 5273", keywords: ["端口"], timestamp: 5 },
    ]);
    assert.deepEqual(dup.map((entry) => entry.text), ["新项目事实：dev 端口固定 5273"]);
    assert.equal((await store.list(wsA)).length, 2);
  });

  test("措辞有差的是另一条记忆（近似重复不挡）", async () => {
    await store.append(wsA, "s1", 1, [{ text: "用户养了一只橘猫", keywords: ["猫"], timestamp: 1 }]);
    const second = await store.append(wsA, "s2", 2, [
      { text: "用户养的橘猫叫雪球", keywords: ["猫", "雪球"], timestamp: 2 },
    ]);
    assert.equal(second.length, 1);
  });
});
