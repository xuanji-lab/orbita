import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ImportMcpItem } from "@shared/import";
import { defaultMcpSelection, mcpOriginLabel, mcpStatusLabel, selectedMcpNames } from "./migration-mcp.ts";

function item(name: string, status: ImportMcpItem["status"], reason: string | null = null): ImportMcpItem {
  return { name, transport: "stdio", detail: name, carriesSecrets: false, origins: [{ source: "proma", where: "w" }], status, reason };
}

describe("migration-mcp", () => {
  test("默认勾 new；执行请求只带 new", () => {
    const items = [item("a", "new"), item("b", "in-orbita"), item("c", "unsupported", "SSE")];
    assert.deepEqual([...defaultMcpSelection(items)], ["a"]);
    assert.deepEqual(selectedMcpNames(items, new Set(["a", "b", "c"])), ["a"]);
    assert.equal(mcpStatusLabel(items[1]!), "Already in orbita");
    assert.equal(mcpStatusLabel(items[2]!), "SSE");
    assert.equal(mcpStatusLabel(items[0]!), null);
  });

  test("出处：来源名去重，只在项目里配的写出项目", () => {
    assert.equal(
      mcpOriginLabel(
        [
          { source: "proma", where: "默认工作区" },
          { source: "proma", where: "orbita" },
          { source: "claude-code", where: null },
          { source: "claude-code", where: "/Users/me/repo/app" },
        ],
        "/Users/me",
      ),
      "Proma · Claude Code · Claude Code, only in ~/repo/app",
    );
  });
});
