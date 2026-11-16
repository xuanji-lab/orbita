/**
 * 会话文件不可变的账（2026-09-18 立规）：protectedPathRefusal 穷尽测 + 闸门
 * 集成——Skip 档也拦，拦在权限档判定之前；读不受限。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { createToolCallGate, protectedPathRefusal } from "./permission.ts";

const SESSIONS = resolve("/app-data/orbita/sessions");
const PI_SESSIONS = resolve("/app-data/orbita/pi-sessions");
const PROTECTED = [SESSIONS, PI_SESSIONS];
const CWD = resolve("/project");

describe("protectedPathRefusal", () => {
  test("write/edit：路径落在禁区内拒（含相对路径解析），外面放行", () => {
    const inside = `${SESSIONS}${resolve("/") === "/" ? "/" : "\\"}abc.meta.json`;
    assert.match(protectedPathRefusal("write", { path: inside }, PROTECTED, CWD) ?? "", /immutable/);
    assert.match(protectedPathRefusal("edit", { path: `${SESSIONS}${resolve("/") === "/" ? "/" : "\\"}x.jsonl` }, PROTECTED, CWD) ?? "", /immutable/);
    // 相对路径（相对 cwd 解析后不在禁区）
    assert.equal(protectedPathRefusal("write", { path: "src/app.ts" }, PROTECTED, CWD), null);
    // 禁区本身也是目标（写目录/移动都算）
    assert.match(protectedPathRefusal("write", { path: SESSIONS }, PROTECTED, CWD) ?? "", /immutable/);
  });

  test("bash/powershell：命令串里出现禁区路径就拒（分隔符变体也算），普通命令放行", () => {
    const forward = `cat ${SESSIONS.replaceAll("\\", "/")}/abc.jsonl`;
    assert.match(protectedPathRefusal("bash", { command: forward }, PROTECTED, CWD) ?? "", /immutable/);
    const backslash = `type "${SESSIONS}\\abc.meta.json"`;
    assert.match(protectedPathRefusal("powershell", { command: backslash }, PROTECTED, CWD) ?? "", /immutable/);
    assert.equal(protectedPathRefusal("bash", { command: "git status" }, PROTECTED, CWD), null);
    // 只读命令也拦（字面量拦分不出读写）——拒绝理由必须指明改用 ls/read 工具，别让模型以为自己在写
    const readOnly = protectedPathRefusal("bash", { command: `ls -lt "${SESSIONS}/" | head -20` }, PROTECTED, CWD) ?? "";
    assert.match(readOnly, /shell commands may not reference it/);
    assert.match(readOnly, /use the read tool \(not the shell\)/);
    assert.doesNotMatch(readOnly, /grep|find tools|permission mode/);
    // 相邻前缀不算命中：/orbita/sessions-extra 不是禁区
    assert.equal(
      protectedPathRefusal("bash", { command: `rm -rf ${SESSIONS}-extra` }, PROTECTED, CWD),
      null,
    );
  });

  test("读不受限：read/grep 指向禁区照常放行——「只能读」正是要保的状态", () => {
    assert.equal(
      protectedPathRefusal("read", { path: `${SESSIONS}${resolve("/") === "/" ? "/" : "\\"}abc.jsonl` }, PROTECTED, CWD),
      null,
    );
    assert.equal(protectedPathRefusal("grep", { pattern: "x", path: SESSIONS }, PROTECTED, CWD), null);
  });

  test("不在拦截面上的工具不检查；禁区清单为空不检查", () => {
    assert.equal(protectedPathRefusal("create_skill", { slug: "x" }, PROTECTED, CWD), null);
    assert.equal(protectedPathRefusal("bash", { command: `rm -rf ${SESSIONS}` }, [], CWD), null);
  });
});

describe("createToolCallGate 的禁区（2026-09-18；2026-11-16 起没有权限档，闸门只剩它与抬超时）", () => {
  const gate = createToolCallGate(PROTECTED, CWD);

  test("写禁区：拦", () => {
    const inside = `${SESSIONS}${resolve("/") === "/" ? "/" : "\\"}abc.meta.json`;
    const result = gate({ toolCallId: "c1", toolName: "write", input: { path: inside } });
    assert.equal(result.block, true);
    if (result.reason !== undefined) assert.match(result.reason, /immutable/);
  });

  test("写普通路径：放行", () => {
    const result = gate({ toolCallId: "c2", toolName: "write", input: { path: "src/app.ts" } });
    assert.deepEqual(result, {});
  });

  test("读禁区、跨会话读：放行（读不受限）", () => {
    assert.deepEqual(gate({ toolCallId: "c3", toolName: "read", input: { path: join(SESSIONS, "a.jsonl") } }), {});
    assert.deepEqual(gate({ toolCallId: "c4", toolName: "read_task", input: { task: "素材task" } }), {});
  });
});
