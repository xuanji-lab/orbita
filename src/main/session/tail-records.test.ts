import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, TAIL_READ_BYTES, TAIL_READ_RECORDS, type TailWindow } from "./store.ts";
import type { SessionMeta, SessionRecord } from "../../shared/session.ts";

const ID = "a7f3c1d2-4b8e-4f21-9c3a-0d1e2f3a4b5c";

let dir = "";
let store: SessionStore;
let log = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-tail-"));
  // 目录先建出来：下面的用例大多直接往 JSONL 写字节，不经 store.record
  await mkdir(join(dir, "sessions"), { recursive: true });
  store = new SessionStore(join(dir, "sessions"));
  log = join(dir, "sessions", `${ID}.jsonl`);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const meta: SessionMeta = {
  id: ID,
  title: "",
  titleSource: "derived",
  cwd: "/repo",
  workspaceId: null,
  providerId: "zai",
  modelId: "glm-5.3",
  mode: "plan",
  thinkingLevel: "medium",
  piSessionFile: null,
  pinned: false,
  archived: false,
  recentQueries: [],
  stats: null,
  createdAt: 1,
  updatedAt: 1,
};

const user = (id: string, text: string, timestamp = 1): SessionRecord => ({
  id,
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
});

/** 把记录直接写成 JSONL（不经 store.record——要能造半截行、坏行、没有尾换行的文件） */
const lines = (records: readonly unknown[]): string => records.map((record) => (typeof record === "string" ? record : JSON.stringify(record))).join("\n");

describe("tailRecords：从文件尾按字节倒读", () => {
  test("空文件、文件不存在都是空；窗口报得出文件不存在", async () => {
    await writeFile(log, "");
    assert.deepEqual(await store.tailRecords(ID), []);
    await rm(log);
    assert.deepEqual(await store.tailRecords(ID), []);
    assert.equal(await store.tailWindow(ID), null);
  });

  test("不足一屏：全部记录，按文件顺序", async () => {
    const records = [user("u1", "一"), user("u2", "二"), user("u3", "三")];
    await writeFile(log, `${lines(records)}\n`);
    assert.deepEqual(await store.tailRecords(ID), records);
    const window = await store.tailWindow(ID);
    assert.equal(window?.start, 0);
  });

  test("正好截在一行中间：窗口的第一行不完整，丢掉，只留后面的", async () => {
    const first = JSON.stringify(user("u1", "很长很长".repeat(20)));
    const second = JSON.stringify(user("u2", "二"));
    const third = JSON.stringify(user("u3", "三"));
    await writeFile(log, `${first}\n${second}\n${third}\n`);
    const size = Buffer.byteLength(`${first}\n${second}\n${third}\n`);
    // 窗口从第一行正中间开始
    const cut = Math.floor(Buffer.byteLength(first) / 2);
    const window = await store.tailWindow(ID, { maxBytes: size - cut });
    assert.ok(window);
    assert.equal(window.start, cut);
    // 续读点落在第二行的开头：从那儿往前读，最后一行正好是被丢掉的第一行
    assert.equal(window.next, Buffer.byteLength(first) + 1);
    assert.deepEqual(
      window.records.map((record) => record.id),
      ["u2", "u3"],
    );
  });

  test("窗口的起点恰好是一行的开头：分不清，这一行也当不完整丢掉，续读点不前进", async () => {
    const first = JSON.stringify(user("u1", "一"));
    const second = JSON.stringify(user("u2", "二"));
    await writeFile(log, `${first}\n${second}\n`);
    const window = await store.tailWindow(ID, { maxBytes: Buffer.byteLength(second) + 1 });
    assert.equal(window?.start, Buffer.byteLength(first) + 1);
    assert.deepEqual(window?.records, []);
    assert.equal(window?.next, window?.end);
    // 窗口再大一个字节，这一行就完整了
    const wider = await store.tailWindow(ID, { maxBytes: Buffer.byteLength(second) + 2 });
    assert.deepEqual(wider?.records, [user("u2", "二")]);
    assert.equal(wider?.next, Buffer.byteLength(first) + 1);
  });

  test("窗口里一个换行都没有（第一行就比窗口大）：空", async () => {
    const line = JSON.stringify(user("u1", "x".repeat(5000)));
    await writeFile(log, `${line}\n`);
    const window = await store.tailWindow(ID, { maxBytes: 100 });
    assert.ok(window);
    assert.equal(window.start, line.length + 1 - 100);
    assert.deepEqual(window.records, []);
    // 一条完整行都没有：续读点没有前进，调用方得加大窗口
    assert.equal(window.next, window.end);
  });

  test("起点落在一个多字节字符的中间：那一行丢掉，后面的照常解码，不出乱码", async () => {
    const first = JSON.stringify(user("u1", "中文".repeat(30)));
    const second = JSON.stringify(user("u2", "第二行的中文"));
    await writeFile(log, `${first}\n${second}\n`);
    const bytes = Buffer.byteLength(first, "utf8") + Buffer.byteLength(second, "utf8") + 2;
    // 第一行有 60 个中文字（各 3 字节）：起点落在其中一个字的后一个字节上
    const window = await store.tailWindow(ID, { maxBytes: bytes - 61 });
    assert.deepEqual(window?.records, [user("u2", "第二行的中文")]);
  });

  test("最后一行没有换行：完整的收下，半截的跳过", async () => {
    const a = JSON.stringify(user("u1", "一"));
    await writeFile(log, `${a}\n${JSON.stringify(user("u2", "二"))}`);
    assert.deepEqual(
      (await store.tailRecords(ID)).map((record) => record.id),
      ["u1", "u2"],
    );
    await writeFile(log, `${a}\n${JSON.stringify(user("u2", "二")).slice(0, 25)}`);
    assert.deepEqual(
      (await store.tailRecords(ID)).map((record) => record.id),
      ["u1"],
    );
  });

  test("坏行跳过：夹在中间的、在最后的都不丢后面的", async () => {
    const good = [user("u1", "一"), user("u2", "二"), user("u3", "三")];
    await writeFile(log, `${lines([good[0], "{not json", good[1], good[2]])}\n`);
    assert.deepEqual(await store.tailRecords(ID), good);
    await writeFile(log, `${lines([...good, '{"id":"broken"'])}\n`);
    assert.deepEqual(await store.tailRecords(ID), good);
    // null / 数字 / 数组不是记录
    await writeFile(log, `${lines([good[0], "null", "7", "[1,2]", good[1]])}\n`);
    assert.deepEqual(await store.tailRecords(ID), [good[0], good[1]]);
  });

  test("maxRecords 从尾往前数可解析的行，坏行不占名额；再往前的行不解码", async () => {
    const records = Array.from({ length: 10 }, (_, i) => user(`u${i + 1}`, `第 ${i + 1} 条`));
    await writeFile(log, lines([...records.slice(0, 5), "{bad", ...records.slice(5)]) + "\n");
    assert.deepEqual(await store.tailRecords(ID, { maxRecords: 3 }), records.slice(-3));
    assert.deepEqual(await store.tailRecords(ID, { maxRecords: 6 }), records.slice(-6));
    assert.deepEqual(await store.tailRecords(ID, { maxRecords: 100 }), records);
    assert.deepEqual(await store.tailRecords(ID, { maxRecords: Infinity }), records);
  });

  test("endByte 续读：下一个窗口接着上一个的 start 往前读，拼起来就是整份", async () => {
    const records = Array.from({ length: 40 }, (_, i) => user(`u${i + 1}`, `第 ${i + 1} 条，稍微长一点的内容`));
    await writeFile(log, `${lines(records)}\n`);
    const collected: SessionRecord[] = [];
    let endByte: number | undefined;
    let windows = 0;
    for (;;) {
      const window = await store.tailWindow(ID, { maxBytes: 200, maxRecords: Infinity, ...(endByte === undefined ? {} : { endByte }) });
      assert.ok(window);
      windows += 1;
      collected.unshift(...window.records);
      if (window.start === 0) break;
      assert.ok(window.next < (endByte ?? window.end), "续读点一直在往前走");
      endByte = window.next;
      assert.ok(windows < 60, "窗口一直在往前走");
    }
    assert.ok(windows > 5, `读了 ${windows} 个窗口`);
    assert.deepEqual(collected, records);
  });

  test("endByte 大于文件大小时按文件尾算", async () => {
    await writeFile(log, `${lines([user("u1", "一")])}\n`);
    const window = await store.tailWindow(ID, { endByte: 1_000_000 });
    assert.equal(window?.end, Buffer.byteLength(`${lines([user("u1", "一")])}\n`));
    assert.deepEqual(window?.records, [user("u1", "一")]);
  });

  test("与全量读取一致：任何窗口下，结果都是整份记录的尾部", async () => {
    let seed = 20261125;
    const random = (max: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    for (let round = 0; round < 40; round += 1) {
      const records = Array.from({ length: 12 + random(20) }, (_, i) =>
        user(`r${round}-u${i}`, "内容".repeat(1 + random(30)) + Math.random().toString(36).slice(2)),
      );
      await writeFile(log, `${lines(records)}\n`);
      const whole = await store.readRawLog(ID);
      assert.deepEqual(whole, records);
      const maxBytes = 1 + random(Buffer.byteLength(lines(records), "utf8"));
      const tail = await store.tailRecords(ID, { maxBytes, maxRecords: Infinity });
      assert.deepEqual(tail, whole.slice(whole.length - tail.length), `round ${round}, maxBytes ${maxBytes}`);
      // 一路续读到文件头：拼起来就是整份，不丢行、不重复。碰到比窗口还大的行（next 没前进）就把窗口翻倍
      const collected: SessionRecord[] = [];
      let endByte: number | undefined;
      let windowBytes = maxBytes;
      for (let guard = 0; ; guard += 1) {
        assert.ok(guard < 500, "续读没有停");
        const window = await store.tailWindow(ID, { maxBytes: windowBytes, maxRecords: Infinity, ...(endByte === undefined ? {} : { endByte }) });
        assert.ok(window);
        collected.unshift(...window.records);
        if (window.start === 0) break;
        const until = endByte ?? window.end;
        if (window.next >= until) {
          windowBytes *= 2;
          continue;
        }
        endByte = window.next;
      }
      assert.deepEqual(collected, whole, `round ${round}, maxBytes ${maxBytes}`);
    }
  });

  test("record 落盘之后读得到：默认窗口是 256 KB / 80 条", async () => {
    assert.equal(TAIL_READ_BYTES, 256 * 1024);
    assert.equal(TAIL_READ_RECORDS, 80);
    await store.ensureSession(meta);
    const records = Array.from({ length: 100 }, (_, i) => user(`u${i}`, `第 ${i} 条`));
    for (const record of records) await store.record(ID, record);
    const tail = await store.tailRecords(ID);
    assert.deepEqual(tail, records.slice(-80));
    // 这 100 条比窗口小：从文件头读起
    const small: TailWindow | null = await store.tailWindow(ID);
    assert.ok(small !== null && small.start === 0);
    // 文件比窗口大：只读最后 256 KB，起止都落在行边界上（后面这几千条直接追加，不走 meta 写入链——省测试时间）
    const big = Array.from({ length: 3900 }, (_, i) => user(`u${100 + i}`, `${"内容".repeat(60)} ${i}`));
    await appendFile(log, `${lines(big)}\n`);
    const window = await store.tailWindow(ID);
    assert.ok(window !== null && window.start > 0);
    const whole = await store.readRawLog(ID);
    assert.deepEqual(window.records, whole.slice(-window.records.length));
    assert.equal(window.records.length, 80);
    assert.equal(whole.length, 4000);
  });

  test("文件在读了大小之后又被追加：新行留给下一次，已有的照常给", async () => {
    const a = JSON.stringify(user("u1", "一"));
    await writeFile(log, `${a}\n`);
    const before = await store.tailWindow(ID);
    assert.equal(before?.end, Buffer.byteLength(a) + 1);
    await appendFile(log, `${JSON.stringify(user("u2", "二"))}\n`);
    assert.deepEqual((await store.tailRecords(ID, { endByte: before?.end })).map((record) => record.id), ["u1"]);
    assert.deepEqual((await store.tailRecords(ID)).map((record) => record.id), ["u1", "u2"]);
  });

  test("会话 id 不合法：拼路径之前就拒", async () => {
    await assert.rejects(store.tailRecords("../../secrets"), /invalid session id/);
    await assert.rejects(store.tailWindow("not-a-id"), /invalid session id/);
  });
});
