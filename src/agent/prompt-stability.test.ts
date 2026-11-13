/** 提示词稳定性指纹的账：分段哈希、工具名单排序稳定、diff 报段名。 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  diffFingerprints,
  promptFingerprints,
  stabilityLogLine,
  TOOLS_FINGERPRINT_KEY,
} from "./prompt-stability.ts";

const segments = () => [
  { name: "pi-base", text: "base" },
  { name: "permission", text: "permission text" },
];

describe("promptFingerprints", () => {
  test("每段一档 + 工具名单一档；同输入两次算逐字节相同", () => {
    const a = promptFingerprints(segments(), ["bash", "read"]);
    const b = promptFingerprints(segments(), ["bash", "read"]);
    assert.deepEqual(a, b);
    assert.ok(a["pi-base"]);
    assert.ok(a["permission"]);
    assert.ok(a[TOOLS_FINGERPRINT_KEY]);
  });

  test("工具名单顺序抖动不算变（排序后哈希）", () => {
    assert.equal(
      promptFingerprints(segments(), ["bash", "read"])[TOOLS_FINGERPRINT_KEY],
      promptFingerprints(segments(), ["read", "bash"])[TOOLS_FINGERPRINT_KEY],
    );
  });

  test("工具名单内容变了 → tools 档变", () => {
    assert.notEqual(
      promptFingerprints(segments(), ["bash"])[TOOLS_FINGERPRINT_KEY],
      promptFingerprints(segments(), ["bash", "mcp__x__y"])[TOOLS_FINGERPRINT_KEY],
    );
  });
});

describe("diffFingerprints", () => {
  test("完全相同 → 空数组（前缀稳定）", () => {
    const prints = promptFingerprints(segments(), ["bash"]);
    assert.deepEqual(diffFingerprints(prints, promptFingerprints(segments(), ["bash"])), []);
  });

  test("某段文本变了 → 只报那一段", () => {
    const prev = promptFingerprints(segments(), ["bash"]);
    const next = promptFingerprints(
      [{ name: "pi-base", text: "base" }, { name: "permission", text: "changed!" }],
      ["bash"],
    );
    assert.deepEqual(diffFingerprints(prev, next), ["permission"]);
  });

  test("段被移除 → 报 -name（移除也是前缀变化）", () => {
    const prev = promptFingerprints(segments(), ["bash"]);
    const next = promptFingerprints([{ name: "pi-base", text: "base" }], ["bash"]);
    assert.deepEqual(diffFingerprints(prev, next), ["-permission"]);
  });
});

describe("stabilityLogLine", () => {
  test("格式带 session 与段名清单，供 stderr 归因", () => {
    assert.equal(stabilityLogLine("s1", ["permission", "-directories"]), "session=s1 前缀变化: permission, -directories");
  });
});
