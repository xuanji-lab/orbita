/**
 * applyModeCascade 的测试：正常路径（父 + 子都切 runtime 与 meta 两侧）、
 * 没有子会话（只切自己）、只切直接子会话（孙辈与别人的子不动——本分支 delegate
 * 拒绝子再派，孙辈只可能来自手改 meta，但级联语义必须守住「一层」）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { PermissionMode } from "../../shared/permission.ts";
import type { SessionMeta } from "../../shared/session.ts";
import { applyModeCascade, type ModeCascadeDeps } from "./mode-cascade.ts";

const PARENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CHILD_1 = "11111111-2222-3333-4444-555555555555";
const CHILD_2 = "22222222-3333-4444-5555-666666666666";
const GRANDCHILD = "33333333-4444-5555-6666-777777777777";
const OTHER_PARENT = "99999999-8888-7777-6666-555555555555";
const OTHER_CHILD = "44444444-5555-6666-7777-888888888888";

const meta = (id: string, parentId?: string): SessionMeta => ({
  id,
  ...(parentId === undefined ? {} : { parentId }),
  title: id.slice(0, 4),
  titleSource: "user",
  cwd: "/repo",
  workspaceId: null,
  providerId: "zai",
  modelId: "glm-5.3",
  mode: "plan",
  thinkingLevel: "medium",
  piSessionFile: null,
  pinned: false,
  archived: false,
  recentQueries: [],
  stats: null,
  createdAt: Number.parseInt(id.slice(0, 8), 16),
  updatedAt: 1,
});

/** 假 deps：只记调用顺序，不做真事。runtime 与 meta 两侧分开记——漏一侧就是 bug。 */
function fakeDeps(list: readonly SessionMeta[]): {
  deps: ModeCascadeDeps;
  runtimeCalls: { sessionId: string; mode: PermissionMode }[];
  storedCalls: { sessionId: string; mode: PermissionMode }[];
} {
  const runtimeCalls: { sessionId: string; mode: PermissionMode }[] = [];
  const storedCalls: { sessionId: string; mode: PermissionMode }[] = [];
  return {
    deps: {
      listSessions: async () => list,
      setRuntimeMode: async (sessionId, mode) => {
        runtimeCalls.push({ sessionId, mode });
      },
      setStoredMode: async (sessionId, mode) => {
        storedCalls.push({ sessionId, mode });
      },
    },
    runtimeCalls,
    storedCalls,
  };
}

test("正常路径：父 + 全部直接子会话在 runtime 与 meta 两侧都切到新档", async () => {
  const { deps, runtimeCalls, storedCalls } = fakeDeps([
    meta(OTHER_PARENT),
    meta(PARENT),
    meta(CHILD_2, PARENT),
    meta(CHILD_1, PARENT),
    meta(OTHER_CHILD, OTHER_PARENT),
  ]);
  await applyModeCascade(deps, PARENT, "skip");
  // 子会话按 createdAt 正序（childSessions 的口径），父在前
  assert.deepEqual(
    runtimeCalls.map((call) => call.sessionId),
    [PARENT, CHILD_1, CHILD_2],
  );
  assert.deepEqual(runtimeCalls, [
    { sessionId: PARENT, mode: "skip" },
    { sessionId: CHILD_1, mode: "skip" },
    { sessionId: CHILD_2, mode: "skip" },
  ]);
  assert.deepEqual(storedCalls, runtimeCalls);
});

test("没有子会话：只切自己，不碰别的会话", async () => {
  const { deps, runtimeCalls, storedCalls } = fakeDeps([
    meta(PARENT),
    meta(OTHER_PARENT),
    meta(OTHER_CHILD, OTHER_PARENT),
  ]);
  await applyModeCascade(deps, PARENT, "manual");
  assert.deepEqual(runtimeCalls, [{ sessionId: PARENT, mode: "manual" }]);
  assert.deepEqual(storedCalls, [{ sessionId: PARENT, mode: "manual" }]);
});

test("只切直接子会话：孙辈与别人的子不进清单", async () => {
  // 孙辈只可能来自手改 meta（delegate 拒绝子再派），但级联必须守住一层
  const { deps, runtimeCalls } = fakeDeps([
    meta(PARENT),
    meta(CHILD_1, PARENT),
    meta(GRANDCHILD, CHILD_1),
    meta(OTHER_CHILD, OTHER_PARENT),
  ]);
  await applyModeCascade(deps, PARENT, "skip");
  assert.deepEqual(
    runtimeCalls.map((call) => call.sessionId),
    [PARENT, CHILD_1],
  );
});

test("子会话切档：没有下级，级联退化为只切自己（单向联动的另一头）", async () => {
  const { deps, runtimeCalls } = fakeDeps([meta(PARENT), meta(CHILD_1, PARENT)]);
  await applyModeCascade(deps, CHILD_1, "skip");
  assert.deepEqual(runtimeCalls, [{ sessionId: CHILD_1, mode: "skip" }]);
});
