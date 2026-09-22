/** resolveTurnDirectories 的账：有工作区带 attachedDirs、Home 恒空、workbench = workbenches/<id>。 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTurnDirectories } from "./turn-directories.ts";
import { SessionStore } from "../session/store.ts";
import { WorkspaceStore } from "../workspace/store.ts";

const S1 = "11111111-2222-3333-4444-555555555555";
const WS_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

let dir = "";
let workspaces: WorkspaceStore;
let sessions: SessionStore;

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
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("resolveTurnDirectories", () => {
  test("有工作区：attached = 那条工作区记录的 attachedDirs，workbench = workbenches/<id>", async () => {
    const dirs = await resolveTurnDirectories(workspaces, sessions, {
      sessionId: S1,
      workspaceId: WS_ID,
    });
    // 顺序是用户挂上的顺序（shared/workspace.ts 的契约），装配不重排
    assert.deepEqual(dirs.attached, ["/vault/notes", "/data/refs"]);
    assert.equal(dirs.workbench, join(dir, "workbenches", S1));
  });

  test("attachedDirs 缺席的老工作区记录：按空数组读（磁盘上缺席 = 空数组，shared 契约）", async () => {
    await writeWorkspace([]);
    const dirs = await resolveTurnDirectories(workspaces, sessions, {
      sessionId: S1,
      workspaceId: WS_ID,
    });
    assert.deepEqual(dirs.attached, []);
  });

  test("Home 会话（workspaceId null）：attached 恒空，不读工作区表，workbench 照常", async () => {
    const dirs = await resolveTurnDirectories(workspaces, sessions, {
      sessionId: S1,
      workspaceId: null,
    });
    assert.deepEqual(dirs.attached, []);
    assert.equal(dirs.workbench, join(dir, "workbenches", S1));
  });

  test("workspaceId 指向已删的工作区：按没有附加目录处理，不拦开轮", async () => {
    const dirs = await resolveTurnDirectories(workspaces, sessions, {
      sessionId: S1,
      workspaceId: "00000000-0000-0000-0000-000000000000",
    });
    assert.deepEqual(dirs.attached, []);
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
