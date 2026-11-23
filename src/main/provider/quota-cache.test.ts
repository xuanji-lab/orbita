import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuotaCache } from "./quota-cache.ts";
import type { QuotaSnapshot } from "../../shared/quota.ts";

let dir = "";
let cache: QuotaCache;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-quota-cache-"));
  cache = new QuotaCache(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function snapshot(amount: string): QuotaSnapshot {
  return { credits: { amount, currency: "CNY" }, windows: [], fetchedAt: 1_700_000_000_000 };
}

describe("QuotaCache", () => {
  test("文件不存在：空表，不抛", async () => {
    assert.deepEqual(await cache.read(), {});
  });

  test("写入后读回（盘上是 { [id]: { snapshot } }）", async () => {
    await cache.write("deepseek", snapshot("43.21"));
    assert.deepEqual(await cache.read(), { deepseek: snapshot("43.21") });
    const raw = JSON.parse(await readFile(join(dir, "quota-cache.json"), "utf8")) as unknown;
    assert.deepEqual(raw, { deepseek: { snapshot: snapshot("43.21") } });
  });

  test("坏 JSON → 空表（一个坏文件不能让额度块打不开）", async () => {
    await writeFile(join(dir, "quota-cache.json"), "{ not json", "utf8");
    assert.deepEqual(await cache.read(), {});
  });

  test("结构不认：条目缺 snapshot / snapshot 缺 windows 的一律丢弃，好的留下", async () => {
    await writeFile(
      join(dir, "quota-cache.json"),
      JSON.stringify({
        good: { snapshot: snapshot("1.00") },
        noWrapper: snapshot("2.00"),
        badSnapshot: { snapshot: { credits: { amount: "3.00", currency: "CNY" }, windows: [] } },
        nullEntry: null,
      }),
      "utf8",
    );
    assert.deepEqual(await cache.read(), { good: snapshot("1.00") });
  });

  test("并发写两个 provider：两个都在，不互相覆盖", async () => {
    await Promise.all([
      cache.write("deepseek", snapshot("10.00")),
      cache.write("deepseek-2", snapshot("20.00")),
      cache.write("deepseek", snapshot("30.00")),
    ]);
    const table = await cache.read();
    assert.deepEqual(table["deepseek"], snapshot("30.00"));
    assert.deepEqual(table["deepseek-2"], snapshot("20.00"));
  });

  test("父目录不存在也能写（mkdir -p 由 writeJsonAtomic 负责），第二次写不会因为前一条链而丢", async () => {
    const broken = new QuotaCache(join(dir, "missing-parent-is-fine"));
    await broken.write("deepseek", snapshot("1.00"));
    assert.deepEqual(await broken.read(), { deepseek: snapshot("1.00") });
    // 同一实例继续写：上一轮的成功链不该被重置
    await broken.write("deepseek", snapshot("2.00"));
    assert.deepEqual((await broken.read())["deepseek"], snapshot("2.00"));
  });
});
