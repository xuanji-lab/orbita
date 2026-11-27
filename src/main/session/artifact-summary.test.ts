import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { summarizeArtifacts } from "../../shared/revert.ts";
import { ARTIFACT_BATCH_MAX, artifactSummaries } from "./artifact-summary.ts";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const change = (path: string) => ({ path, before: { kind: "absent" }, after: { kind: "absent" }, added: 1, removed: 0 });
const turn = (paths: string[], web: string[] = []) => ({ role: "file-turn", id: `t${paths.join()}`, timestamp: 1, changes: paths.map(change), ...(web.length > 0 ? { webArtifacts: web } : {}) });

describe("产物摘要", () => {
  test("同一路径跨轮只算一次；旁路网页产物也算；扩展名按次数从多到少、同数按字母；没扩展名的不列", () => {
    const summary = summarizeArtifacts([
      { changes: [change("/w/a.md"), change("/w/b.md"), change("/w/Makefile")] as never },
      { changes: [change("/w/a.md"), change("/w/c.TS")] as never, webArtifacts: ["/w/out/r.html"] },
    ]);
    assert.deepEqual(summary, { files: 5, exts: [".md", ".html", ".ts"] });
    assert.deepEqual(summarizeArtifacts([]), { files: 0, exts: [] });
  });

  test("批量读：坏 id（拼路径的）与非字符串丢掉、重复去重、读失败的不在回执里；上限截断", async () => {
    const reads: string[] = [];
    const store = {
      readRawLog: async (id: string) => {
        reads.push(id);
        if (id === ID_B) throw new Error("gone");
        return [turn(["/w/x.png"]), { role: "user" }] as never;
      },
    };
    const out = await artifactSummaries(store, [ID_A, ID_A, "../../etc/passwd", 3, ID_B]);
    assert.deepEqual(out, { [ID_A]: { files: 1, exts: [".png"] } });
    assert.deepEqual(reads.sort(), [ID_A, ID_B].sort());
    assert.deepEqual(await artifactSummaries(store, "nope"), {});
    const many = Array.from({ length: ARTIFACT_BATCH_MAX + 5 }, (_, i) => `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`);
    reads.length = 0;
    await artifactSummaries(store, many);
    assert.equal(reads.length, ARTIFACT_BATCH_MAX);
  });
});
