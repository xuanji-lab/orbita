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
});
