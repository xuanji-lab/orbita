/** resolveFileRoots 的账：顺序 session → workspace → attached（→ 不进树的 attachments），label 与 exists 的来源。 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { whitelistedPath } from "./list.ts";
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

describe("resolveFileRoots：专注 / 浏览态的额外预览根（extraWorkspaceId）", () => {
  test("按 id 解出工作区，作第二颗 workspace 根排在会话工作区之后", async () => {
    await workspaces.ensureHome();
    const focus = await workspaces.create("focusrepo"); // 真实目录 + 真实 id
    // 当前会话是 Home（workspaceId null）——专注工作区不在会话根里
    const roots = await resolveFileRoots(workspaces, sessions, {
      sessionId: null,
      workspaceId: null,
      extraWorkspaceId: focus.id,
    });
    const extra = roots.find((entry) => entry.path === focus.path);
    assert.ok(extra !== undefined, "额外根要在清单里");
    assert.equal(extra.kind, "workspace");
    assert.equal(extra.exists, true); // create 建了目录
    // 顺序：session（无）→ workspace(Home) → extra → attachments（无 session）
    assert.equal(roots[1]?.path, focus.path);
  });

  test("与 workspaceId 相同不重复出根；指到不存在的 id 安静缺席", async () => {
    const focus = await workspaces.create("focusrepo");
    const same = await resolveFileRoots(workspaces, sessions, {
      sessionId: null,
      workspaceId: focus.id,
      extraWorkspaceId: focus.id,
    });
    assert.equal(same.filter((entry) => entry.path === focus.path).length, 1);
    const ghost = await resolveFileRoots(workspaces, sessions, {
      sessionId: null,
      workspaceId: null,
      extraWorkspaceId: "00000000-0000-0000-0000-0000000000ff",
    });
    assert.equal(ghost.length, 1); // 只有 Home
  });

  test("白名单一起对账：额外根内放行、根外仍拒、伪造 root 路径拒（renderer 只传 id 这条路才通）", async () => {
    const focus = await workspaces.create("focusrepo");
    const file = join(focus.path, "src", "a.ts");
    await mkdir(join(focus.path, "src"), { recursive: true });
    await writeFile(file, "hello\n", "utf8");
    const req = { sessionId: null, workspaceId: null, extraWorkspaceId: focus.id };
    const roots = await resolveFileRoots(workspaces, sessions, req);
    // 额外根内：放行（root = 专注工作区路径、dir = 其下真实文件）
    const inside = await whitelistedPath(roots, { ...req, root: focus.path, dir: file });
    assert.equal(inside, await realpath(file));
    // 根外（同盘另一个目录）：拒
    await assert.rejects(
      whitelistedPath(roots, { ...req, root: focus.path, dir: join(dir, "outside.txt") }),
    );
    // 伪造 root（没带 extraWorkspaceId 时 renderer 硬塞专注工作区的路径）：拒——
    // 白名单认的是「这次请求的根清单」，不是任何工作区的路径
    const plainRoots = await resolveFileRoots(workspaces, sessions, { sessionId: null, workspaceId: null });
    await assert.rejects(whitelistedPath(plainRoots, { sessionId: null, workspaceId: null, root: focus.path, dir: file }));
  });
});

/** 写一条 cite_pdf 工具结果进某会话的 JSONL（与 session store 写出的形状一致） */
async function citeInLog(sessionId: string, ...paths: string[]): Promise<void> {
  const line = JSON.stringify({
    id: `tool-${paths.length}`,
    role: "tool",
    toolCallId: "call_1",
    toolName: "cite_pdf",
    input: {},
    content: [{ type: "text", text: "Verified" }],
    timestamp: 1,
    details: {
      pdfCitations: paths.map((path, i) => ({ id: `c00${i}`, path, page: 1, start: 0, end: 5, text: "原文原文" })),
    },
    status: "complete",
    isError: false,
  });
  const log = sessions.recordPath(sessionId);
  await mkdir(dirname(log), { recursive: true });
  await writeFile(log, `${line}\n`, { flag: "a" });
}

describe("cited 根：被 cite_pdf 核验过的 PDF 原地打开（根是文件本身）", () => {
  const S2 = "99999999-2222-3333-4444-555555555555";
  let outside = "";
  let cited = "";
  let sibling = "";

  beforeEach(async () => {
    await workspaces.ensureHome();
    outside = join(dir, "other-repo", "references");
    await mkdir(outside, { recursive: true });
    cited = join(outside, "cited.pdf");
    sibling = join(outside, "sibling.pdf");
    await writeFile(cited, "%PDF-1.4 cited");
    await writeFile(sibling, "%PDF-1.4 sibling");
  });

  const rootsOf = (sessionId: string | null) =>
    resolveFileRoots(workspaces, sessions, { sessionId, workspaceId: null });
  const ask = (roots: Awaited<ReturnType<typeof rootsOf>>, root: string, path: string) =>
    whitelistedPath(roots, { sessionId: S1, workspaceId: null, root, dir: path });

  test("引用过的 PDF 出一个 cited 根（排在 attachments 之后，路径就是文件），原地可读", async () => {
    await citeInLog(S1, cited);
    const roots = await rootsOf(S1);
    assert.deepEqual(
      roots.map((root) => root.kind),
      ["session", "workspace", "attachments", "cited"],
    );
    const root = roots.find((entry) => entry.kind === "cited");
    assert.equal(root?.path, cited);
    assert.equal(root?.label, "cited.pdf");
    assert.equal(root?.exists, true);
    assert.equal(await ask(roots, cited, cited), await realpath(cited));
  });

  test("同目录里没被引用过的 PDF：拒（授权精确到文件，不是目录）", async () => {
    await citeInLog(S1, cited);
    const roots = await rootsOf(S1);
    await assert.rejects(ask(roots, cited, sibling)); // 拿 cited 当根读兄弟文件
    await assert.rejects(ask(roots, sibling, sibling)); // 直接报兄弟文件当根：不在清单里
    await assert.rejects(ask(roots, outside, sibling)); // 报它所在的目录当根：同样不在清单里
  });

  test("模型编出来、从没过 cite_pdf 的路径：拒", async () => {
    const roots = await rootsOf(S1);
    assert.equal(roots.filter((root) => root.kind === "cited").length, 0);
    await assert.rejects(ask(roots, cited, cited));
  });

  test("别的会话借不到：S2 的根清单没有 S1 引用过的文件，拿来当根被拒", async () => {
    await citeInLog(S1, cited);
    await sessions.ensureSession(meta({ id: S2 }));
    const roots2 = await rootsOf(S2);
    assert.equal(roots2.filter((root) => root.kind === "cited").length, 0);
    await assert.rejects(whitelistedPath(roots2, { sessionId: S2, workspaceId: null, root: cited, dir: cited }));
    // sessionId 为 null（新任务还没会话）同理
    const roots0 = await rootsOf(null);
    await assert.rejects(whitelistedPath(roots0, { sessionId: null, workspaceId: null, root: cited, dir: cited }));
  });

  test("`..` 绕不出去：路径里夹 `..` 解析后不是那份文件就拒，解析回那份文件才放行", async () => {
    await citeInLog(S1, cited);
    const roots = await rootsOf(S1);
    await mkdir(join(outside, "sub"));
    // 不用 join（它会先把 `..` 折掉）：拼字符串让 `..` 原样交给主进程
    await assert.rejects(ask(roots, cited, `${outside}/sub/../sibling.pdf`));
    await assert.rejects(ask(roots, cited, `${outside}/sub/../../other-repo/references/sibling.pdf`));
    await assert.rejects(ask(roots, `${outside}/sub/../cited.pdf`, cited)); // 根必须与清单里的路径逐字相同
    assert.equal(await ask(roots, cited, `${outside}/sub/../cited.pdf`), await realpath(cited));
  });

  test("软链接：同目录里指向别处的链接拒；指回被引用文件本身的链接 realpath 后就是同一份，放行", async () => {
    await citeInLog(S1, cited);
    const secret = join(dir, "secret.pdf");
    await writeFile(secret, "%PDF-1.4 secret");
    const toSecret = join(outside, "innocent.pdf");
    const toCited = join(outside, "alias.pdf");
    try {
      await symlink(secret, toSecret);
      await symlink(cited, toCited);
    } catch {
      return; // 没有创建软链接的权限（Windows 非管理员）：这条不验，交给别的平台
    }
    const roots = await rootsOf(S1);
    await assert.rejects(ask(roots, cited, toSecret));
    assert.equal(await ask(roots, cited, toCited), await realpath(cited));
  });

  test("被引用的 PDF 之后被换成指向别处的软链接：whitelistedPath 回的是 realpath，调用方据此再判 .pdf（ipc 的 isPdfFile）", async () => {
    await citeInLog(S1, cited);
    const secret = join(dir, "secret.txt");
    await writeFile(secret, "top secret");
    try {
      await rm(cited);
      await symlink(secret, cited);
    } catch {
      return;
    }
    const roots = await rootsOf(S1);
    const real = await ask(roots, cited, cited);
    assert.equal(real, await realpath(secret));
    assert.equal(/\.pdf$/i.test(real), false); // fs:read-pdf 在这一步拒掉
  });

  test("引用过但文件已被删：cited 根 exists=false（面板给「原文件找不到了」），读取被拒", async () => {
    await citeInLog(S1, cited);
    await rm(cited);
    const roots = await rootsOf(S1);
    assert.equal(roots.find((root) => root.kind === "cited")?.exists, false);
    await assert.rejects(ask(roots, cited, cited), /不存在/);
  });
});
