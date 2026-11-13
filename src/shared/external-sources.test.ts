import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isExternalSourceEnabled, parseExternalSourceSwitches } from "./external-sources.ts";
import { parseSettings } from "./settings.ts";

describe("外部来源的开关", () => {
  test("缺席 = 开；只认已知来源与布尔值；一个都不剩不落键", () => {
    assert.equal(isExternalSourceEnabled(undefined, "codex"), true);
    assert.equal(isExternalSourceEnabled({ codex: false }, "codex"), false);
    assert.equal(isExternalSourceEnabled({ codex: false }, "proma"), true);
    assert.deepEqual(parseExternalSourceSwitches({ codex: false, proma: true, cursor: false, zcode: "no" }), { codex: false, proma: true });
    assert.equal(parseExternalSourceSwitches({ cursor: false }), undefined);
    assert.equal(parseExternalSourceSwitches([false]), undefined);
  });

  test("随设置一起解析与落盘（重启后保持）", () => {
    const parsed = parseSettings({ externalSources: { "claude-code": false, bogus: true } });
    assert.deepEqual(parsed.externalSources, { "claude-code": false });
    assert.deepEqual(parseSettings(JSON.parse(JSON.stringify(parsed))).externalSources, { "claude-code": false });
    assert.equal(parseSettings({}).externalSources, undefined);
  });
});
