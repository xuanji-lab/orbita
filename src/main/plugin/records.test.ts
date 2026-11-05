import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { parsePluginRecords, parseScope, readPluginRecords, serializePluginRecords } from "./records.ts";

const good = {
  source: { kind: "copy", from: "/a" },
  version: "1.0.0",
  installedAt: 1,
  updatedAt: 2,
  scope: { kind: "global" },
  placement: { kind: "global" },
  config: { k: "v", n: 3, b: true, l: ["x"], bad: { nested: 1 } },
  secretKeys: ["s", 4],
};

describe("parsePluginRecords", () => {
  test("读出规范记录；配置只留合法值，secretKeys 只留字符串；按名字排序", () => {
    const records = parsePluginRecords({ plugins: { zeta: good, alpha: good } });
    assert.deepEqual(records.map((r) => r.name), ["alpha", "zeta"]);
    assert.deepEqual(records[0]?.config, { k: "v", n: 3, b: true, l: ["x"] });
    assert.deepEqual(records[0]?.secretKeys, ["s"]);
  });

  test("坏的单条（名字不合法、来源缺、范围缺）跳过，不挡其它", () => {
    const records = parsePluginRecords({
      plugins: {
        ok: good,
        "Bad Name": good,
        nosource: { ...good, source: null },
        noscope: { ...good, scope: "global" },
        wrongsource: { ...good, source: { kind: "link" } },
      },
    });
    assert.deepEqual(records.map((r) => r.name), ["ok"]);
  });

  test("内置来源（builtin）可读可写回：不带路径，原样往返", () => {
    const records = parsePluginRecords({ plugins: { "plugin-creator": { ...good, source: { kind: "builtin" }, scope: { kind: "off" } } } });
    assert.deepEqual(records[0]?.source, { kind: "builtin" });
    assert.deepEqual(parsePluginRecords(serializePluginRecords(records)), records);
  });

  test("没有 placement 时：启用的以有效范围为位置；停用的回到所有工作区", () => {
    const enabled = parsePluginRecords({ plugins: { a: { ...good, placement: undefined, scope: { kind: "workspaces", ids: ["w"] } } } })[0];
    assert.deepEqual(enabled?.placement, { kind: "workspaces", ids: ["w"] });
    const off = parsePluginRecords({ plugins: { a: { ...good, placement: undefined, scope: { kind: "off" } } } })[0];
    assert.deepEqual(off?.placement, { kind: "global" });
  });

  test("顶层形状不对给空", () => {
    assert.deepEqual(parsePluginRecords(null), []);
    assert.deepEqual(parsePluginRecords({ plugins: [] }), []);
    assert.deepEqual(parsePluginRecords({}), []);
  });

  test("来回序列化不丢信息", () => {
    const records = parsePluginRecords({ plugins: { a: good } });
    assert.deepEqual(parsePluginRecords(serializePluginRecords(records)), records);
  });
});

describe("parseScope", () => {
  test("workspaces 去重、丢空 id；不认的形状是 null", () => {
    assert.deepEqual(parseScope({ kind: "workspaces", ids: ["a", "a", "", 3, "b"] }), { kind: "workspaces", ids: ["a", "b"] });
    assert.equal(parseScope({ kind: "workspaces" }), null);
    assert.equal(parseScope({ kind: "all" }), null);
    assert.equal(parseScope("off"), null);
  });
});

describe("readPluginRecords", () => {
  test("文件不在是空；JSON 写坏抛（把读不出来说成没装会让人去重装）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-plugin-records-"));
    try {
      assert.deepEqual(await readPluginRecords(join(dir, "plugins.json")), []);
      await writeFile(join(dir, "plugins.json"), "{ broken", "utf8");
      await assert.rejects(readPluginRecords(join(dir, "plugins.json")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
