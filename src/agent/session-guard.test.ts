/**
 * 会话文件不可变的账（2026-09-18 立规）：protectedPathRefusal 穷尽测 + 闸门
 * 集成——Skip 档也拦，拦在权限档判定之前；读不受限。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
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

describe("createToolCallGate 的禁区前置（2026-09-18）", () => {
  const gate = createToolCallGate(() => "skip", async () => {
    throw new Error("Skip 档不该走到询问");
  }, PROTECTED, CWD);

  test("Skip 档写禁区：拦在权限档判定之前，询问函数根本不被调", async () => {
    const inside = `${SESSIONS}${resolve("/") === "/" ? "/" : "\\"}abc.meta.json`;
    const result = await gate({ toolCallId: "c1", toolName: "write", input: { path: inside } });
    assert.equal(result.block, true);
    if (result.reason !== undefined) assert.match(result.reason, /immutable/);
  });

  test("Skip 档写普通路径：照常放行（不变量不改变 Skip 的语义）", async () => {
    const result = await gate({ toolCallId: "c2", toolName: "write", input: { path: "src/app.ts" } });
    assert.deepEqual(result, {});
  });

  test("Manual 档读禁区：不因禁区触发审批（读不受限）", async () => {
    let asked = 0;
    const manualGate = createToolCallGate(() => "manual", async () => {
      asked += 1;
      return { behavior: "allow" };
    }, PROTECTED, CWD);
    const result = await manualGate({
      toolCallId: "c3",
      toolName: "read",
      input: { path: `${SESSIONS}${resolve("/") === "/" ? "/" : "\\"}abc.jsonl` },
    });
    assert.deepEqual(result, {});
    assert.equal(asked, 1); // 只因 manual 档「全都问」问了一次，不是禁区拦的
  });
});
