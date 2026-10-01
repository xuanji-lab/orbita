import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, readFile, writeFile, stat, lstat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCommand } from "../../shared/agent-ipc.ts";
import type { SessionMeta, SessionRecord } from "../../shared/session.ts";
import { createHash } from "node:crypto";
import { SessionStore } from "./store.ts";
import { executeRevert, executeUndo, planRevert, planUndo, undoNotice, type PiBookEditor } from "./revert.ts";
import type { FileChangePayload, FileTurnRecord } from "../../shared/revert.ts";

const ID = "c1d2e3f4-5a60-4711-8b23-4d5e6f708192";

const meta = (patch: Partial<SessionMeta> = {}): SessionMeta => ({
  id: ID,
  title: "",
  titleSource: "derived",
  stats: null,
  cwd: "/lab",
  providerId: "zai",
  modelId: "glm-5.3",
  mode: "plan",
  thinkingLevel: "medium",
  createdAt: 1000,
  updatedAt: 1000,
  ...patch,
  workspaceId: null,
  piSessionFile: "/lab/pi/session.jsonl",
  pinned: false,
  archived: false,
  recentQueries: [],
});

function userItem(id: string, text: string, timestamp: number): SessionRecord {
  return { id, role: "user", content: [{ type: "text", text }], timestamp };
}

function assistantItem(id: string, timestamp: number): SessionRecord {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    model: { provider: "zai", id: "glm-5.3" },
    timestamp,
    status: "complete",
    stopReason: "stop",
  };
}

/** 记录 editPiBook 命令的假 host——不拉 agent 进程，回执全部成功。 */
function fakeHost(commands: AgentCommand[]): PiBookEditor {
  return { editPiBook: async (command) => void commands.push(command) };
}


function rolesOf(command: AgentCommand | undefined): readonly string[] {
  return command !== undefined && command.type === "revertPiBook" ? command.roles : [];
}

function noticeOf(command: AgentCommand | undefined): string {
  return command !== undefined && command.type === "undoPiBook" ? command.notice : "";
}

let dir = "";
let lab = "";
let store: SessionStore;

async function recordTurn(changes: FileChangePayload[], timestamp: number): Promise<void> {
  await store.recordFileTurn(ID, changes);
  // recordFileTurn 用当下时间；显式改时间戳太贵，测试里按落盘顺序对账即可
  void timestamp;
}

/** 直接落一条带引用的轮尾账（绕过 blob 写入的路径不在本测试范围） */
async function turnRecord(
  id: string,
  changes: { path: string; before: string | null; after: string | null; added: number; removed: number }[],
): Promise<void> {
  const persisted = [];
  for (const change of changes) {
    persisted.push({
      path: change.path,
      before:
        change.before === null
          ? { kind: "absent" as const }
          : { kind: "text" as const, blob: await store.snapshots.save(ID, change.before) },
      after:
        change.after === null
          ? { kind: "absent" as const }
          : { kind: "text" as const, blob: await store.snapshots.save(ID, change.after) },
      added: change.added,
      removed: change.removed,
    });
  }
  const record: FileTurnRecord = { role: "file-turn", id, timestamp: Date.now(), changes: persisted };
  await store.record(ID, record);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-revert-"));
  lab = join(dir, "lab");
  await mkdir(lab, { recursive: true });
  store = new SessionStore(join(dir, "sessions"));
  await store.ensureSession(meta({ cwd: lab }));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("planRevert / executeRevert", () => {
  test("新建文件回退 = 删除；改过的文件还原到最早 before", async () => {
    await writeFile(join(lab, "a.ts"), "agent v1\n", "utf8");
    await writeFile(join(lab, "new.md"), "brand new\n", "utf8");
    await store.record(ID, userItem("u1", "第一句", 1000));
    await store.record(ID, assistantItem("a1", 1100));
    await store.record(ID, userItem("u2", "第二句", 2000));
    await store.record(ID, assistantItem("a2", 2100));
    // 第二轮的轮尾账：改了 a.ts，新建 new.md
    await turnRecord("t2", [
      { path: join(lab, "a.ts"), before: "old\n", after: "agent v1\n", added: 1, removed: 1 },
      { path: join(lab, "new.md"), before: null, after: "brand new\n", added: 2, removed: 0 },
    ]);

    const plan = await planRevert(store, ID, "u2");
    assert.deepEqual(plan.restore, [join(lab, "a.ts")]);
    assert.deepEqual(plan.deletes, [join(lab, "new.md")]);
    assert.deepEqual(plan.userModified, []); // 磁盘 == agent 改完的样子

    const commands: AgentCommand[] = [];
    const outcomes = await executeRevert({ store, host: fakeHost(commands) }, ID, "u2");
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.type, "revertPiBook");
    // roles = u1/a1 前缀
    assert.deepEqual(rolesOf(commands[0]), ["user", "assistant"]);
    assert.deepEqual(outcomes.map((o) => o.outcome).sort(), ["deleted", "restored"]);
    assert.equal(await readFile(join(lab, "a.ts"), "utf8"), "old\n");
    await assert.rejects(() => stat(join(lab, "new.md")));
  });

  test("首条消息回退：roles 为空（pi 侧 resetLeaf），对话回到空", async () => {
    await store.record(ID, userItem("u1", "唯一一句", 1000));
    await store.record(ID, assistantItem("a1", 1100));
    const commands: AgentCommand[] = [];
    await executeRevert({ store, host: fakeHost(commands) }, ID, "u1");
    assert.deepEqual(rolesOf(commands[0]), []);
    // 生效列表只剩界碑本身
    const detail = await store.load(ID);
    assert.equal(detail?.transcript.length, 1);
    assert.equal(detail?.transcript[0]?.role, "revert");
  });

  test("回退折叠生效列表：被撤消息与轮尾账从后读中消失，界碑留下", async () => {
    await store.record(ID, userItem("u1", "q1", 1000));
    await store.record(ID, assistantItem("a1", 1100));
    await store.record(ID, userItem("u2", "q2", 2000));
    await store.record(ID, assistantItem("a2", 2100));
    await turnRecord("t2", [{ path: join(lab, "x.ts"), before: "x0\n", after: "x1\n", added: 1, removed: 1 }]);
    await executeRevert({ store, host: fakeHost([]) }, ID, "u2");
    const detail = await store.load(ID);
    const roles = detail?.transcript.map((record) => record.role);
    assert.deepEqual(roles, ["user", "assistant", "revert"]);
    // 轮尾账 t2 不在生效视图里
    assert.ok(detail?.transcript.every((record) => record.role !== "file-turn"));
  });

  test("多次回退叠加：第二次回退到更早，连第一次的界碑一并折掉", async () => {
    await store.record(ID, userItem("u1", "q1", 1000));
    await store.record(ID, assistantItem("a1", 1100));
    await store.record(ID, userItem("u2", "q2", 2000));
    await store.record(ID, assistantItem("a2", 2100));
    const commands: AgentCommand[] = [];
    await executeRevert({ store, host: fakeHost(commands) }, ID, "u2");
    await executeRevert({ store, host: fakeHost(commands) }, ID, "u1");
    // 第二次的 roles 也是空（生效世界里 u1 之前什么都没有）
    assert.deepEqual(rolesOf(commands[1]), []);
    const detail = await store.load(ID);
    // 回退到 u1 之前 = 把 u1 之后的一切都折掉，第一次的界碑也在其中；只剩新界碑
    assert.equal(detail?.transcript.length, 1);
    assert.equal(detail?.transcript[0]?.role, "revert");
  });

  test("回退后再发一轮再回退：pi 对账用的是生效前缀（含此前回退后的消息）", async () => {
    await store.record(ID, userItem("u1", "q1", 1000));
    await store.record(ID, assistantItem("a1", 1100));
    await executeRevert({ store, host: fakeHost([]) }, ID, "u1");
    await store.record(ID, userItem("u2", "重来", 3000));
    await store.record(ID, assistantItem("a2", 3100));
    const commands: AgentCommand[] = [];
    await executeRevert({ store, host: fakeHost(commands) }, ID, "u2");
    // 生效前缀 = 界碑之前没有消息 → roles 为空（u1/a1 已被折掉）
    assert.deepEqual(rolesOf(commands[0]), []);
  });

  test("用户手改过的文件进警示组，但不拦截执行", async () => {
    await writeFile(join(lab, "a.ts"), "agent v1\n", "utf8");
    await store.record(ID, userItem("u1", "q1", 1000));
    await store.record(ID, assistantItem("a1", 1100));
    await turnRecord("t1", [{ path: join(lab, "a.ts"), before: "old\n", after: "agent v1\n", added: 1, removed: 1 }]);
    // 用户手改
    await writeFile(join(lab, "a.ts"), "user hand edit\n", "utf8");
    const plan = await planRevert(store, ID, "u1");
    assert.deepEqual(plan.userModified, [join(lab, "a.ts")]);
    // 照样执行：直接还原（裁决「直接撤回，但一定要提醒」）
    await executeRevert({ store, host: fakeHost([]) }, ID, "u1");
    assert.equal(await readFile(join(lab, "a.ts"), "utf8"), "old\n");
  });

  test(">1MB / 快照 unrecoverable 的文件：计划里标无法回退，执行记 skipped、不动盘", async () => {
    const big = "b".repeat(1024 * 1024 + 1);
    await writeFile(join(lab, "big.txt"), big, "utf8");
    await store.record(ID, userItem("u1", "q1", 1000));
    await store.record(ID, assistantItem("a1", 1100));
    await store.recordFileTurn(ID, [
      { path: join(lab, "big.txt"), before: { kind: "unrecoverable" }, after: { kind: "text", content: big }, added: 9, removed: 0 },
    ]);
    const plan = await planRevert(store, ID, "u1");
    assert.deepEqual(plan.unrecoverable, [join(lab, "big.txt")]);
    const outcomes = await executeRevert({ store, host: fakeHost([]) }, ID, "u1");
    assert.deepEqual(outcomes, [{ path: join(lab, "big.txt"), outcome: "skipped" }]);
    assert.equal((await readFile(join(lab, "big.txt"), "utf8")).length, big.length);
  });

  test("pi 本子对账失败（roles 漂移）：文件一条不动，不落界碑", async () => {
    await writeFile(join(lab, "a.ts"), "v1\n", "utf8");
    await store.record(ID, userItem("u1", "q1", 1000));
    await store.record(ID, assistantItem("a1", 1100));
    await turnRecord("t1", [{ path: join(lab, "a.ts"), before: "v0\n", after: "v1\n", added: 1, removed: 1 }]);
    const refusing: PiBookEditor = {
      editPiBook: async () => {
        throw new Error("Ledger mismatch");
      },
    };
    await assert.rejects(() => executeRevert({ store, host: refusing }, ID, "u1"), /Ledger mismatch/);
    assert.equal(await readFile(join(lab, "a.ts"), "utf8"), "v1\n");
    const detail = await store.load(ID);
    assert.ok(detail?.transcript.every((record) => record.role !== "revert"));
  });

  test("快照正文按内容寻址：两轮相同内容只存一份 blob", async () => {
    await store.recordFileTurn(ID, [{ path: join(lab, "a.ts"), before: { kind: "absent" }, after: { kind: "text", content: "same\n" }, added: 1, removed: 0 }]);
    await store.recordFileTurn(ID, [{ path: join(lab, "a.ts"), before: { kind: "text", content: "same\n" }, after: { kind: "text", content: "same2\n" }, added: 1, removed: 1 }]);
    const detail = await store.load(ID);
    const turns = detail?.transcript.filter((record) => record.role === "file-turn") ?? [];
    const first = turns[0] as FileTurnRecord;
    const second = turns[1] as FileTurnRecord;
    const expected = `${createHash("sha1").update("same\n", "utf8").digest("hex")}.txt`;
    assert.equal(first.changes[0]?.after.kind === "text" ? first.changes[0].after.blob : "", expected);
    assert.equal(second.changes[0]?.before.kind === "text" ? second.changes[0].before.blob : "", expected);
    void recordTurn;
  });
});

describe("planRevert 对已还原的文件", () => {
  test("那一轮先被单独撤销过（新建文件已删、改过的文件已回去）→ 回退时不报「你的修改」", async () => {
    // 磁盘已是还原目标：new.md 不在、a.ts 是 before
    await writeFile(join(lab, "a.ts"), "old\n", "utf8");
    await store.record(ID, userItem("u1", "第一句", 1000));
    await store.record(ID, assistantItem("a1", 1100));
    await turnRecord("t1", [
      { path: join(lab, "a.ts"), before: "old\n", after: "agent v1\n", added: 1, removed: 1 },
      { path: join(lab, "new.md"), before: null, after: "brand new\n", added: 1, removed: 0 },
    ]);
    const plan = await planRevert(store, ID, "u1");
    assert.deepEqual(plan.userModified, []);
    // 已是目标状态：不进「将还原 / 将删除」清单
    assert.deepEqual(plan.restore, []);
    assert.deepEqual(plan.deletes, []);
  });

  test("磁盘既不是 agent 改完的样子、也不是还原目标 → 仍报「你的修改」", async () => {
    await writeFile(join(lab, "a.ts"), "hand edited\n", "utf8");
    await store.record(ID, userItem("u1", "第一句", 1000));
    await store.record(ID, assistantItem("a1", 1100));
    await turnRecord("t1", [
      { path: join(lab, "a.ts"), before: "old\n", after: "agent v1\n", added: 1, removed: 1 },
    ]);
    const plan = await planRevert(store, ID, "u1");
    assert.deepEqual(plan.userModified, [join(lab, "a.ts")]);
  });
});

describe("planUndo / executeUndo", () => {
  async function twoTurnsSameFile(): Promise<void> {
    await writeFile(join(lab, "a.ts"), "v2\n", "utf8");
    await store.record(ID, userItem("u1", "q1", 1000));
    await store.record(ID, assistantItem("a1", 1100));
    await turnRecord("t1", [{ path: join(lab, "a.ts"), before: "v0\n", after: "v1\n", added: 1, removed: 1 }]);
    await store.record(ID, userItem("u2", "q2", 2000));
    await store.record(ID, assistantItem("a2", 2100));
    await turnRecord("t2", [{ path: join(lab, "a.ts"), before: "v1\n", after: "v2\n", added: 1, removed: 1 }]);
  }

  test("撤销中间一轮：还原到该轮 before；后续轮也改过同一文件 → 警示组点名", async () => {
    await twoTurnsSameFile();
    const plan = await planUndo(store, ID, "t1");
    assert.deepEqual(plan.restore, [join(lab, "a.ts")]);
    // 磁盘是 v2，t1 的 after 是 v1 → 用户手改过（其实是后续轮改的——两种都该警示）
    assert.deepEqual(plan.userModified, [join(lab, "a.ts")]);
    assert.deepEqual(plan.laterTouched, [join(lab, "a.ts")]);
    const commands: AgentCommand[] = [];
    await executeUndo({ store, host: fakeHost(commands) }, ID, "t1");
    // 还原到 t1 之前 = v0
    assert.equal(await readFile(join(lab, "a.ts"), "utf8"), "v0\n");
    const command = commands[0];
    assert.equal(command?.type, "undoPiBook");
    assert.ok(noticeOf(commands[0]).includes("a.ts"));
  });

  test("撤销最后一轮：laterTouched 为空，userModified 只在真手改时出现", async () => {
    await twoTurnsSameFile();
    const plan = await planUndo(store, ID, "t2");
    assert.deepEqual(plan.laterTouched, []);
    assert.deepEqual(plan.userModified, []); // 磁盘 v2 == t2 after v2
    await executeUndo({ store, host: fakeHost([]) }, ID, "t2");
    assert.equal(await readFile(join(lab, "a.ts"), "utf8"), "v1\n");
  });

  test("撤销通知的正文点名文件与「不再在盘上」", () => {
    const notice = undoNotice({
      role: "file-turn",
      id: "t",
      timestamp: 1,
      changes: [{ path: "/w/a.ts", before: { kind: "absent" }, after: { kind: "text", blob: "x" }, added: 1, removed: 0 }],
    });
    assert.ok(notice.includes("/w/a.ts"));
    assert.ok(notice.includes("no longer on disk"));
  });

  test("撤销记录落盘后：readLog 里轮尾账还在（对话不动），undo 标记在场", async () => {
    await twoTurnsSameFile();
    await executeUndo({ store, host: fakeHost([]) }, ID, "t2");
    const detail = await store.load(ID);
    assert.ok(detail?.transcript.some((record) => record.role === "file-turn"));
    assert.ok(detail?.transcript.some((record) => record.role === "undo"));
    // 消息一条没少
    assert.equal(detail?.transcript.filter((record) => record.role === "user").length, 2);
  });
});

describe("字节级还原：符号链接 / 权限位", () => {
  test("还原目标是符号链接：链接仍是链接，内容写到链接指向的真实文件", async (t) => {
    const real = join(lab, "real.ts");
    const link = join(lab, "link.ts");
    await writeFile(real, "agent v1\n", "utf8");
    try {
      await symlink(real, link);
    } catch {
      // Windows：非管理员且未开开发者模式时无权创建符号链接——跳过而不是红
      return t.skip("此环境无法创建符号链接（Windows 需管理员权限或开发者模式）");
    }
    await store.record(ID, userItem("u1", "q1", 1000));
    await store.record(ID, assistantItem("a1", 1100));
    // pi 的 write / edit 跟随链接改的是 real.ts，tracker 记的路径是 link
    await turnRecord("t1", [{ path: link, before: "old\n", after: "agent v1\n", added: 1, removed: 1 }]);

    const outcomes = await executeRevert({ store, host: fakeHost([]) }, ID, "u1");
    assert.deepEqual(outcomes, [{ path: link, outcome: "restored" }]);
    // rename 不得把链接换成普通文件
    assert.ok((await lstat(link)).isSymbolicLink());
    assert.equal(await readFile(real, "utf8"), "old\n");
  });

  test("还原保持原文件的权限位（0755）", async () => {
    const path = join(lab, "run.sh");
    await writeFile(path, "agent v1\n", { encoding: "utf8", mode: 0o755 });
    await store.record(ID, userItem("u1", "q1", 1000));
    await store.record(ID, assistantItem("a1", 1100));
    await turnRecord("t1", [{ path, before: "old\n", after: "agent v1\n", added: 1, removed: 1 }]);
    await executeRevert({ store, host: fakeHost([]) }, ID, "u1");
    assert.equal(await readFile(path, "utf8"), "old\n");
    if (process.platform === "win32") return; // Windows 的 mode 只有只读位，跳过断言
    assert.equal((await stat(path)).mode & 0o777, 0o755);
  });
});
