import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { capabilitiesField, capabilitiesLine, hasModule, isChatOnly, namedInstalled, parseCapabilities } from "./capabilities.ts";
import { parseSessionMeta } from "./session.ts";

describe("能力集：解析与规范化", () => {
  test("缺席 = 全带（undefined）；空数组 = 只带基础；base 丢掉", () => {
    assert.deepEqual(parseCapabilities(undefined), { ok: true, value: undefined });
    assert.deepEqual(parseCapabilities(null), { ok: true, value: undefined });
    assert.deepEqual(parseCapabilities([]), { ok: true, value: [] });
    assert.deepEqual(parseCapabilities(["base"]), { ok: true, value: [] });
  });

  test("顺序与重复不影响结果：模块按规范顺序、用户装的按字典序排在后面", () => {
    const a = parseCapabilities(["mcp:zotero", "browser", "pdf-docx", " browser ", "skill:lit-intake"]);
    const b = parseCapabilities(["pdf-docx", "skill:lit-intake", "browser", "mcp:zotero"]);
    assert.deepEqual(a, { ok: true, value: ["pdf-docx", "browser", "mcp:zotero", "skill:lit-intake"] });
    assert.deepEqual(a, b);
  });

  test("纯聊天：none 单独出现；和别的混写是错", () => {
    assert.deepEqual(parseCapabilities(["none"]), { ok: true, value: ["none"] });
    const mixed = parseCapabilities(["none", "browser"]);
    assert.equal(mixed.ok, false);
  });

  test("点名不存在的模块 / 前缀后没名字 / 不是字符串列表：给模型看的错误，列出可用的", () => {
    const unknown = parseCapabilities(["browser", "qgis"]);
    assert.equal(unknown.ok, false);
    if (!unknown.ok) {
      assert.match(unknown.error, /Unknown capability "qgis"/);
      assert.match(unknown.error, /pdf-docx, image, browser/);
    }
    assert.equal(parseCapabilities(["skill:"]).ok, false);
    assert.equal(parseCapabilities("browser").ok, false);
    assert.equal(parseCapabilities([1]).ok, false);
  });

  test("hasModule / isChatOnly / namedInstalled", () => {
    assert.equal(hasModule(undefined, "browser"), true);
    assert.equal(hasModule([], "browser"), false);
    assert.equal(hasModule(["none"], "browser"), false);
    assert.equal(isChatOnly(["none"]), true);
    assert.equal(isChatOnly(undefined), false);
    assert.equal(isChatOnly([]), false);
    assert.deepEqual(namedInstalled(["browser", "skill:a", "mcp:b", "skill:c"], "skill:"), ["a", "c"]);
  });

  test("详情页头那行：全带不画；只带基础看给不给说法；纯聊天与模块用口语", () => {
    const words = {
      chatOnly: "只聊天",
      has: (names: string) => `带了：${names}`,
      separator: "、",
      modules: { "pdf-docx": "读 PDF", image: "看图", browser: "浏览器", "docs-slides": "文档", terminal: "终端", store: "配置", tasks: "读会话" },
    };
    assert.equal(capabilitiesLine(undefined, words), null);
    assert.equal(capabilitiesLine([], words), null);
    assert.equal(capabilitiesLine([], { ...words, basicsOnly: "只带读写" }), "只带读写");
    assert.equal(capabilitiesLine(["none"], words), "只聊天");
    assert.equal(capabilitiesLine(["pdf-docx", "browser", "skill:lit-intake"], words), "带了：读 PDF、浏览器、lit-intake");
  });
});

describe("能力集：会话 meta 的读法", () => {
  const base = { id: "a", cwd: "/x", providerId: "p", modelId: "m", createdAt: 1 };
  test("旧 meta 没有这个键 = 全带（不出现这个键）", () => {
    const meta = parseSessionMeta(base);
    assert.notEqual(meta, null);
    assert.equal("capabilities" in (meta ?? {}), false);
  });
  test("合法清单读回规范形；坏值当缺席（全带），不让整条会话读坏", () => {
    assert.deepEqual(parseSessionMeta({ ...base, capabilities: ["browser", "pdf-docx"] })?.capabilities, ["pdf-docx", "browser"]);
    assert.deepEqual(parseSessionMeta({ ...base, capabilities: [] })?.capabilities, []);
    assert.deepEqual(parseSessionMeta({ ...base, capabilities: ["none"] })?.capabilities, ["none"]);
    assert.equal("capabilities" in (parseSessionMeta({ ...base, capabilities: ["qgis"] }) ?? {}), false);
    assert.equal("capabilities" in (parseSessionMeta({ ...base, capabilities: "browser" }) ?? {}), false);
    assert.deepEqual(capabilitiesField(undefined), {});
  });
});
