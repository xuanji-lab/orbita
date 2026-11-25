import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  collapseTaskTags,
  expandTaskTokens,
  insertTaskToken,
  parseTaskRefPayload,
  parseTaskTokens,
  resolveTaskTokens,
  taskRefPayload,
  taskRefToken,
} from "./task-ref.ts";

const A = { id: "1b4f3bdb-aaaa-4bbb-8ccc-111111111111", title: "整理 \"论文\" <综述>" };
const B = { id: "bd3b494c-aaaa-4bbb-8ccc-222222222222", title: "第二条" };

describe("task token", () => {
  test("token 写会话 id 前 12 位（去连字符）", () => {
    assert.equal(taskRefToken(A.id), "[任务 1b4f3bdbaaaa]");
  });
  test("只认十六进制 8 位的形状", () => {
    assert.equal(parseTaskTokens("[任务 1b4f3bdbaaaa] [任务 xyz] [任务 1b4f3bdb]").length, 1);
  });
  test("查不到 / 前缀撞车的 token 不算", () => {
    const text = "[任务 1b4f3bdbaaaa] 与 [任务 deadbeefdead]";
    assert.deepEqual(resolveTaskTokens(text, [A, B]).map((hit) => hit.task.id), [A.id]);
    const twin = { id: "1b4f3bdb-aaaa-zzzz", title: "撞车" };
    assert.equal(resolveTaskTokens(text, [A, twin]).length, 0);
  });
});

describe("expand / collapse", () => {
  test("就地展开，位置保留；标题里的引号与尖括号转义", () => {
    const out = expandTaskTokens("把 [任务 1b4f3bdbaaaa] 和 [任务 bd3b494caaaa] 对比", [A, B]);
    assert.equal(
      out,
      `把 <referenced_task id="${A.id}" title="整理 &quot;论文&quot; &lt;综述&gt;" /> 和 <referenced_task id="${B.id}" title="第二条" /> 对比`,
    );
  });
  test("查不到的 token 原样", () => {
    assert.equal(expandTaskTokens("[任务 1b4f3bdbaaaa]", []), "[任务 1b4f3bdbaaaa]");
  });
  test("展开再折回得到原文与标题（转义可逆）", () => {
    const sent = expandTaskTokens("看 [任务 1b4f3bdbaaaa] 吧", [A]);
    const back = collapseTaskTags(sent);
    assert.equal(back.text, "看 [任务 1b4f3bdbaaaa] 吧");
    assert.deepEqual(back.tasks, [A]);
  });
  test("没有 id 的标签不吞", () => {
    const raw = '<referenced_task title="x" />';
    assert.equal(collapseTaskTags(raw).text, raw);
  });
});

describe("insertTaskToken", () => {
  test("句中插入：前后补空格，光标在 token 后", () => {
    const r = insertTaskToken("ab", 1, A);
    assert.equal(r.text, "a [任务 1b4f3bdbaaaa] b");
    assert.equal(r.inserted, " [任务 1b4f3bdbaaaa] ");
    assert.equal(r.from, 1);
    assert.equal(r.caret, r.text.lastIndexOf("b"));
  });
  test("越界落点夹回末尾", () => {
    assert.equal(insertTaskToken("ab", 99, A).text, "ab [任务 1b4f3bdbaaaa] ");
  });
});

describe("payload", () => {
  test("往返", () => {
    assert.deepEqual(parseTaskRefPayload(taskRefPayload(A)), A);
  });
  test("坏形状返回 null", () => {
    assert.equal(parseTaskRefPayload("nope"), null);
    assert.equal(parseTaskRefPayload('{"id":"zz"}'), null);
    assert.equal(parseTaskRefPayload('{"id":"1b4f3bdb"}'), null);
  });
});
