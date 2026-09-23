import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelStore } from "./store.ts";
import type { ChannelMessage } from "../../shared/channel.ts";

const PARENT = "a7f3c1d2-4b8e-4f21-9c3a-0d1e2f3a4b5c";
const CHILD = "b1c2d3e4-5f60-4a71-8b92-0c1d2e3f4a5b";
const CHILD2 = "c2d3e4f5-6071-4b82-9c03-1d2e3f4a5b6c";

const message = (overrides: Partial<ChannelMessage> = {}): ChannelMessage => ({
  id: "m1",
  from: "parent",
  author: "model",
  kind: "task",
  text: "去把外壳重做",
  delivery: "followUp",
  createdAt: 1,
  ...overrides,
});

let dir = "";
let store: ChannelStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-channel-"));
  store = new ChannelStore(join(dir, "channels"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ChannelStore.append / load", () => {
  test("往返：append 后 load 得回同一条消息", async () => {
    const key = { parentId: PARENT, childId: CHILD };
    await store.append(key, message());
    assert.deepEqual(await store.load(key), [message()]);
  });

  test("多条按 createdAt 正序返回，与落账顺序无关", async () => {
    const key = { parentId: PARENT, childId: CHILD };
    await store.append(key, message({ id: "m2", kind: "reply", createdAt: 5 }));
    await store.append(key, message({ id: "m1", createdAt: 1 }));
    assert.deepEqual(
      (await store.load(key)).map((m) => m.id),
      ["m1", "m2"],
    );
  });

  test("坏行与半截行跳过，前面读到的照常返回", async () => {
    const key = { parentId: PARENT, childId: CHILD };
    await store.append(key, message());
    const path = join(dir, "channels", PARENT, `${CHILD}.jsonl`);
    await appendFile(path, "not json at all\n", "utf8");
    await appendFile(path, '{"id":"half"', "utf8"); // 无结尾换行的半截行
    const loaded = await store.load(key);
    assert.deepEqual(loaded.map((m) => m.id), ["m1"]);
  });

  test("文件不存在 = 一条往来都没有（ENOENT → []）", async () => {
    assert.deepEqual(await store.load({ parentId: PARENT, childId: CHILD }), []);
  });

  test("目录读不了照抛，不是 ENOENT 不能吞", async () => {
    const path = join(dir, "channels", PARENT, `${CHILD}.jsonl`);
    await mkdir(path, { recursive: true }); // 用目录顶替文件——readFile 打上去必炸且不是 ENOENT
    await assert.rejects(() => store.load({ parentId: PARENT, childId: CHILD }));
  });
});

describe("ChannelStore.listForParent", () => {
  test("汇总每个子会话的通道，按 lastAt 倒序", async () => {
    await store.append({ parentId: PARENT, childId: CHILD }, message({ id: "m1", createdAt: 1 }));
    await store.append(
      { parentId: PARENT, childId: CHILD2 },
      message({ id: "m2", createdAt: 9 }),
    );
    const titles = new Map([
      [CHILD, "早派出的"],
      [CHILD2, "晚派出的"],
    ]);
    const summaries = await store.listForParent(PARENT, async (id) => titles.get(id) ?? "");
    assert.deepEqual(
      summaries.map((s) => ({ childId: s.childId, childTitle: s.childTitle, lastAt: s.lastAt })),
      [
        { childId: CHILD2, childTitle: "晚派出的", lastAt: 9 },
        { childId: CHILD, childTitle: "早派出的", lastAt: 1 },
      ],
    );
  });

  test("不做 hasExchange 过滤——task-only 通道也如实列出", async () => {
    await store.append({ parentId: PARENT, childId: CHILD }, message());
    const summaries = await store.listForParent(PARENT, async () => "x");
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.hasExchange, false);
  });

  test("目录不存在（这个父从没派出过子）→ []", async () => {
    assert.deepEqual(await store.listForParent(PARENT, async () => "x"), []);
  });

  test("文件名不是会话 id 的 .jsonl（手放 / 残留）跳过，不拖垮整个列表", async () => {
    await store.append({ parentId: PARENT, childId: CHILD }, message());
    // 手放的一份非会话 id 的 .jsonl——load() 内部会因 assertSessionId 抛错，
    // listForParent 必须在这之前就跳过它，否则这条父会话从此开不了轮
    await writeFile(join(dir, "channels", PARENT, "notes.jsonl"), '{"not":"a channel message"}\n', "utf8");
    const summaries = await store.listForParent(PARENT, async () => "x");
    assert.deepEqual(
      summaries.map((s) => s.childId),
      [CHILD],
    );
  });

  test("非 .jsonl 文件忽略", async () => {
    await mkdir(join(dir, "channels", PARENT), { recursive: true });
    await writeFile(join(dir, "channels", PARENT, "stray.txt"), "junk", "utf8");
    assert.deepEqual(await store.listForParent(PARENT, async () => "x"), []);
  });
});

describe("id 白名单", () => {
  test("非法 id 一律拒绝，不落在 channels 目录之外", async () => {
    for (const bad of ["../../etc/passwd", "..", "a/b", "", "not-a-uuid"]) {
      await assert.rejects(
        () => store.append({ parentId: bad, childId: CHILD }, message()),
        /invalid session id/,
      );
      await assert.rejects(
        () => store.append({ parentId: PARENT, childId: bad }, message()),
        /invalid session id/,
      );
      await assert.rejects(() => store.load({ parentId: bad, childId: CHILD }), /invalid session id/);
      await assert.rejects(() => store.listForParent(bad, async () => "x"), /invalid session id/);
    }
  });
});

describe("ChannelStore.removeForParent / removeChannel", () => {
  test("removeForParent 删掉父名下全部通道", async () => {
    await store.append({ parentId: PARENT, childId: CHILD }, message());
    await store.append({ parentId: PARENT, childId: CHILD2 }, message({ id: "m2" }));
    await store.removeForParent(PARENT);
    assert.deepEqual(await readdir(join(dir, "channels")).catch(() => []), []);
  });

  test("removeForParent 对不存在的父也照常（force 吞 ENOENT）", async () => {
    await store.removeForParent(PARENT);
  });

  test("removeChannel 只删单条通道，父目录下其它通道不受影响", async () => {
    await store.append({ parentId: PARENT, childId: CHILD }, message());
    await store.append({ parentId: PARENT, childId: CHILD2 }, message({ id: "m2" }));
    await store.removeChannel({ parentId: PARENT, childId: CHILD });
    assert.deepEqual(await store.load({ parentId: PARENT, childId: CHILD }), []);
    assert.equal((await store.load({ parentId: PARENT, childId: CHILD2 })).length, 1);
  });

  test("removeChannel 对不存在的通道也照常", async () => {
    await store.removeChannel({ parentId: PARENT, childId: CHILD });
  });
});
