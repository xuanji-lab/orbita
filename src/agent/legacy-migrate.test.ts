import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planLegacyMigration, LEGACY_KINDS } from "./legacy-migrate.ts";
import { assistant, book, result, user } from "./legacy-book-fixture.ts";

describe("planLegacyMigration", () => {
  it("一条直链：user / assistant / toolResult 原样，model_change 之类略过", () => {
    const planned = planLegacyMigration(
      book([{ type: "model_change", id: "mc", provider: "p", modelId: "m" }, user("u1", "hi"), assistant("a1", "reading", ["c1"]), result("r1", "c1"), assistant("a2", "done")]),
    );
    assert.ok(planned.ok);
    assert.deepEqual(
      planned.plan.drafts.map((draft) => draft.kind),
      [LEGACY_KINDS.user, LEGACY_KINDS.assistant, LEGACY_KINDS.toolResult, LEGACY_KINDS.assistant],
    );
    assert.deepEqual(planned.plan.drafts[2]?.data, { diagnostics: [] });
    assert.equal(planned.plan.providerSessionId, "sess-1");
    assert.deepEqual(planned.plan.skipped, { model_change: 1 });
  });

  it("压缩：head 指向保留段第一条迁过去的 entry（保留起点是 model_change 时落到它后面那条）", () => {
    const planned = planLegacyMigration(
      book([
        user("u1", "a"),
        assistant("a1", "b"),
        { type: "thinking_level_change", id: "t1", thinkingLevel: "high" },
        user("u2", "c"),
        assistant("a2", "d"),
        { type: "compaction", id: "k1", summary: "S", firstKeptEntryId: "t1", tokensBefore: 10 },
        user("u3", "e"),
      ]),
    );
    assert.ok(planned.ok);
    const drafts = planned.plan.drafts;
    assert.equal(drafts[4]?.kind, LEGACY_KINDS.compaction);
    // drafts：u1 a1 u2 a2 k1 u3 —— 保留段从 u2（下标 2）开始
    assert.equal(drafts[4]?.headRef, 2);
    const text = drafts[4]?.model[0];
    assert.ok(text !== undefined && text.role === "user" && Array.isArray(text.content));
    assert.equal(
      (text.content[0] as { text: string }).text,
      "The conversation history before this point was compacted into the following summary:\n\n<summary>\nS\n</summary>",
    );
  });

  it("压缩的保留起点不在当前分支上、或保留段里没有可迁的 entry：head 落到压缩自己", () => {
    const missing = planLegacyMigration(book([user("u1", "a"), { type: "compaction", id: "k1", summary: "S", firstKeptEntryId: "nope" }]));
    assert.ok(missing.ok);
    assert.equal(missing.plan.drafts[1]?.headRef, "self");
    const onlyMeta = planLegacyMigration(
      book([user("u1", "a"), { type: "label", id: "l1" }, { type: "compaction", id: "k1", summary: "S", firstKeptEntryId: "l1" }]),
    );
    assert.ok(onlyMeta.ok);
    assert.equal(onlyMeta.plan.drafts[1]?.headRef, "self");
  });

  it("回退过的本子只迁当前分支，废枝计数", () => {
    const raw = book([user("u1", "a"), assistant("a1", "old answer"), { ...user("u2", "retry"), parentId: "u1" }, { ...assistant("a2", "new answer"), parentId: "u2" }]);
    const planned = planLegacyMigration(raw);
    assert.ok(planned.ok);
    assert.equal(planned.plan.drafts.length, 3);
    assert.equal(planned.plan.offBranch, 1);
  });

  it("custom_message / branch_summary / bashExecution 变成 user 消息，文案同 pi", () => {
    const planned = planLegacyMigration(
      book([
        { type: "custom_message", id: "cm", customType: "orbita.undo", content: "files restored", display: true },
        { type: "branch_summary", id: "bs", summary: "went elsewhere", fromId: "x" },
        { type: "message", id: "be", message: { role: "bashExecution", command: "ls", output: "a", exitCode: 1, cancelled: false, truncated: false, timestamp: 5 } },
        { type: "message", id: "bx", message: { role: "bashExecution", command: "ls", output: "", exitCode: 0, excludeFromContext: true, timestamp: 6 } },
      ]),
    );
    assert.ok(planned.ok);
    const texts = planned.plan.drafts.map((draft) => JSON.stringify(draft.model[0]?.content));
    assert.equal(texts.length, 3);
    assert.match(texts[0] ?? "", /files restored/);
    assert.match(texts[1] ?? "", /summary of a branch that this conversation came back from:\\n\\n<summary>\\nwent elsewhere<\/summary>/);
    assert.match(texts[2] ?? "", /Ran `ls`\\n```\\na\\n```\\n\\nCommand exited with code 1/);
  });

  it("认不出的东西整条不迁，给一句原因", () => {
    const edit = planLegacyMigration(book([user("u1", "a"), { type: "context_edit", id: "e1", targetId: "u1" }]));
    assert.equal(edit.ok, false);
    const unknownType = planLegacyMigration(book([{ type: "hologram", id: "h1" }]));
    assert.equal(unknownType.ok, false);
    const unknownRole = planLegacyMigration(book([{ type: "message", id: "x", message: { role: "oracle", content: [] } }]));
    assert.equal(unknownRole.ok, false);
    const noHeader = planLegacyMigration('{"type":"message","id":"a"}\n');
    assert.equal(noHeader.ok, false);
    if (!noHeader.ok) assert.match(noHeader.reason, /读不出来/);
    const future = planLegacyMigration(book([], { version: 9 }));
    assert.equal(future.ok, false);
  });
});
