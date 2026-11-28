import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readCommandCard } from "./builtin-command.ts";

describe("完成卡的读数（readCommandCard）", () => {
  it("逐字段校验：kind / path / title 都在才收下，subtitle 可选", () => {
    assert.deepEqual(readCommandCard({ card: { kind: "export", path: "/w/out.docx", title: "out.docx" } }), {
      kind: "export",
      path: "/w/out.docx",
      title: "out.docx",
    });
    assert.deepEqual(
      readCommandCard({ card: { kind: "doc", path: "/w/a.md", title: "a.md", subtitle: "文档 · a.md" } }),
      { kind: "doc", path: "/w/a.md", title: "a.md", subtitle: "文档 · a.md" },
    );
    assert.equal(readCommandCard({}), null);
    assert.equal(readCommandCard(null), null);
    assert.equal(readCommandCard({ card: { kind: "export", title: "x" } }), null);
    assert.equal(readCommandCard({ card: { kind: "export", path: "", title: "x" } }), null);
    assert.equal(readCommandCard({ card: { kind: "weird", path: "/w/a", title: "x" } }), null);
  });
});
