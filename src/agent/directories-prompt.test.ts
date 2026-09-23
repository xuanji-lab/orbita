/** describeDirectories 的账：缺席→空串；attached 空省略该段不留占位；workbench 恒出现。 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { describeDirectories } from "./directories-prompt.ts";
import type { TurnDirectories } from "../shared/agent-ipc.ts";

const dirs = (patch: Partial<TurnDirectories> = {}): TurnDirectories => ({
  attached: [],
  workbench: "/Users/u/Library/Application Support/orbita/workbenches/s1",
  ...patch,
});

describe("describeDirectories", () => {
  test("directories 缺席 → 空串（旧测试夹具不带这个字段，不注入这段）", () => {
    assert.equal(describeDirectories("/repo", undefined), "");
  });

  test("有 attached：列出 cwd、每条附加目录与 workbench", () => {
    const text = describeDirectories("/repo/orbita", dirs({ attached: ["/vault/notes", "/data/refs"] }));
    assert.ok(text.includes("Working directory (cwd): /repo/orbita"));
    assert.ok(text.includes("- /vault/notes"));
    assert.ok(text.includes("- /data/refs"));
    assert.ok(
      text.includes("Session workbench: /Users/u/Library/Application Support/orbita/workbenches/s1"),
    );
    assert.ok(text.startsWith("<directories>"));
    assert.ok(text.endsWith("</directories>"));
  });

  test("attached 为空：省略那一段，不留「- (none)」之类的占位", () => {
    const text = describeDirectories("/repo/orbita", dirs());
    assert.ok(!text.includes("Attached directories"));
    assert.ok(!text.includes("- (none)"));
    // Home 会话也总有草稿要落，workbench 恒出现
    assert.ok(text.includes("Session workbench:"));
    assert.ok(text.includes("mkdir -p"));
  });

  test("related 缺席：不含 Parent / Sub-session 段", () => {
    const text = describeDirectories("/repo/orbita", dirs());
    assert.ok(!text.includes("Parent session"));
    assert.ok(!text.includes("Sub-session"));
  });

  test("related 有父：一行 Parent session，带 id 与工作台路径", () => {
    const text = describeDirectories(
      "/repo/orbita",
      dirs({
        related: [{ sessionId: "parent-1", relation: "parent", label: "母任务", path: "/workbenches/parent-1" }],
      }),
    );
    assert.ok(text.includes('Parent session "母任务" (id parent-1) workbench: /workbenches/parent-1'));
    assert.ok(text.includes("private workbenches"));
    assert.ok(text.startsWith("<directories>"));
    assert.ok(text.endsWith("</directories>"));
  });

  test("related 有子：每个子会话各一行 Sub-session", () => {
    const text = describeDirectories(
      "/repo/orbita",
      dirs({
        related: [
          { sessionId: "child-1", relation: "child", label: "先派出的", path: "/workbenches/child-1" },
          { sessionId: "child-2", relation: "child", label: "Sub-session", path: "/workbenches/child-2" },
        ],
      }),
    );
    assert.ok(text.includes('Sub-session "先派出的" (id child-1) workbench: /workbenches/child-1'));
    assert.ok(text.includes('Sub-session "Sub-session" (id child-2) workbench: /workbenches/child-2'));
  });
});
