/** resolveFileRoots 的账：顺序 session → workspace → attached（→ 不进树的 attachments），label 与 exists 的来源。 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFileRoots } from "./roots.ts";
import { SessionStore } from "../session/store.ts";
import { WorkspaceStore } from "../workspace/store.ts";
import type { SessionMeta } from "../../shared/session.ts";

const S1 = "11111111-2222-3333-4444-555555555555";
const WS_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

let dir = "";
let workspaces: WorkspaceStore;
let sessions: SessionStore;

const meta = (patch: Partial<SessionMeta> = {}): SessionMeta => ({
  id: S1,
  title: "",
  titleSource: "derived",
  stats: null,
  cwd: "/repo/x",
  providerId: "zai",
  modelId: "glm-5.3",
  mode: "plan",
  thinkingLevel: "medium",
  createdAt: 1000,
  updatedAt: 1000,
  ...patch,
  workspaceId: patch.workspaceId ?? null,
  piSessionFile: patch.piSessionFile ?? null,
  pinned: patch.pinned ?? false,
  archived: patch.archived ?? false,
  recentQueries: patch.recentQueries ?? [],
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-files-roots-"));
  workspaces = new WorkspaceStore(dir, join(dir, "Orbita"));
  sessions = new SessionStore(join(dir, "sessions"), join(dir, "workbenches"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("resolveFileRoots", () => {
  test("Home 会话：session + workspace（+ attachments），session 工作台未建 exists=false", async () => {
    await workspaces.ensureHome(); // Home 目录建出来，workspace 根该是 true
    const roots = await resolveFileRoots(workspaces, sessions, { sessionId: S1, workspaceId: null });
    assert.equal(roots.length, 3);
    const [sessionRoot, workspaceRoot] = roots;
    assert.equal(sessionRoot?.kind, "session");
    assert.equal(sessionRoot?.label, "Untitled task"); // meta 还没落 → 退 fallback
    assert.equal(sessionRoot?.exists, false); // 工作台首次写入才建
    assert.equal(workspaceRoot?.kind, "workspace");
    assert.equal(workspaceRoot?.label, "Home");
    assert.equal(workspaceRoot?.path, workspaces.defaultPath());
    assert.equal(workspaceRoot?.exists, true);
  });

  test("sessionId null（新任务还没发首条消息）：不出 session 根，其余照常", async () => {
    await workspaces.ensureHome();
    const roots = await resolveFileRoots(workspaces, sessions, { sessionId: null, workspaceId: null });
    assert.deepEqual(
      roots.map((root) => root.kind),
      ["workspace"],
    );
  });

  test("会话有标题：session 根的 label 就是标题", async () => {
    await sessions.ensureSession(meta({ title: "给文件面板起个名字" }));
    const [sessionRoot] = await resolveFileRoots(workspaces, sessions, { sessionId: S1, workspaceId: null });
    assert.equal(sessionRoot?.label, "给文件面板起个名字");
  });

  test("有工作区带两个 attached：四个根，顺序 session → workspace → attached，label 各归各", async () => {
    const attached1 = join(dir, "vault");
    const attached2 = join(dir, "refs");
    await mkdir(attached1);
    await mkdir(attached2);
    await mkdir(join(dir, "Orbita", "my-repo"), { recursive: true }); // 工作区目录也得是真的，exists 才是 true
    const ws = await workspaces.add(join(dir, "Orbita", "my-repo"));
    await workspaces.rename(ws.id, "我的仓库");
    const withAttached = await workspaces.attachDir(ws.id, attached1);
    await workspaces.attachDir(ws.id, attached2);
    assert.equal(withAttached.length, 1);

    const roots = await resolveFileRoots(workspaces, sessions, { sessionId: S1, workspaceId: ws.id });
    assert.deepEqual(
      roots.map((root) => root.kind),
      ["session", "workspace", "attached", "attached", "attachments"],
    );
    assert.equal(roots[1]?.label, "我的仓库");
    assert.equal(roots[1]?.path, join(dir, "Orbita", "my-repo"));
    assert.deepEqual(
      roots.slice(2, 4).map((root) => root.label),
      ["vault", "refs"], // attached label = 路径末段，顺序是挂上的顺序
    );
    assert.deepEqual(
      roots.map((root) => root.exists),
      [false, true, true, true, false], // session 工作台与附件目录没建是 false，其余都是真目录
    );
  });

  test("Home 挂了目录：workspace 根（Home）之后照常出现 attached 根", async () => {
    await workspaces.ensureHome();
    const attached = join(dir, "home-vault");
    await mkdir(attached);
    await workspaces.attachDir(null, attached);
    const roots = await resolveFileRoots(workspaces, sessions, { sessionId: S1, workspaceId: null });
    assert.deepEqual(
      roots.map((root) => root.kind),
      ["session", "workspace", "attached", "attachments"],
    );
    assert.equal(roots[1]?.label, "Home");
    assert.deepEqual(
      roots.slice(2, 3).map((root) => root.path),
      [await realpath(attached)], // 存的是 realpath 后的真身
    );
  });

  test("attached 目录被挪走：exists=false，照列不静默吞掉", async () => {
    const attached = join(dir, "gone");
    await mkdir(attached);
    const ws = await workspaces.add(join(dir, "Orbita", "my-repo"));
    await workspaces.attachDir(ws.id, attached);
    await rm(attached, { recursive: true });
    const roots = await resolveFileRoots(workspaces, sessions, { sessionId: S1, workspaceId: ws.id });
    assert.equal(roots.find((root) => root.kind === "attached")?.exists, false);
  });

  test("workspaceId 指向已删的工作区：workspace 根退 Home，不带 attached", async () => {
    await workspaces.ensureHome();
    const roots = await resolveFileRoots(workspaces, sessions, {
      sessionId: S1,
      workspaceId: "00000000-0000-0000-0000-000000000000",
    });
    assert.deepEqual(
      roots.map((root) => root.label),
      ["Untitled task", "Home", `${S1}.attachments`],
    );
  });

  test("attachments 根：指向本会话的附件副本目录，附图 / 附件落盘后 exists=true", async () => {
    const before = await resolveFileRoots(workspaces, sessions, { sessionId: S1, workspaceId: null });
    const root = before.find((entry) => entry.kind === "attachments");
    assert.equal(root?.path, join(dir, "sessions", `${S1}.attachments`));
    assert.equal(root?.exists, false);
    await mkdir(join(dir, "sessions", `${S1}.attachments`), { recursive: true });
    const after = await resolveFileRoots(workspaces, sessions, { sessionId: S1, workspaceId: null });
    assert.equal(after.find((entry) => entry.kind === "attachments")?.exists, true);
  });
});
