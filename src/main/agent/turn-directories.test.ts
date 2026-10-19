/** resolveTurnDirectories 的账：有工作区带 attachedDirs、Home 恒空、workbench = workbenches/<id>。 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTurnDirectories } from "./turn-directories.ts";
import { ChannelStore } from "../channel/store.ts";
import { SessionStore } from "../session/store.ts";
import { WorkspaceStore } from "../workspace/store.ts";

const S1 = "11111111-2222-3333-4444-555555555555";
const WS_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PARENT = "22222222-3333-4444-5555-666666666666";
const CHILD = "33333333-4444-5555-6666-777777777777";

let dir = "";
let workspaces: WorkspaceStore;
let sessions: SessionStore;
let channels: ChannelStore;

const baseMeta = {
  title: "",
  titleSource: "derived" as const,
  cwd: "/repo",
  workspaceId: null,
  piSessionFile: null,
  pinned: false,
  archived: false,
  recentQueries: [],
  providerId: "zai",
  modelId: "glm-5.3",
  mode: "plan" as const,
  thinkingLevel: "medium" as const,
  stats: null,
  createdAt: 1,
  updatedAt: 1,
};

/**
 * 直接写 workspaces.json 真源（挂附加目录的 attach-dir IPC 还没实现，没别的路造出
 * 非空 attachedDirs 的工作区记录）。WorkspaceStore 的缓存是实例级的，写盘后新建实例读。
 */
async function writeWorkspace(attachedDirs: string[]): Promise<void> {
  const payload = {
    version: 2,
    workspaces: [
      {
        id: WS_ID,
        name: "my-repo",
        path: join(dir, "Orbita", "my-repo"),
        createdAt: 1,
        attachedDirs,
      },
    ],
  };
  await writeFile(join(dir, "workspaces.json"), JSON.stringify(payload), "utf8");
  workspaces = new WorkspaceStore(dir, join(dir, "Orbita"));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-turn-dirs-"));
  await mkdir(join(dir, "Orbita", "my-repo"), { recursive: true });
  await writeWorkspace(["/vault/notes", "/data/refs"]);
  sessions = new SessionStore(join(dir, "sessions"), join(dir, "workbenches"));
  channels = new ChannelStore(join(dir, "channels"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("resolveTurnDirectories", () => {
  test("有工作区：attached = 那条工作区记录的 attachedDirs，workbench = workbenches/<id>", async () => {
    const dirs = await resolveTurnDirectories(workspaces, sessions, channels, {
      sessionId: S1,
      workspaceId: WS_ID,
    });
    // 顺序是用户挂上的顺序（shared/workspace.ts 的契约），装配不重排
    assert.deepEqual(dirs.attached, ["/vault/notes", "/data/refs"]);
    assert.equal(dirs.workbench, join(dir, "workbenches", S1));
  });

  test("attachedDirs 缺席的老工作区记录：按空数组读（磁盘上缺席 = 空数组，shared 契约）", async () => {
    await writeWorkspace([]);
    const dirs = await resolveTurnDirectories(workspaces, sessions, channels, {
      sessionId: S1,
      workspaceId: WS_ID,
    });
    assert.deepEqual(dirs.attached, []);
  });

  test("Home 没挂附加目录：attached 为空，workbench 照常", async () => {
    const dirs = await resolveTurnDirectories(workspaces, sessions, channels, {
      sessionId: S1,
      workspaceId: null,
    });
    assert.deepEqual(dirs.attached, []);
    assert.equal(dirs.workbench, join(dir, "workbenches", S1));
  });

  test("Home 挂了附加目录：attached 清单照常出现（Home 也是一个工作区）", async () => {
    const real = await mkdtemp(join(tmpdir(), "orbita-home-turn-"));
    try {
      await workspaces.attachDir(null, real);
      const dirs = await resolveTurnDirectories(workspaces, sessions, channels, {
        sessionId: S1,
        workspaceId: null,
      });
      assert.deepEqual(dirs.attached, [await realpath(real)]);
      assert.equal(dirs.workbench, join(dir, "workbenches", S1));
    } finally {
      await rm(real, { recursive: true, force: true });
    }
  });

  test("workspaceId 指向已删的工作区：按没有附加目录处理，不拦开轮", async () => {
    const dirs = await resolveTurnDirectories(workspaces, sessions, channels, {
      sessionId: S1,
      workspaceId: "00000000-0000-0000-0000-000000000000",
    });
    assert.deepEqual(dirs.attached, []);
  });

  test("普通会话（没有父子关系）不带 related 字段——缺席 = 没有父子关系", async () => {
    const dirs = await resolveTurnDirectories(workspaces, sessions, channels, {
      sessionId: S1,
      workspaceId: null,
    });
    assert.equal("related" in dirs, false);
  });
});

describe("resolveTurnDirectories 的 related（子会话 2026-09-23 裁决：父子互见对方工作台）", () => {
  test("子会话开轮：related 里有父，label 是父标题，path 是父的工作台", async () => {
    // resolveTurnDirectories 靠 sessions.readMeta(sessionId) 拿 parentId——子会话
    // 本身的 meta 要先落盘（delegate 先建子 meta 再开轮，同 applyDelegate 的顺序）
    await sessions.ensureSession({ ...baseMeta, id: PARENT, title: "母任务" });
    await sessions.ensureSession({ ...baseMeta, id: CHILD, title: "子任务", parentId: PARENT });
    const dirs = await resolveTurnDirectories(workspaces, sessions, channels, {
      sessionId: CHILD,
      workspaceId: null,
    });
    assert.deepEqual(dirs.related, [
      { sessionId: PARENT, relation: "parent", label: "母任务", path: sessions.workbenchPath(PARENT) },
    ]);
  });

  test("父标题为空时 label 退回 Parent session", async () => {
    await sessions.ensureSession({ ...baseMeta, id: PARENT, title: "" });
    await sessions.ensureSession({ ...baseMeta, id: CHILD, title: "子任务", parentId: PARENT });
    const dirs = await resolveTurnDirectories(workspaces, sessions, channels, {
      sessionId: CHILD,
      workspaceId: null,
    });
    assert.deepEqual(dirs.related, [
      { sessionId: PARENT, relation: "parent", label: "Parent session", path: sessions.workbenchPath(PARENT) },
    ]);
  });

  test("父会话开轮：related 列出每个子会话，label 是子标题，path 是子的工作台，带通道状态", async () => {
    const CHILD2 = "44444444-5555-6666-7777-888888888888";
    await sessions.ensureSession({ ...baseMeta, id: PARENT, title: "母任务" });
    await sessions.ensureSession({ ...baseMeta, id: CHILD, title: "先派出的", parentId: PARENT });
    await sessions.ensureSession({ ...baseMeta, id: CHILD2, title: "", parentId: PARENT });
    await channels.append(
      { parentId: PARENT, childId: CHILD },
      { id: "m1", from: "parent", author: "model", kind: "task", text: "去做", delivery: "followUp", createdAt: 1 },
    );
    await channels.append(
      { parentId: PARENT, childId: CHILD2 },
      { id: "m2", from: "parent", author: "model", kind: "task", text: "去做2", delivery: "followUp", createdAt: 2 },
    );
    const dirs = await resolveTurnDirectories(workspaces, sessions, channels, {
      sessionId: PARENT,
      workspaceId: null,
    });
    // 只有 task 账本的通道状态是 running；status 只给子会话，父那一项没有
    assert.deepEqual(
      [...(dirs.related ?? [])].sort((a, b) => a.label.localeCompare(b.label)),
      [
        { sessionId: CHILD2, relation: "child", label: "Sub-session", path: sessions.workbenchPath(CHILD2), status: "running" },
        { sessionId: CHILD, relation: "child", label: "先派出的", path: sessions.workbenchPath(CHILD), status: "running" },
      ].sort((a, b) => a.label.localeCompare(b.label)),
    );
  });

  test("台账带状态：子回报 done 的通道状态是 done，没回报的是 running（父那一项没有 status 键）", async () => {
    await sessions.ensureSession({ ...baseMeta, id: PARENT, title: "母任务" });
    await sessions.ensureSession({ ...baseMeta, id: CHILD, title: "干完活的", parentId: PARENT });
    await channels.append(
      { parentId: PARENT, childId: CHILD },
      { id: "m1", from: "parent", author: "model", kind: "task", text: "去做", delivery: "followUp", createdAt: 1 },
    );
    await channels.append(
      { parentId: PARENT, childId: CHILD },
      { id: "m2", from: "child", author: "model", kind: "done", text: "做完了", delivery: "followUp", createdAt: 2 },
    );
    const dirs = await resolveTurnDirectories(workspaces, sessions, channels, {
      sessionId: PARENT,
      workspaceId: null,
    });
    const childEntry = (dirs.related ?? []).find((entry) => entry.relation === "child");
    assert.deepEqual(childEntry, {
      sessionId: CHILD,
      relation: "child",
      label: "干完活的",
      path: sessions.workbenchPath(CHILD),
      status: "done",
    });
    // 子会话开轮看父：父那一项不带 status（通道状态是父看子的概念，反向不存在）
    const childDirs = await resolveTurnDirectories(workspaces, sessions, channels, {
      sessionId: CHILD,
      workspaceId: null,
    });
    const parentEntry = (childDirs.related ?? []).find((entry) => entry.relation === "parent");
    assert.equal(parentEntry !== undefined && "status" in parentEntry, false);
  });

  test("台账跳过已完成（completion !== open）的子会话：不列、不占 8 条名额", async () => {
    const DONE_CHILD = "55555555-6666-7777-8888-999999999999";
    await sessions.ensureSession({ ...baseMeta, id: PARENT, title: "母任务" });
    await sessions.ensureSession({ ...baseMeta, id: CHILD, title: "还在干的", parentId: PARENT });
    // completion 翻 done 的子会话：判据是会话收尾状态，与通道是否回报过 done 无关
    await sessions.ensureSession({ ...baseMeta, id: DONE_CHILD, title: "收尾归档的", parentId: PARENT, completion: "done" });
    for (const childId of [CHILD, DONE_CHILD]) {
      await channels.append(
        { parentId: PARENT, childId },
        { id: `t-${childId}`, from: "parent", author: "model", kind: "task", text: "去做", delivery: "followUp", createdAt: 1 },
      );
    }
    const dirs = await resolveTurnDirectories(workspaces, sessions, channels, {
      sessionId: PARENT,
      workspaceId: null,
    });
    assert.deepEqual(
      (dirs.related ?? []).map((entry) => entry.sessionId),
      [CHILD],
    );
  });

  test("子会话超过 8 条：只留最后活动最近的 8 条（按 lastAt 倒序截断）", async () => {
    await sessions.ensureSession({ ...baseMeta, id: PARENT, title: "母任务" });
    const ids = Array.from({ length: 9 }, (_, index) => `cccccccc-0000-0000-0000-00000000000${index + 1}`);
    for (const [index, childId] of ids.entries()) {
      await sessions.ensureSession({ ...baseMeta, id: childId, title: `第 ${index + 1} 块`, parentId: PARENT });
      await channels.append(
        { parentId: PARENT, childId },
        {
          id: `t-${index}`,
          from: "parent",
          author: "model",
          kind: "task",
          text: "去做",
          delivery: "followUp",
          createdAt: (index + 1) * 10,
        },
      );
    }
    const dirs = await resolveTurnDirectories(workspaces, sessions, channels, {
      sessionId: PARENT,
      workspaceId: null,
    });
    // lastAt 倒序：最新的在前，截 8 条后丢掉最早的那个（第 1 块，createdAt 10）
    assert.deepEqual(
      (dirs.related ?? []).map((entry) => entry.sessionId),
      [...ids].reverse().slice(0, 8),
    );
  });
});

describe("SessionStore.workbenchPath", () => {
  test("构造不传 workbenchesDir 时从 sessions 目录的父目录派生（测试临时目录天然隔离）", () => {
    const derived = new SessionStore(join(dir, "sessions"));
    assert.equal(derived.workbenchPath(S1), join(dir, "workbenches", S1));
  });

  test("id 不是会话 id 形状就抛（同 metaPath/logPath 的白名单，id 拼进了路径）", () => {
    assert.throws(() => sessions.workbenchPath("../sessions"));
  });
});
