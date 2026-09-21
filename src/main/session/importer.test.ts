/**
 * importer 的测试 —— 两层：
 *
 * 1. **真实样本快照**（testdata/ 的 3 份本机 Proma pi 真源，2026-09-21 取样）：
 *    样本 → 期望 meta / transcript 结构。对着真实数据测是调研 §四.6 的明确教训
 *    （session-cleaner 的历史事故：独立重抄外部格式的 parser 会随内部格式漂移而坏）。
 * 2. **人造边界 fixture**：空会话、坏行、header 缺失、版本超前、v2 迁移重写、
 *    幂等重扫、工作区三规则边界、模型映射、防御路径。全部动态生成在 tmp 目录。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildContextEntries } from "@earendil-works/pi-coding-agent";
import type { Workspace } from "../../shared/workspace.ts";
import type { SessionMeta, SessionRecord } from "../../shared/session.ts";
import type { ImportPlanItem } from "../../shared/import.ts";
import { SessionStore } from "./store.ts";
import { entriesToRecords, mapModel, runImport, scanImport, type RunImporterDeps } from "./importer.ts";

const TESTDATA = join(dirname(fileURLToPath(import.meta.url)), "testdata");

// ---------------------------------------------------------------------------
// 搭台：tmp 里的 Proma 数据根 + orbita 侧环境
// ---------------------------------------------------------------------------

let root = "";
let promaRoot = "";
let sessionsDir = "";
let piSessionDir = "";
let store: SessionStore;
/** 预铸 id 队列：测试要可预测 */
let idQueue: string[] = [];
let seq = 0;

const takeId = (): string => idQueue.shift() ?? `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

const orbitaWorkspace = (path: string, id = "11111111-1111-4111-8111-111111111111"): Workspace => ({
  id,
  name: path.split("/").pop() ?? path,
  path,
  createdAt: 1,
});

const REGISTERED = [
  { providerId: "zai-coding", modelId: "glm-5.3" },
  { providerId: "kimi", modelId: "kimi-k3" },
];
const FALLBACK = { providerId: "zai-coding", modelId: "glm-5.3" };
const DEFAULT_CWD = "/Users/tester";

function deps(overrides: Partial<RunImporterDeps> = {}): RunImporterDeps {
  const base: RunImporterDeps = {
    promaRoot,
    piSessionDir,
    defaultCwd: DEFAULT_CWD,
    workspaces: [],
    existingMetas: [],
    registeredModels: REGISTERED,
    fallbackModel: FALLBACK,
    newId: takeId,
    createWorkspace: async () => undefined,
    persistSession: async (meta, records) => store.commitImported(meta, records),
    ...overrides,
  };
  return base;
}

/** 一条 Proma 索引条目的形状（写索引文件用）。piSessionFile 由 setup 动态补全路径。 */
interface IndexEntry {
  id: string;
  title: string;
  piSessionFile?: string;
  workspaceId?: string;
  modelId?: string;
  createdAt: number;
  updatedAt: number;
  archived?: boolean;
  pinned?: boolean;
  starred?: boolean;
}

async function writeIndex(entries: unknown[]): Promise<void> {
  await writeFile(join(promaRoot, "agent-sessions.json"), JSON.stringify({ version: 2, sessions: entries }));
}

interface PromaWorkspaceFileEntry {
  id: string;
  name: string;
  slug?: string;
  projectRootPath?: string;
}

async function writePromaWorkspaces(entries: PromaWorkspaceFileEntry[]): Promise<void> {
  await writeFile(
    join(promaRoot, "agent-workspaces.json"),
    JSON.stringify({ version: 2, workspaces: entries }),
  );
}

/** 一份最小合法 pi session 文件（header + 一问一答）。cwd 决定三规则的输入。 */
async function writePiSession(
  fileName: string,
  cwd: string,
  lines: unknown[] = [],
  headerExtra: Record<string, unknown> = {},
): Promise<string> {
  const dir = join(promaRoot, "sdk-config", "sessions");
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName);
  const header = { type: "session", version: 3, id: fileName.replace(/^.*_/, "").replace(/\.jsonl$/, ""), timestamp: "2026-09-01T00:00:00.000Z", cwd, ...headerExtra };
  const user = {
    type: "message",
    id: "e1",
    parentId: null,
    timestamp: "2026-09-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text: "第一条用户消息" }], timestamp: 1780000001000 },
  };
  const assistant = {
    type: "message",
    id: "e2",
    parentId: "e1",
    timestamp: "2026-09-01T00:00:02.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "回答" }],
      provider: "proma-x",
      model: "glm-5.3",
      usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 1780000002000,
    },
  };
  const all = [header, user, assistant, ...lines];
  await writeFile(path, all.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orbita-import-"));
  promaRoot = join(root, "proma-dev");
  sessionsDir = join(root, "sessions");
  piSessionDir = join(root, "pi-sessions");
  await mkdir(promaRoot, { recursive: true });
  store = new SessionStore(sessionsDir);
  idQueue = [];
  seq = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 真实样本快照
// ---------------------------------------------------------------------------

describe("真实样本快照（testdata 的 3 份本机 Proma pi 真源）", () => {
  const ORBITA_PATH = "/Users/guanhongli/Documents/repo/orbita";

  /** 2026-09-21 fixtures 里与这 3 份文件对应的索引条目（值从真实数据抄来） */
  const REAL: { file: string; entry: IndexEntry }[] = [
    {
      // cwd = Proma 会话工作台（数据根内）；模型 qwen3.7-max 未注册 → 兜底
      file: "2026-07-20T04-24-59-893Z_019f7dc5-24f5-73e8-8eeb-5fc42e166bd7.jsonl",
      entry: {
        id: "15b136bc-6b8b-4e4a-b2f0-83f4ebf71643",
        title: "查PhD答辩要求文件",
        workspaceId: "8fb68884-009c-4769-8b95-73f20654fafa",
        modelId: "qwen3.7-max",
        createdAt: 1784521400025,
        updatedAt: 1784522308322,
        archived: true,
      },
    },
    {
      // cwd = 数据根内的 workspace-files；starred → pinned；glm-5.3 精确命中
      file: "2026-08-17T12-39-41-391Z_01a00fbc-1c4f-775b-a194-6b141831a363.jsonl",
      entry: {
        id: "bd8e2a4b-6559-4a48-8d23-5d38d21edb5e",
        title: "肖志锋新分支功能解析",
        workspaceId: "8fb68884-009c-4769-8b95-73f20654fafa",
        modelId: "glm-5.3",
        createdAt: 1786969616997,
        updatedAt: 1786970588551,
        archived: true,
        starred: true,
      },
    },
    {
      // cwd = 真实 orbita 仓库 → 同址合并；glm-5.3 命中
      file: "2026-09-21T17-22-30-757Z_01a0c4fd-9ee5-73fc-82a8-78c43b90d20d.jsonl",
      entry: {
        id: "81a23de1-4caa-48a9-bda8-841eddac0923",
        title: "Proma会话导入后续开发顺序",
        workspaceId: "cd9a3438-58b6-446a-a433-7e1888d799e9",
        modelId: "glm-5.3",
        createdAt: 1790010943722,
        updatedAt: 1790011404928,
      },
    },
  ];

  /** Proma 工作区表（真实 fixtures 抄来）：orbita 工作区 + 默认收容区 + 一个无关项目 */
  const PROMA_WORKSPACES: PromaWorkspaceFileEntry[] = [
    { id: "cd9a3438-58b6-446a-a433-7e1888d799e9", name: "orbita", projectRootPath: ORBITA_PATH },
    { id: "8fb68884-009c-4769-8b95-73f20654fafa", name: "默认工作区" }, // 无 projectRootPath = 收容区
    { id: "d2118340-b016-42db-9c2e-5793e16bd037", name: "ddpm-generalization-theory", projectRootPath: "/Users/guanhongli/Documents/repo/ddpm-generalization-theory" },
  ];

  async function setupReal(): Promise<void> {
    for (const { file } of REAL) {
      await mkdir(join(promaRoot, "sdk-config", "sessions"), { recursive: true });
      await copyFile(join(TESTDATA, file), join(promaRoot, "sdk-config", "sessions", file));
    }
    await writePromaWorkspaces(PROMA_WORKSPACES);
    await writeIndex(
      REAL.map(({ file, entry }) => ({ ...entry, piSessionFile: join(promaRoot, "sdk-config", "sessions", file) })),
    );
  }

  test("扫描：三规则的三个出口各占一条，模型映射精确/兜底各就位", async () => {
    await setupReal();
    const report = await scanImport(
      deps({ workspaces: [orbitaWorkspace(ORBITA_PATH, "22222222-2222-4222-8222-222222222222")] }),
    );
    assert.equal(report.plan.length, 3);
    assert.equal(report.skipped.length, 0);
    assert.deepEqual(report.mergedWorkspaceIds, ["22222222-2222-4222-8222-222222222222"]);
    // ddpm 工作区虽然存在，但没有一条会话挂它——不为它新建；3 条会话分别走
    // 收容区×2（TASKS）与同址合并×1，没有新建工作区
    assert.equal(report.newWorkspaces.length, 0);
    assert.equal(report.modelFallbackCount, 1);

    const bySource = new Map(report.plan.map((item) => [item.sourceId, item]));
    // ① 收容区 → TASKS；模型 miss → fallback + importedModel 保原文。
    //    cwd：真实样本的 header cwd 写死着 ~/.proma-dev/...（生产中它命中「数据根内
    //    → 退 defaultCwd」）；测试的 promaRoot 是 tmp，前缀对不上 → 保留原值。
    //    「数据根内退 default」的行为由下面的人造 fixture 单测覆盖，这里断言真实产物
    const defaultBin = bySource.get("15b136bc-6b8b-4e4a-b2f0-83f4ebf71643");
    assert.ok(defaultBin !== undefined);
    assert.equal(defaultBin.workspaceId, null);
    assert.equal(
      defaultBin.cwd,
      "/Users/guanhongli/.proma-dev/agent-workspaces/default/15b136bc-6b8b-4e4a-b2f0-83f4ebf71643",
    );
    assert.equal(defaultBin.modelMatched, false);
    assert.equal(defaultBin.providerId, "zai-coding");
    assert.equal(defaultBin.importedModel, "qwen3.7-max");
    assert.equal(defaultBin.archived, true);
    // ② 同上收容区，但 starred → pinned；glm-5.3 精确命中
    const starred = bySource.get("bd8e2a4b-6559-4a48-8d23-5d38d21edb5e");
    assert.ok(starred !== undefined);
    assert.equal(starred.pinned, true);
    assert.equal(starred.modelMatched, true);
    assert.equal(starred.modelId, "glm-5.3");
    // ③ 同址合并 → 挂 orbita 既有工作区，cwd 取其 path
    const merged = bySource.get("81a23de1-4caa-48a9-bda8-841eddac0923");
    assert.ok(merged !== undefined);
    assert.equal(merged.workspaceId, "22222222-2222-4222-8222-222222222222");
    assert.equal(merged.cwd, ORBITA_PATH);
    // 体量估算 = 3 份样本字节和
    const sizes = await Promise.all(
      REAL.map(({ file }) => readFile(join(TESTDATA, file), "utf8").then((raw) => Buffer.byteLength(raw))),
    );
    assert.equal(report.totalBytes, sizes.reduce((a, b) => a + b, 0));
  });

  test("执行：meta 与 transcript 的结构快照（真实文件派生）", async () => {
    await setupReal();
    const orbita = orbitaWorkspace(ORBITA_PATH, "22222222-2222-4222-8222-222222222222");
    const created: { id: string; name: string; path: string }[] = [];
    const report = await runImport(
      deps({
        workspaces: [orbita],
        createWorkspace: async (ws) => {
          created.push(ws);
        },
      }),
    );
    assert.equal(report.imported, 3);
    assert.equal(report.failed.length, 0);
    assert.deepEqual(report.mergedWorkspaceIds, ["22222222-2222-4222-8222-222222222222"]);
    assert.equal(created.length, 0); // 三条会话没一条要新建工作区

    const metas = (await store.list()).sort((a, b) => a.createdAt - b.createdAt);
    assert.equal(metas.length, 3);

    // —— 逐份对照（结构快照：关键字段写死，transcript 断言形状与不变量而非全文） ——
    const byTitle = new Map(metas.map((meta) => [meta.title, meta]));

    // 样本 1：38 条 message（user 2 / assistant 14 / toolResult 22）+ model/thinking change
    const m1 = byTitle.get("查PhD答辩要求文件");
    assert.ok(m1 !== undefined);
    assert.equal(m1.titleSource, "user");
    assert.equal(m1.mode, "plan");
    assert.equal(m1.workspaceId, null);
    // 同扫描测试：tmp root 对不上真实 ~/.proma-dev 前缀，cwd 保留 header 原值
    assert.equal(
      m1.cwd,
      "/Users/guanhongli/.proma-dev/agent-workspaces/default/15b136bc-6b8b-4e4a-b2f0-83f4ebf71643",
    );
    assert.equal(m1.importedModel, "qwen3.7-max");
    assert.equal(m1.importedFrom, join(promaRoot, "sdk-config", "sessions", REAL[0]!.file));
    assert.equal(m1.createdAt, 1784521400025);
    assert.equal(m1.updatedAt, 1784522308322);
    assert.equal(m1.archived, true);
    assert.equal(m1.pinned, false);
    // pi 副本落在 orbita 自己的目录（自包含），且原字节等长
    const copied = await readFile(m1.piSessionFile ?? "", "utf8");
    const original = await readFile(join(promaRoot, "sdk-config", "sessions", REAL[0]!.file), "utf8");
    assert.equal(copied, original);
    // transcript：38 条（2 user + 14 assistant + 22 tool）
    const detail1 = await store.load(m1.id);
    assert.ok(detail1 !== null);
    const roleCount = (role: string): number => detail1.transcript.filter((r) => r.role === role).length;
    assert.equal(detail1.transcript.length, 38);
    assert.equal(roleCount("user"), 2);
    assert.equal(roleCount("assistant"), 14);
    assert.equal(roleCount("tool"), 22);
    // 首条 user 是那段时间戳系统注入 + 附件请求
    const first = detail1.transcript[0];
    assert.ok(first !== undefined && first.role === "user");
    const text = first.content.find((b) => b.type === "text");
    assert.ok(text !== undefined && text.type === "text");
    assert.ok(text.text.startsWith("**当前时间: Monday, July 20, 2026"));
    // assistant 都带终态（无 streaming）、model 是当时的真源 provider
    for (const record of detail1.transcript) {
      if (record.role !== "assistant") continue;
      assert.notEqual(record.status, "streaming");
      assert.equal(record.model.id === "qwen3.7-max" || record.model.id === "unknown", true);
    }
    // 每条 tool 的 input 都回填自前文 toolCall（grep 工具的入参含 pattern 字段）
    const grepTool = detail1.transcript.find(
      (r) => r.role === "tool" && r.toolName === "grep",
    );
    assert.ok(grepTool !== undefined && grepTool.role === "tool");
    const input = grepTool.input as Record<string, unknown>;
    assert.equal(typeof input["pattern"], "string");
    // 账本：assistant usage 聚合（14 条都有 usage）
    assert.ok(m1.stats !== null);
    assert.ok(m1.stats.tokens.total > 0);

    // 样本 2：36 条 message；recentQueries 从 user 消息派生；starred → pinned
    const m2 = byTitle.get("肖志锋新分支功能解析");
    assert.ok(m2 !== undefined);
    assert.equal(m2.pinned, true);
    assert.equal(m2.providerId, "zai-coding");
    assert.equal(m2.modelId, "glm-5.3");
    const detail2 = await store.load(m2.id);
    assert.ok(detail2 !== null);
    assert.equal(detail2.transcript.length, 36);

    // 样本 3：25 条 message；挂 orbita 工作区；thinkingLevel 从最后一条 change 取
    const m3 = byTitle.get("Proma会话导入后续开发顺序");
    assert.ok(m3 !== undefined);
    assert.equal(m3.workspaceId, "22222222-2222-4222-8222-222222222222");
    assert.equal(m3.cwd, ORBITA_PATH);
    assert.equal(m3.thinkingLevel, "max");
    const detail3 = await store.load(m3.id);
    assert.ok(detail3 !== null);
    assert.equal(detail3.transcript.length, 25);
    // 排序不变量：createdAt 升序落盘
    assert.ok(m1.createdAt < m2.createdAt && m2.createdAt < m3.createdAt);
  });

  test("幂等重扫：第二次执行全部 already-imported，源目录零改动", async () => {
    await setupReal();
    const before = await readFile(join(promaRoot, "agent-sessions.json"), "utf8");
    const first = await runImport(deps({ workspaces: [orbitaWorkspace(ORBITA_PATH)] }));
    assert.equal(first.imported, 3);
    // 第二次要带着第一次落盘的 meta 当幂等底（生产里 IPC 每次现读 store.list()）
    const second = await runImport(deps({ existingMetas: await store.list() }));
    assert.equal(second.imported, 0);
    assert.equal(second.failed.length, 0);
    assert.equal(second.skipped, 3);
    // 源索引一个字节没动（只读边界的回归锚）
    assert.equal(await readFile(join(promaRoot, "agent-sessions.json"), "utf8"), before);
    // 会话数没有翻倍
    assert.equal((await store.list()).length, 3);
  });
});

// ---------------------------------------------------------------------------
// 人造边界
// ---------------------------------------------------------------------------

describe("边界：索引与源文件的坏形态", () => {
  test("空会话（只有 header）也能导入，transcript 为空、title 用索引的", async () => {
    const pi = await writePiSession("2026-09-01T00-00-00-000Z_empty-000000000001.jsonl", "/tmp/project");
    // 清掉一问一答，只留 header
    const headerOnly = (await readFile(pi, "utf8")).split("\n")[0] + "\n";
    await writeFile(pi, headerOnly);
    await writeIndex([{ id: "s-empty", title: "空会话", piSessionFile: pi, createdAt: 1, updatedAt: 2 }]);
    const report = await runImport(deps());
    assert.equal(report.imported, 1);
    const [meta] = await store.list();
    assert.ok(meta !== undefined);
    assert.equal(meta.title, "空会话");
    assert.equal(meta.titleSource, "user");
    const detail = await store.load(meta.id);
    assert.ok(detail !== null);
    assert.equal(detail.transcript.length, 0);
    assert.equal(meta.stats, null);
  });

  test("坏行（半截 JSON）跳过不炸，其余条目照常导入", async () => {
    const pi = await writePiSession("2026-09-01T00-00-00-000Z_badline-0000000001.jsonl", "/tmp/project");
    const lines = (await readFile(pi, "utf8")).split("\n");
    await writeFile(pi, [lines[0], lines[1], '{"type": "message", "id": "brok', lines[2] ?? ""].join("\n"));
    await writeIndex([{ id: "s-badline", title: "坏行", piSessionFile: pi, createdAt: 1, updatedAt: 2 }]);
    const report = await runImport(deps());
    assert.equal(report.imported, 1);
    const [meta] = await store.list();
    const detail = meta ? await store.load(meta.id) : null;
    assert.ok(detail !== null);
    // 坏行被 pi 的 parser 丢弃：header 之外只剩完整的 user + assistant
    assert.equal(detail.transcript.length, 2);
  });

  test("header 缺失 → bad-session-file", async () => {
    const path = join(promaRoot, "sdk-config", "sessions", "x.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ type: "message", id: "m", parentId: null, timestamp: "t", message: {} }) + "\n");
    await writeIndex([{ id: "s-noheader", title: "无头", piSessionFile: path, createdAt: 1, updatedAt: 2 }]);
    const report = await scanImport(deps());
    assert.equal(report.plan.length, 0);
    const skip = report.skipped.find((s) => s.sourceId === "s-noheader");
    assert.ok(skip !== undefined);
    assert.equal(skip.reason, "bad-session-file");
    assert.equal(skip.detail, "no session header");
  });

  test("版本超前（v4）→ bad-session-file，detail 带版本号", async () => {
    const path = join(promaRoot, "sdk-config", "sessions", "v4.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ type: "session", version: 4, id: "x", timestamp: "2026-09-01T00:00:00.000Z", cwd: "/tmp" }) + "\n");
    await writeIndex([{ id: "s-v4", title: "v4", piSessionFile: path, createdAt: 1, updatedAt: 2 }]);
    const report = await scanImport(deps());
    const skip = report.skipped.find((s) => s.sourceId === "s-v4");
    assert.ok(skip !== undefined);
    assert.equal(skip.reason, "bad-session-file");
    assert.match(skip.detail ?? "", /newer than supported/);
  });

  test("v1/v2 文件在内存里迁移，副本落的是 v3 内容（源文件不动）", async () => {
    const pi = await writePiSession("2026-09-01T00-00-00-000Z_v2-0000000000000001.jsonl", "/tmp/project");
    // header 改成 version 2 再读回（模拟旧文件）
    const lines = (await readFile(pi, "utf8")).trim().split("\n");
    const header = JSON.parse(lines[0]!) as Record<string, unknown>;
    header["version"] = 2;
    lines[0] = JSON.stringify(header);
    await writeFile(pi, lines.join("\n") + "\n");
    const before = await readFile(pi, "utf8");

    await writeIndex([{ id: "s-v2", title: "旧版", piSessionFile: pi, createdAt: 1, updatedAt: 2 }]);
    const report = await runImport(deps());
    assert.equal(report.imported, 1);
    // 源文件原样（只读边界）
    assert.equal(await readFile(pi, "utf8"), before);
    // 副本 header 是 v3
    const [meta] = await store.list();
    assert.ok(meta !== undefined);
    const copied = await readFile(meta.piSessionFile ?? "", "utf8");
    const copiedHeader = JSON.parse(copied.split("\n")[0]!) as Record<string, unknown>;
    assert.equal(copiedHeader["version"], 3);
  });

  test("索引坏条目 → bad-index-entry；无 piSessionFile → 只计数不进清单；文件不在 → missing-file", async () => {
    const pi = await writePiSession("2026-09-01T00-00-00-000Z_ok-0000000000000001.jsonl", "/tmp/project");
    await writeIndex([
      { nope: true }, // 坏条目：没有 id
      { id: "s-legacy", title: "claude 时代", createdAt: 1, updatedAt: 2 }, // 无 piSessionFile
      { id: "s-missing", title: "文件丢了", piSessionFile: join(promaRoot, "sdk-config", "sessions", "ghost.jsonl"), createdAt: 1, updatedAt: 2 },
      { id: "s-ok", title: "正常", piSessionFile: pi, createdAt: 1, updatedAt: 2 },
    ]);
    const report = await scanImport(deps());
    assert.equal(report.plan.length, 1);
    assert.equal(report.withoutPiSession, 1);
    const reasons = report.skipped.map((s) => s.reason);
    assert.ok(reasons.includes("bad-index-entry"));
    assert.ok(reasons.includes("missing-file"));
    // bad-index-entry 的占位 id 对得上数
    const bad = report.skipped.find((s) => s.reason === "bad-index-entry");
    assert.ok(bad !== undefined);
    assert.match(bad.sourceId, /^#/);
  });

  test("索引里的 piSessionFile 指向数据根外 → 拒绝（防御）", async () => {
    await writeIndex([{ id: "s-outside", title: "越界", piSessionFile: "/etc/passwd", createdAt: 1, updatedAt: 2 }]);
    const report = await scanImport(deps());
    const skip = report.skipped.find((s) => s.sourceId === "s-outside");
    assert.ok(skip !== undefined);
    assert.equal(skip.reason, "bad-session-file");
    assert.match(skip.detail ?? "", /outside the Proma data root/);
  });

  test("同一次扫描里两条索引指向同一源文件 → 第二条 already-imported", async () => {
    const pi = await writePiSession("2026-09-01T00-00-00-000Z_dup-000000000000001.jsonl", "/tmp/project");
    await writeIndex([
      { id: "s-a", title: "甲", piSessionFile: pi, createdAt: 1, updatedAt: 2 },
      { id: "s-b", title: "乙", piSessionFile: pi, createdAt: 3, updatedAt: 4 },
    ]);
    const report = await scanImport(deps());
    assert.equal(report.plan.length, 1);
    assert.equal(report.plan[0]?.sourceId, "s-a");
    const skip = report.skipped.find((s) => s.sourceId === "s-b");
    assert.ok(skip !== undefined);
    assert.equal(skip.reason, "already-imported");
  });
});

describe("边界：工作区三规则", () => {
  test("同名不同址 → 新建工作区，名沿用 Proma 的；执行时落盘", async () => {
    await writePromaWorkspaces([{ id: "pw-1", name: "orbita-lab", projectRootPath: "/tmp/other-place/orbita-lab" }]);
    const pi = await writePiSession("2026-09-01T00-00-00-000Z_ws-0000000000000001.jsonl", "/tmp/other-place/orbita-lab");
    await writeIndex([{ id: "s-ws", title: "挂工作区", piSessionFile: pi, workspaceId: "pw-1", createdAt: 1, updatedAt: 2 }]);
    // scanImport 与 runImport 内部的重扫各消耗一次 newId：预铸两个同值 id，两次结果都稳定可断
    const WS_ID = "aaaaaaaa-0000-4000-8000-000000000001";
    idQueue = [WS_ID, WS_ID];
    const report = await scanImport(deps({ workspaces: [orbitaWorkspace("/Users/x/orbita-lab", "bbbbbbbb-0000-4000-8000-000000000002")] }));
    assert.equal(report.plan.length, 1);
    assert.equal(report.plan[0]?.workspaceId, WS_ID);
    assert.equal(report.plan[0]?.cwd, "/tmp/other-place/orbita-lab");
    assert.equal(report.newWorkspaces.length, 1);
    assert.equal(report.newWorkspaces[0]?.name, "orbita-lab"); // 名字沿用，不退路径末段（同名不同址也保留）
    // 执行：createWorkspace 被调，会话挂上
    const created: { id: string; name: string; path: string; merged?: boolean }[] = [];
    const run = await runImport(deps({ workspaces: [orbitaWorkspace("/Users/x/orbita-lab", "bbbbbbbb-0000-4000-8000-000000000002")], createWorkspace: async (ws) => {
      created.push(ws);
    } }));
    assert.equal(run.imported, 1);
    assert.deepEqual(created, [{ id: WS_ID, name: "orbita-lab", path: "/tmp/other-place/orbita-lab", merged: false }]);
    const [meta] = await store.list();
    assert.ok(meta !== undefined);
    assert.equal(meta.workspaceId, WS_ID);
  });

  test("同一 Proma 工作区的多条会话共享一次新建（id 一致）", async () => {
    await writePromaWorkspaces([{ id: "pw-shared", name: "shared", projectRootPath: "/tmp/shared" }]);
    const pi1 = await writePiSession("2026-09-01T00-00-00-000Z_sh1-000000000000001.jsonl", "/tmp/shared");
    const pi2 = await writePiSession("2026-09-01T00-01-00-000Z_sh2-000000000000002.jsonl", "/tmp/shared");
    await writeIndex([
      { id: "s-1", title: "一", piSessionFile: pi1, workspaceId: "pw-shared", createdAt: 1, updatedAt: 2 },
      { id: "s-2", title: "二", piSessionFile: pi2, workspaceId: "pw-shared", createdAt: 3, updatedAt: 4 },
    ]);
    idQueue = ["cccccccc-0000-4000-8000-000000000003"];
    const report = await scanImport(deps());
    assert.equal(report.plan.length, 2);
    assert.equal(report.newWorkspaces.length, 1);
    const ids = new Set(report.plan.map((item) => item.workspaceId));
    assert.equal(ids.size, 1);
    assert.equal([...ids][0], "cccccccc-0000-4000-8000-000000000003");
  });

  test("指向已删工作区 → TASKS；无归属 → TASKS 且 cwd 取 header 原值", async () => {
    const pi1 = await writePiSession("2026-09-01T00-00-00-000Z_dead-000000000000001.jsonl", "/tmp/some-project");
    const pi2 = await writePiSession("2026-09-01T00-00-00-000Z_none-000000000000002.jsonl", "/tmp/another");
    await writePromaWorkspaces([{ id: "pw-alive", name: "活", projectRootPath: "/tmp/live" }]);
    await writeIndex([
      { id: "s-dead", title: "已删", piSessionFile: pi1, workspaceId: "pw-deleted", createdAt: 1, updatedAt: 2 },
      { id: "s-none", title: "无归属", piSessionFile: pi2, createdAt: 1, updatedAt: 2 },
    ]);
    const report = await scanImport(deps());
    for (const item of report.plan) {
      assert.equal(item.workspaceId, null);
    }
    assert.equal(report.plan.find((p) => p.sourceId === "s-dead")?.cwd, "/tmp/some-project");
    assert.equal(report.plan.find((p) => p.sourceId === "s-none")?.cwd, "/tmp/another");
  });

  test("symlink 同址：orbita 工作区路径经 symlink 指向 Proma 工作区根 → 合并", async () => {
    const real = await mkdtemp(join(tmpdir(), "orbita-ws-real-"));
    const link = join(root, "ws-link");
    await symlink(real, link);
    await writePromaWorkspaces([{ id: "pw-9", name: "链接", projectRootPath: real }]);
    const pi = await writePiSession("2026-09-01T00-00-00-000Z_sym-000000000000001.jsonl", real);
    await writeIndex([{ id: "s-sym", title: "符号链接", piSessionFile: pi, workspaceId: "pw-9", createdAt: 1, updatedAt: 2 }]);
    const report = await scanImport(deps({ workspaces: [orbitaWorkspace(link, "dddddddd-0000-4000-8000-000000000004")] }));
    assert.equal(report.plan.length, 1);
    assert.equal(report.plan[0]?.workspaceId, "dddddddd-0000-4000-8000-000000000004");
    assert.equal(report.mergedWorkspaceIds.length, 1);
  });

  test("header cwd 为空 → defaultCwd；agent-workspaces.json 读不到 → 全走无归属", async () => {
    const pi = await writePiSession("2026-09-01T00-00-00-000Z_noc-0000000000000001.jsonl", "");
    await writeIndex([{ id: "s-nocwd", title: "空 cwd", piSessionFile: pi, workspaceId: "pw-any", createdAt: 1, updatedAt: 2 }]);
    // 不写 agent-workspaces.json（旧版 Proma 没有）
    const report = await scanImport(deps());
    assert.equal(report.plan.length, 1);
    assert.equal(report.plan[0]?.workspaceId, null);
    assert.equal(report.plan[0]?.cwd, DEFAULT_CWD);
  });

  test("header cwd 落在数据根内（会话工作台路径）→ 退 defaultCwd，不把工具指向只读的别家目录", async () => {
    // 真实数据的主流形态：cwd = <promaRoot>/agent-workspaces/default/<sessionId>。
    // 生产里 promaRoot=~/.proma-dev，这条路径命中「数据根内」判定
    const pi = await writePiSession(
      "2026-09-01T00-00-00-000Z_inside-000000000000001.jsonl",
      join(promaRoot, "agent-workspaces", "default", "some-session"),
    );
    await writeIndex([{ id: "s-inside", title: "工作台 cwd", piSessionFile: pi, createdAt: 1, updatedAt: 2 }]);
    const report = await scanImport(deps());
    assert.equal(report.plan.length, 1);
    assert.equal(report.plan[0]?.cwd, DEFAULT_CWD);
  });
});

describe("边界：模型映射", () => {
  test("归一化命中（大小写/分隔符差）", () => {
    const registered = [{ providerId: "kimi", modelId: "Kimi K3" }];
    const hit = mapModel("kimi-k3", registered, FALLBACK);
    assert.equal(hit.matched, true);
    assert.equal(hit.modelId, "Kimi K3");
  });

  test("精确命中优先；miss 落 fallback；null 落 fallback", () => {
    const registered = [
      { providerId: "a", modelId: "glm-5.3" },
      { providerId: "b", modelId: "GLM-5-3" },
    ];
    assert.deepEqual(mapModel("glm-5.3", registered, FALLBACK), { providerId: "a", modelId: "glm-5.3", matched: true });
    const miss = mapModel("claude-fable-5-1", registered, FALLBACK);
    assert.equal(miss.matched, false);
    assert.deepEqual({ providerId: miss.providerId, modelId: miss.modelId }, FALLBACK);
    assert.equal(mapModel(null, registered, FALLBACK).matched, false);
  });

  test("索引没记模型 → 从 pi 文件兜（最后的 model_change / assistant model）", async () => {
    await writePiSession("2026-09-01T00-00-00-000Z_nm-0000000000000001.jsonl", "/tmp/p", [
      { type: "model_change", id: "mc", parentId: "e2", timestamp: "2026-09-01T00:00:03.000Z", provider: "proma-x", modelId: "kimi-k3" },
    ]);
    await writeIndex([{ id: "s-nomodel", title: "无模型记录", piSessionFile: join(promaRoot, "sdk-config", "sessions", "2026-09-01T00-00-00-000Z_nm-0000000000000001.jsonl"), createdAt: 1, updatedAt: 2 }]);
    const report = await scanImport(deps());
    assert.equal(report.plan.length, 1);
    assert.equal(report.plan[0]?.modelId, "kimi-k3");
    assert.equal(report.plan[0]?.modelMatched, true);
    assert.equal(report.plan[0]?.importedModel, "kimi-k3");
  });
});

describe("边界：entries → records 的翻译规则", () => {
  /** 直接对纯函数喂 entry 数组（不经文件）。 */
  const entry = (value: unknown): SessionEntry => value as SessionEntry;

  test("空 error 回答不进 transcript（与落盘/分支对账同一谓词）", () => {
    const records = entriesToRecords([
      entry({ type: "message", id: "a", parentId: null, timestamp: "t", message: { role: "assistant", content: [], stopReason: "error" } }),
    ]);
    assert.equal(records.length, 0);
  });

  test("带内容的 error 回答保留（status=error）", () => {
    const records = entriesToRecords([
      entry({ type: "message", id: "a", parentId: null, timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "挂了" }], stopReason: "error" } }),
    ]);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.role, "assistant");
    if (records[0]?.role === "assistant") assert.equal(records[0].status, "error");
  });

  test("compaction entry → CompactedRecord 界碑", () => {
    const records = entriesToRecords([
      entry({ type: "compaction", id: "c1", parentId: null, timestamp: "2026-09-01T00:00:00.000Z", summary: "此前的一切", firstKeptEntryId: "e1", tokensBefore: 12345 }),
    ]);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.role, "compacted");
    if (records[0]?.role === "compacted") {
      assert.equal(records[0].summary, "此前的一切");
      assert.equal(records[0].tokensBefore, 12345);
    }
  });

  test("孤儿 toolResult（前文没有对应 toolCall）→ input 落 {}", () => {
    const records = entriesToRecords([
      entry({ type: "message", id: "t1", parentId: null, timestamp: "t", message: { role: "toolResult", toolCallId: "ghost", toolName: "read", content: [{ type: "text", text: "…" }], isError: false } }),
    ]);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.role, "tool");
    if (records[0]?.role === "tool") assert.deepEqual(records[0].input, {});
  });

  test("未知 role / 未知块 / model_change / thinking_level_change 都不进 transcript", () => {
    const records = entriesToRecords([
      entry({ type: "model_change", id: "mc", parentId: null, timestamp: "t", provider: "x", modelId: "y" }),
      entry({ type: "thinking_level_change", id: "tl", parentId: "mc", timestamp: "t", thinkingLevel: "high" }),
      entry({ type: "custom", id: "cu", parentId: "tl", timestamp: "t", customType: "x" }),
      entry({ type: "message", id: "u1", parentId: "cu", timestamp: "t", message: { role: "user", content: [{ type: "sticker", emoji: "x" }], timestamp: 1 } }),
    ]);
    // user 消息进来但未知块被丢 → 空内容块
    assert.equal(records.length, 1);
    assert.equal(records[0]?.role, "user");
    if (records[0]?.role === "user") assert.equal(records[0].content.length, 0);
  });

  test("user 的字符串 content 也翻成 text 块；usage 缺席的 assistant 不带 usage 键", () => {
    const records = entriesToRecords([
      entry({ type: "message", id: "u", parentId: null, timestamp: "t", message: { role: "user", content: "纯字符串", timestamp: 1 } }),
      entry({ type: "message", id: "a", parentId: "u", timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "答" }], stopReason: "stop" } }),
    ]);
    assert.equal(records.length, 2);
    if (records[0]?.role === "user") assert.deepEqual(records[0].content, [{ type: "text", text: "纯字符串" }]);
    if (records[1]?.role === "assistant") assert.equal("usage" in records[1], false);
  });

  test("压缩感知：compaction 之后的派生走 buildContextEntries 的路径（快照对齐 pi 行为）", async () => {
    // 用真实 pi 的 buildContextEntries 驱动（与引擎同一路径），验证 compaction 前的
    // entry 被折叠掉、界碑 + 保留段进入 records
    const entries: SessionEntry[] = [
      entry({ type: "message", id: "m1", parentId: null, timestamp: "2026-09-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "被折叠的旧问题" }], timestamp: 1 } }),
      entry({ type: "compaction", id: "c", parentId: "m1", timestamp: "2026-09-01T00:00:02.000Z", summary: "折叠摘要", firstKeptEntryId: "m2", tokensBefore: 100 }),
      entry({ type: "message", id: "m2", parentId: "c", timestamp: "2026-09-01T00:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "保留的新问题" }], timestamp: 3 } }),
    ];
    const context = buildContextEntries(entries);
    const records = entriesToRecords(context);
    // pi 的规则：界碑 + firstKept 起的条目；旧消息 m1 不在
    assert.equal(records.length, 2);
    assert.equal(records[0]?.role, "compacted");
    assert.equal(records[1]?.role, "user");
    if (records[1]?.role === "user") {
      const text = records[1].content[0];
      assert.ok(text !== undefined && text.type === "text");
      assert.equal(text.text, "保留的新问题");
    }
  });
});

describe("边界：执行的单条失败不炸整批", () => {
  test("persistSession 第二条抛错 → 第一三条照落，failed 有明细", async () => {
    const pi1 = await writePiSession("2026-09-01T00-00-00-000Z_f1-0000000000000001.jsonl", "/tmp/a");
    const pi2 = await writePiSession("2026-09-01T00-01-00-000Z_f2-0000000000000002.jsonl", "/tmp/b");
    const pi3 = await writePiSession("2026-09-01T00-02-00-000Z_f3-0000000000000003.jsonl", "/tmp/c");
    await writeIndex([
      { id: "s-1", title: "一", piSessionFile: pi1, createdAt: 1, updatedAt: 2 },
      { id: "s-2", title: "二", piSessionFile: pi2, createdAt: 3, updatedAt: 4 },
      { id: "s-3", title: "三", piSessionFile: pi3, createdAt: 5, updatedAt: 6 },
    ]);
    const report = await runImport(
      deps({
        persistSession: async (meta, records) => {
          if (meta.title === "二") throw new Error("disk on fire");
          await store.commitImported(meta, records);
        },
      }),
    );
    assert.equal(report.imported, 2);
    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0]?.sourceId, "s-2");
    assert.match(report.failed[0]?.error ?? "", /disk on fire/);
    assert.equal((await store.list()).length, 2);
  });
});
