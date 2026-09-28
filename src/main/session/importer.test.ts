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
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildContextEntries } from "@earendil-works/pi-coding-agent";
import type { Workspace } from "../../shared/workspace.ts";
import { rootSessions, UNASSIGNED_PROVIDER_ID, type SessionMeta, type SessionRecord } from "../../shared/session.ts";
import type { ImportPlanItem } from "../../shared/import.ts";
import { SessionStore } from "./store.ts";
import { SkillStore } from "../skill/store.ts";
import {
  branchEntries,
  compareSignatures,
  entriesToRecords,
  messageSignature,
  probeClaudeCode,
  probeKimiCode,
  probeOpencode,
  probeZcode,
  probeProma,
  probeReasonix,
  runImport,
  scanGreetingCandidates,
  scanImport,
  selectPlan,
  type RunImporterDeps,
} from "./importer.ts";

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
  attachedDirs: [],
});

const DEFAULT_CWD = "/Users/tester";

function deps(overrides: Partial<RunImporterDeps> = {}): RunImporterDeps {
  const base: RunImporterDeps = {
    promaRoots: [promaRoot],
    piSessionDir,
    defaultCwd: DEFAULT_CWD,
    workspaces: [],
    existingMetas: [],
    newId: takeId,
    ledgerFile: join(root, "imports.jsonl"),
    createWorkspace: async () => undefined,
    persistSession: async (meta, records) => store.commitImported(meta, records),
    refreshSession: async (id, records, patch) => store.commitImportUpdate(id, records, patch),
    skillTarget: { copyFrom: async () => "", importFrom: async () => "" },
    mcpTarget: { add: async () => undefined, reload: async () => undefined },
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
      // cwd = 数据根内的 workspace-files；starred → 星标（不是置顶）；glm-5.3 精确命中
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

    const bySource = new Map(report.plan.map((item) => [item.sourceId, item]));
    // ① 收容区 → TASKS；importedModel 保原文（导入不映射模型）。
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
    assert.equal(defaultBin.importedModel, "qwen3.7-max");
    assert.equal(defaultBin.archived, true);
    // ② 同上收容区，starred → 星标、不置顶
    const starred = bySource.get("bd8e2a4b-6559-4a48-8d23-5d38d21edb5e");
    assert.ok(starred !== undefined);
    assert.equal(starred.pinned, false);
    assert.equal(starred.starred, true);
    assert.equal(starred.importedModel, "glm-5.3");
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
    // updatedAt = 最后一条问答的时刻（索引写的是 1784522308322，晚 36 秒——Proma 的非消息操作推的）
    assert.equal(m1.updatedAt, 1784522272190);
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
    // 首条 user：pi 里是 Proma 拼的时间 / 工作区 / 工作目录 + 原文；testdata 没有界面日志，
    // 走按格式剥的兜底，transcript 里只剩用户那句话（pi 副本上面已断言原字节不变）
    const first = detail1.transcript[0];
    assert.ok(first !== undefined && first.role === "user");
    const text = first.content.find((b) => b.type === "text");
    assert.ok(text !== undefined && text.type === "text");
    assert.ok(text.text.startsWith("会话里有三个附加文件夹，帮我看看里面的哪个文件有提及architecture"));
    assert.ok(!text.text.includes("<workspace_state>"));
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

    // 样本 2：36 条 message；recentQueries 从 user 消息派生；starred → 星标
    const m2 = byTitle.get("肖志锋新分支功能解析");
    assert.ok(m2 !== undefined);
    assert.equal(m2.pinned, false);
    assert.equal(m2.starred, true);
    assert.equal(m2.providerId, UNASSIGNED_PROVIDER_ID);
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

  test("索引里的 piSessionFile 指向数据根外 → 拒绝（防御）；指向旧根 → 接受", async () => {
    // 越界样本得是「盘上真实存在、但不在任何 Proma 数据根里」的文件：不存在的话 importer
    // 在包含性判定之前就把它当 missing-file 了（/etc/passwd 只在 POSIX 上存在）
    const outsideFile = join(root, "outside-the-roots.jsonl");
    await writeFile(outsideFile, "{}\n");
    await writeIndex([{ id: "s-outside", title: "越界", piSessionFile: outsideFile, createdAt: 1, updatedAt: 2 }]);
    const legacyRoot = join(root, "proma-old");
    const legacyDir = join(legacyRoot, "sdk-config", "sessions");
    await mkdir(legacyDir, { recursive: true });
    const legacyFile = join(legacyDir, "2026-09-01T00-00-00-000Z_legacy-00000000001.jsonl");
    const header = { type: "session", version: 3, id: "legacy", timestamp: "2026-09-01T00:00:00.000Z", cwd: "/tmp" };
    await writeFile(legacyFile, JSON.stringify(header) + "\n");
    await writeIndex([
      { id: "s-outside", title: "越界", piSessionFile: outsideFile, createdAt: 1, updatedAt: 2 },
      { id: "s-legacy-root", title: "旧根", piSessionFile: legacyFile, createdAt: 3, updatedAt: 4 },
    ]);
    // 旧根没有自己的索引也算数据根：扫描跳过它的索引，但它仍是源文件路径的合法边界
    const report = await scanImport(deps({ promaRoots: [promaRoot, legacyRoot] }));
    const skip = report.skipped.find((s) => s.sourceId === "s-outside");
    assert.ok(skip !== undefined);
    assert.equal(skip.reason, "bad-session-file");
    assert.match(skip.detail ?? "", /outside the Proma data roots/);
    // 旧根在白名单里 → 正常进计划
    assert.equal(report.plan.length, 1);
    assert.equal(report.plan[0]?.sourceId, "s-legacy-root");
  });

  test("同一次扫描里两条索引指向同一源文件 → 第二条 duplicate，detail 是留下的文件", async () => {
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
    assert.equal(skip.reason, "duplicate");
    assert.equal(skip.detail, pi);
  });
});

describe("边界：工作区三规则", () => {
  test("同名不同址 → 新建工作区，名沿用 Proma 的；执行时落盘", async () => {
    await writePromaWorkspaces([{ id: "pw-1", name: "orbita-lab", projectRootPath: "/tmp/other-place/orbita-lab" }]);
    const pi = await writePiSession("2026-09-01T00-00-00-000Z_ws-0000000000000001.jsonl", "/tmp/other-place/orbita-lab");
    await writeIndex([{ id: "s-ws", title: "挂工作区", piSessionFile: pi, workspaceId: "pw-1", createdAt: 1, updatedAt: 2 }]);
    // 每轮扫描消耗两个 newId：先工作区后会话（importer 里铸序的契约）。
    // scanImport 与 runImport 内部的重扫各走一轮，预铸四个，两次结果都稳定可断
    const WS_ID = "aaaaaaaa-0000-4000-8000-000000000001";
    const SESSION_ID = "aaaaaaaa-0000-4000-8000-00000000000a";
    idQueue = [WS_ID, SESSION_ID, WS_ID, SESSION_ID];
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
    // 工作区 id 先铸（两条会话共享一次新建），其余两个是两条会话自己的 id
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
    // 目录链接用 junction：Windows 上真 symlink 要特权（EPERM），POSIX 上该参数被忽略
    await symlink(real, link, "junction");
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

describe("边界：导入与模型解耦", () => {
  test("索引没记模型 → 从 pi 文件兜（最后的 model_change / assistant model），只存 importedModel", async () => {
    await writePiSession("2026-09-01T00-00-00-000Z_nm-0000000000000001.jsonl", "/tmp/p", [
      { type: "model_change", id: "mc", parentId: "e2", timestamp: "2026-09-01T00:00:03.000Z", provider: "proma-x", modelId: "kimi-k3" },
    ]);
    await writeIndex([{ id: "s-nomodel", title: "无模型记录", piSessionFile: join(promaRoot, "sdk-config", "sessions", "2026-09-01T00-00-00-000Z_nm-0000000000000001.jsonl"), createdAt: 1, updatedAt: 2 }]);
    const report = await scanImport(deps());
    assert.equal(report.plan.length, 1);
    assert.equal(report.plan[0]?.importedModel, "kimi-k3");
  });

  test("没有注册任何模型也照常扫描、照常导入：meta 落占位 provider + 原模型名", async () => {
    // 导入与模型解耦（2026-09-28 裁决）：ImporterDeps 根本没有模型输入，
    // 这个测试锚住「零 provider 环境下扫描出计划、导入落盘占位」的主行为
    const withModel = await writePiSession("2026-09-01T00-00-00-000Z_np-0000000000000001.jsonl", "/tmp/p");
    // 第二条：索引没记模型、pi 文件里也没有任何 assistant model → modelId 落固定占位
    const dir = join(promaRoot, "sdk-config", "sessions");
    await mkdir(dir, { recursive: true });
    const noModel = join(dir, "2026-09-01T00-00-00-000Z_np-0000000000000002.jsonl");
    await writeFile(
      noModel,
      [
        JSON.stringify({ type: "session", version: 3, id: "np-2", timestamp: "2026-09-01T00:00:00.000Z", cwd: "/tmp/p" }),
        JSON.stringify({ type: "message", id: "q1", parentId: null, timestamp: "2026-09-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "问" }], timestamp: 1780000001000 } }),
        JSON.stringify({ type: "message", id: "q2", parentId: "q1", timestamp: "2026-09-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "答" }], stopReason: "stop", timestamp: 1780000002000 } }),
      ].join("\n") + "\n",
    );
    await writeIndex([
      { id: "s-with-model", title: "有模型", piSessionFile: withModel, modelId: "glm-5.3", createdAt: 1, updatedAt: 2 },
      { id: "s-no-model", title: "无模型", piSessionFile: noModel, createdAt: 1, updatedAt: 2 },
    ]);
    const report = await scanImport(deps());
    assert.equal(report.plan.length, 2);
    await runImport(deps(), { sources: ["proma"], sessions: new Set([withModel, noModel]), destinations: [], skills: { skills: new Set(), mode: "copy", scopes: [] }, mcp: new Set() });
    const metas = await store.list();
    assert.equal(metas.length, 2);
    for (const meta of metas) {
      assert.equal(meta.providerId, UNASSIGNED_PROVIDER_ID);
    }
    // 原模型名写进 modelId（缺席时用固定占位 "unknown"），另存 importedModel
    assert.deepEqual(
      [...metas.map((meta) => [meta.modelId, meta.importedModel])].sort(),
      [["glm-5.3", "glm-5.3"], ["unknown", undefined]],
    );
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

  test("压缩过的会话：transcript 是全量历史，界碑落在压缩的原位（不是发给模型的压缩上下文）", () => {
    const entries: SessionEntry[] = [
      entry({ type: "message", id: "m1", parentId: null, timestamp: "2026-09-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "压缩前的旧问题" }], timestamp: 1 } }),
      entry({ type: "compaction", id: "c", parentId: "m1", timestamp: "2026-09-01T00:00:02.000Z", summary: "折叠摘要", firstKeptEntryId: "m2", tokensBefore: 100 }),
      entry({ type: "message", id: "m2", parentId: "c", timestamp: "2026-09-01T00:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "压缩后的新问题" }], timestamp: 3 } }),
    ];
    // 对照：pi 发给模型的上下文里没有 m1
    assert.deepEqual(buildContextEntries(entries).map((e) => e.id), ["c", "m2"]);
    const records = entriesToRecords(branchEntries(entries));
    assert.deepEqual(
      records.map((record) => record.role),
      ["user", "compacted", "user"],
    );
    const first = records[0];
    assert.ok(first?.role === "user" && first.content[0]?.type === "text");
    assert.equal(first.content[0].text, "压缩前的旧问题");
  });

  test("回退重答：旧枝不在当前分支上，与 Proma 界面一致；成环不死循环", () => {
    const user = (id: string, parentId: string | null, text: string): SessionEntry =>
      entry({ type: "message", id, parentId, timestamp: "2026-09-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } });
    const rewound = [user("a", null, "一"), user("b", "a", "旧枝"), user("c", "a", "新枝")];
    assert.deepEqual(branchEntries(rewound).map((e) => e.id), ["a", "c"]);
    const looped = [user("x", "y", "x"), user("y", "x", "y")];
    assert.deepEqual(branchEntries(looped).map((e) => e.id), ["x", "y"]);
    assert.deepEqual(branchEntries([]), []);
  });
});

describe("子会话挂回母会话（Proma 的 parentSessionId → parentId）", () => {
  /** 一对父子的索引条目。子会话的源字段照 Proma 真实形态：delegation 一组字段里只有 parentSessionId 进映射 */
  const child = (entry: Record<string, unknown>, parent: string): Record<string, unknown> => ({
    ...entry,
    parentSessionId: parent,
    rootSessionId: parent,
    delegationRole: "research",
    delegationStatus: "completed",
    delegationDepth: 1,
  });

  test("父子同批：子挂上母会话扫描期铸的 id，落盘后不进左栏；子会话不带生命周期", async () => {
    const parentPi = await writePiSession("2026-09-01T00-00-00-000Z_par-000000000000001.jsonl", "/tmp/proj");
    const childPi = await writePiSession(
      "2026-09-01T00-01-00-000Z_chi-000000000000002.jsonl",
      join(promaRoot, "agent-workspaces", "default", "child-workbench"),
    );
    await writeIndex([
      { id: "p-1", title: "母", piSessionFile: parentPi, createdAt: 1, updatedAt: 2 },
      child({ id: "c-1", title: "子", piSessionFile: childPi, createdAt: 3, updatedAt: 4, archived: true, starred: true }, "p-1"),
    ]);
    const report = await scanImport(deps());
    assert.equal(report.plan.length, 2);
    assert.equal(report.subSessionCount, 1);
    assert.equal(report.orphanedSubSessions, 0);
    const parent = report.plan.find((item) => item.sourceId === "p-1");
    const sub = report.plan.find((item) => item.sourceId === "c-1");
    assert.ok(parent !== undefined && sub !== undefined);
    assert.equal(parent.parentId, null);
    assert.equal(sub.parentId, parent.sessionId);
    // 没有 Proma 工作区归属 → 没有文件夹（页面的「No folder」组）
    assert.equal(parent.folder, null);
    assert.equal(sub.folder, null);
    // cwd 对齐母会话（子自己的 header cwd 是 Proma 工作台路径，本来要退 defaultCwd）
    assert.equal(sub.cwd, "/tmp/proj");
    assert.equal(sub.archived, false);
    assert.equal(sub.pinned, false);
    assert.equal(sub.starred, false);

    const run = await runImport(deps());
    assert.equal(run.imported, 2);
    const metas = await store.list();
    const parentMeta = metas.find((meta) => meta.title === "母");
    const childMeta = metas.find((meta) => meta.title === "子");
    assert.ok(parentMeta !== undefined && childMeta !== undefined);
    assert.equal(parentMeta.parentId, undefined);
    assert.equal(childMeta.parentId, parentMeta.id);
    assert.deepEqual(
      rootSessions(metas).map((meta) => meta.title),
      ["母"],
    );
  });

  test("母会话此前已导入：重扫时子会话挂到那条已存在的 orbita 会话", async () => {
    const parentPi = await writePiSession("2026-09-01T00-00-00-000Z_par-000000000000001.jsonl", "/tmp/proj");
    await writeIndex([{ id: "p-1", title: "母", piSessionFile: parentPi, createdAt: 1, updatedAt: 2 }]);
    const first = await runImport(deps());
    assert.equal(first.imported, 1);
    const [parentMeta] = await store.list();
    assert.ok(parentMeta !== undefined);

    // Proma 这边后来派出了子会话
    const childPi = await writePiSession("2026-09-01T00-01-00-000Z_chi-000000000000002.jsonl", "/tmp/proj");
    await writeIndex([
      { id: "p-1", title: "母", piSessionFile: parentPi, createdAt: 1, updatedAt: 2 },
      child({ id: "c-1", title: "子", piSessionFile: childPi, createdAt: 3, updatedAt: 4 }, "p-1"),
    ]);
    const report = await scanImport(deps({ existingMetas: await store.list() }));
    assert.equal(report.plan.length, 1);
    assert.equal(report.plan[0]?.parentId, parentMeta.id);
    assert.equal(report.subSessionCount, 1);
    assert.equal(report.skipped[0]?.reason, "already-imported");
  });

  test("母会话导不了（文件不在）→ 子按根会话导，计入 orphanedSubSessions", async () => {
    const childPi = await writePiSession("2026-09-01T00-01-00-000Z_chi-000000000000002.jsonl", "/tmp/proj");
    await writeIndex([
      { id: "p-gone", title: "母", piSessionFile: join(promaRoot, "sdk-config", "sessions", "gone.jsonl"), createdAt: 1, updatedAt: 2 },
      child({ id: "c-1", title: "子", piSessionFile: childPi, createdAt: 3, updatedAt: 4 }, "p-gone"),
      child({ id: "c-2", title: "索引里没有母会话", piSessionFile: childPi.replace("chi-", "chj-"), createdAt: 5, updatedAt: 6 }, "p-never"),
    ]);
    await writePiSession("2026-09-01T00-01-00-000Z_chj-000000000000002.jsonl", "/tmp/proj");
    const report = await scanImport(deps());
    assert.equal(report.plan.length, 2);
    for (const item of report.plan) assert.equal(item.parentId, null);
    assert.equal(report.subSessionCount, 0);
    assert.equal(report.orphanedSubSessions, 2);
  });

  test("同批母会话落盘失败 → 子记 failed 不落；母会话先于子执行（哪怕子的 createdAt 更早）；重导挂回", async () => {
    const parentPi = await writePiSession("2026-09-01T00-00-00-000Z_par-000000000000001.jsonl", "/tmp/proj");
    const childPi = await writePiSession("2026-09-01T00-01-00-000Z_chi-000000000000002.jsonl", "/tmp/proj");
    await writeIndex([
      { id: "p-1", title: "母", piSessionFile: parentPi, createdAt: 10, updatedAt: 20 },
      // 时钟偏差：子比母“早”——按 createdAt 排会先落子
      child({ id: "c-1", title: "子", piSessionFile: childPi, createdAt: 5, updatedAt: 6 }, "p-1"),
    ]);
    const calls: string[] = [];
    const first = await runImport(
      deps({
        persistSession: async (meta) => {
          calls.push(meta.title);
          throw new Error("disk on fire");
        },
      }),
    );
    assert.deepEqual(calls, ["母"]);
    assert.equal(first.imported, 0);
    assert.deepEqual(
      first.failed.map((item) => item.sourceId),
      ["p-1", "c-1"],
    );
    assert.match(first.failed[1]?.error ?? "", /parent session failed/);
    assert.equal((await store.list()).length, 0);

    const second = await runImport(deps({ existingMetas: await store.list() }));
    assert.equal(second.imported, 2);
    const metas = await store.list();
    const parentMeta = metas.find((meta) => meta.title === "母");
    assert.ok(parentMeta !== undefined);
    assert.equal(metas.find((meta) => meta.title === "子")?.parentId, parentMeta.id);
  });

  test("工作区对齐：子在另一个 Proma 工作区 → 跟母会话走，它自己那个工作区不再新建", async () => {
    await writePromaWorkspaces([
      { id: "pw-a", name: "alpha", projectRootPath: "/tmp/alpha" },
      { id: "pw-b", name: "beta", projectRootPath: "/tmp/beta" },
    ]);
    const parentPi = await writePiSession("2026-09-01T00-00-00-000Z_par-000000000000001.jsonl", "/tmp/alpha");
    const childPi = await writePiSession("2026-09-01T00-01-00-000Z_chi-000000000000002.jsonl", "/tmp/beta");
    await writeIndex([
      { id: "p-1", title: "母", piSessionFile: parentPi, workspaceId: "pw-a", createdAt: 1, updatedAt: 2 },
      child({ id: "c-1", title: "子", piSessionFile: childPi, workspaceId: "pw-b", createdAt: 3, updatedAt: 4 }, "p-1"),
    ]);
    const report = await scanImport(deps());
    const parent = report.plan.find((item) => item.sourceId === "p-1");
    const sub = report.plan.find((item) => item.sourceId === "c-1");
    assert.ok(parent !== undefined && sub !== undefined);
    assert.equal(sub.workspaceId, parent.workspaceId);
    assert.equal(sub.cwd, "/tmp/alpha");
    // 分组键：母会话取 Proma 工作区的 projectRootPath，子会话跟母会话（而不是它自己的 /tmp/beta）
    assert.equal(parent.folder, "/tmp/alpha");
    assert.equal(sub.folder, "/tmp/alpha");
    assert.equal(parent.source, "proma");
    assert.deepEqual(
      report.newWorkspaces.map((workspace) => workspace.path),
      ["/tmp/alpha"],
    );
  });

  test("多层拍平到根祖先；父链成环 → 两条都按孤儿导（不让它们互指后一起从左栏消失）", async () => {
    const files = await Promise.all(
      ["r", "c", "g", "x", "y"].map((tag, index) =>
        writePiSession(`2026-09-01T00-0${index}-00-000Z_${tag}-00000000000000${index}.jsonl`, "/tmp/proj"),
      ),
    );
    await writeIndex([
      { id: "root", title: "根", piSessionFile: files[0], createdAt: 1, updatedAt: 1 },
      child({ id: "kid", title: "子", piSessionFile: files[1], createdAt: 2, updatedAt: 2 }, "root"),
      child({ id: "grandkid", title: "孙", piSessionFile: files[2], createdAt: 3, updatedAt: 3 }, "kid"),
      child({ id: "loop-x", title: "环 x", piSessionFile: files[3], createdAt: 4, updatedAt: 4 }, "loop-y"),
      child({ id: "loop-y", title: "环 y", piSessionFile: files[4], createdAt: 5, updatedAt: 5 }, "loop-x"),
    ]);
    const report = await scanImport(deps());
    const bySource = new Map(report.plan.map((item) => [item.sourceId, item]));
    const rootId = bySource.get("root")?.sessionId;
    assert.equal(bySource.get("kid")?.parentId, rootId);
    assert.equal(bySource.get("grandkid")?.parentId, rootId);
    assert.equal(bySource.get("loop-x")?.parentId, null);
    assert.equal(bySource.get("loop-y")?.parentId, null);
    assert.equal(report.subSessionCount, 2);
    assert.equal(report.orphanedSubSessions, 2);
  });

  test("explorationParentSessionId（探索分叉）不是子会话，照根会话导", async () => {
    const parentPi = await writePiSession("2026-09-01T00-00-00-000Z_par-000000000000001.jsonl", "/tmp/proj");
    const forkPi = await writePiSession("2026-09-01T00-01-00-000Z_frk-000000000000002.jsonl", "/tmp/proj");
    await writeIndex([
      { id: "p-1", title: "母", piSessionFile: parentPi, createdAt: 1, updatedAt: 2 },
      { id: "f-1", title: "分叉", piSessionFile: forkPi, explorationParentSessionId: "p-1", createdAt: 3, updatedAt: 4 },
    ]);
    const report = await scanImport(deps());
    assert.equal(report.plan.find((item) => item.sourceId === "f-1")?.parentId, null);
    assert.equal(report.subSessionCount, 0);
    assert.equal(report.orphanedSubSessions, 0);
  });
});

describe("Migration 页的选择：去向覆盖、勾选过滤、探测", () => {
  const sub = (entry: Record<string, unknown>, parent: string): Record<string, unknown> => ({
    ...entry,
    parentSessionId: parent,
  });

  /** 两个 Proma 工作区（alpha 已在 orbita、beta 是新文件夹）+ 一个无归属，各一条根会话；alpha 带一条子会话 */
  async function seed(): Promise<{ alphaWs: Workspace }> {
    await writePromaWorkspaces([
      { id: "pw-a", name: "alpha", projectRootPath: "/tmp/alpha" },
      { id: "pw-b", name: "beta", projectRootPath: "/tmp/beta" },
    ]);
    const a = await writePiSession("2026-09-01T00-00-00-000Z_aaa-000000000000001.jsonl", "/tmp/alpha");
    const aChild = await writePiSession("2026-09-01T00-01-00-000Z_aac-000000000000002.jsonl", "/tmp/alpha");
    const b = await writePiSession("2026-09-01T00-02-00-000Z_bbb-000000000000003.jsonl", "/tmp/beta");
    const loose = await writePiSession("2026-09-01T00-03-00-000Z_lll-000000000000004.jsonl", "/tmp/loose");
    await writeIndex([
      { id: "a", title: "阿", piSessionFile: a, workspaceId: "pw-a", createdAt: 1, updatedAt: 1 },
      sub({ id: "a-kid", title: "阿的子", piSessionFile: aChild, workspaceId: "pw-a", createdAt: 2, updatedAt: 2 }, "a"),
      { id: "b", title: "贝", piSessionFile: b, workspaceId: "pw-b", createdAt: 3, updatedAt: 3 },
      { id: "loose", title: "散", piSessionFile: loose, createdAt: 4, updatedAt: 4 },
    ]);
    return { alphaWs: orbitaWorkspace("/tmp/alpha", "11111111-0000-4000-8000-00000000000a") };
  }

  test("默认去向：同址工作区合并、新文件夹新建、无文件夹进 Tasks；folder 就是分组键", async () => {
    const { alphaWs } = await seed();
    const report = await scanImport(deps({ workspaces: [alphaWs] }));
    const by = new Map(report.plan.map((item) => [item.sourceId, item]));
    assert.equal(by.get("a")?.workspaceId, alphaWs.id);
    assert.equal(by.get("a-kid")?.folder, "/tmp/alpha");
    assert.equal(by.get("b")?.folder, "/tmp/beta");
    assert.equal(report.newWorkspaces.length, 1);
    assert.equal(by.get("b")?.workspaceId, report.newWorkspaces[0]?.id);
    assert.equal(by.get("loose")?.folder, null);
    assert.equal(by.get("loose")?.workspaceId, null);
  });

  test("改成 Tasks：不挂工作区、cwd 取文件夹、该组的新建工作区不再出现", async () => {
    const { alphaWs } = await seed();
    const report = await scanImport(deps({ workspaces: [alphaWs] }), [
      { folder: "/tmp/beta", destination: { kind: "tasks" } },
    ]);
    const b = report.plan.find((item) => item.sourceId === "b");
    assert.equal(b?.workspaceId, null);
    assert.equal(b?.cwd, "/tmp/beta");
    assert.deepEqual(report.newWorkspaces, []);
  });

  test("改成另一个既有工作区：子会话跟着母会话过去", async () => {
    const { alphaWs } = await seed();
    const other = orbitaWorkspace("/tmp/elsewhere", "22222222-0000-4000-8000-00000000000b");
    const report = await scanImport(deps({ workspaces: [alphaWs, other] }), [
      { folder: "/tmp/alpha", destination: { kind: "workspace", workspaceId: other.id } },
    ]);
    const by = new Map(report.plan.map((item) => [item.sourceId, item]));
    assert.equal(by.get("a")?.workspaceId, other.id);
    assert.equal(by.get("a")?.cwd, "/tmp/elsewhere");
    assert.equal(by.get("a-kid")?.workspaceId, other.id);
    assert.equal(by.get("a-kid")?.parentId, by.get("a")?.sessionId);
    assert.ok(report.mergedWorkspaceIds.includes(other.id));
  });

  test("去向指向已不存在的工作区 / 给已是工作区的文件夹要新建 → 抛错，不替用户换目的地", async () => {
    const { alphaWs } = await seed();
    await assert.rejects(
      scanImport(deps({ workspaces: [alphaWs] }), [
        { folder: "/tmp/alpha", destination: { kind: "workspace", workspaceId: "gone" } },
      ]),
      /no longer exists/,
    );
    await assert.rejects(
      scanImport(deps({ workspaces: [alphaWs] }), [{ folder: "/tmp/alpha", destination: { kind: "new-workspace" } }]),
      /can't become a new workspace/,
    );
    await assert.rejects(
      scanImport(deps({ workspaces: [alphaWs] }), [{ folder: null, destination: { kind: "new-workspace" } }]),
      /can't become a new workspace/,
    );
  });

  test("只勾一条根会话：它和它的子会话落盘，没勾的不落、它要新建的工作区也不建", async () => {
    const { alphaWs } = await seed();
    const scan = await scanImport(deps({ workspaces: [alphaWs] }));
    const aFile = scan.plan.find((item) => item.sourceId === "a")?.sourceFile ?? "";
    const created: string[] = [];
    const run = await runImport(
      deps({ workspaces: [alphaWs], createWorkspace: async (workspace) => void created.push(workspace.path) }),
      { sessions: new Set([aFile]), destinations: [] },
    );
    assert.equal(run.imported, 2);
    assert.deepEqual(created, []);
    assert.deepEqual(
      (await store.list()).map((meta) => meta.title).sort(),
      ["阿", "阿的子"].sort(),
    );
  });

  test("selectPlan：母会话已导入过的子会话自己可勾；母会话在计划里的子会话不能单独勾", async () => {
    const { alphaWs } = await seed();
    const scan = await scanImport(deps({ workspaces: [alphaWs] }));
    const kid = scan.plan.find((item) => item.sourceId === "a-kid");
    assert.ok(kid !== undefined);
    // 单独勾子会话（母会话在计划里）→ 不算数
    assert.deepEqual(selectPlan(scan.plan, new Set([kid.sourceFile])), []);

    // 母会话先导入（那时 Proma 还没派出这条子会话），之后子会话出现：它的母会话不在
    // 这次计划里，于是它自己成了可勾条目，勾它就挂回已导入的母会话
    const aFile = scan.plan.find((item) => item.sourceId === "a")?.sourceFile ?? "";
    const index = JSON.parse(await readFile(join(promaRoot, "agent-sessions.json"), "utf8")) as { sessions: { id: string }[] };
    await writeIndex(index.sessions.filter((entry) => entry.id !== "a-kid"));
    await runImport(deps({ workspaces: [alphaWs] }), { sessions: new Set([aFile]), destinations: [] });
    await writeIndex(index.sessions);
    const later = await scanImport(deps({ workspaces: [alphaWs], existingMetas: await store.list() }));
    const lateKid = later.plan.find((item) => item.sourceId === "a-kid");
    assert.ok(lateKid !== undefined);
    const picked = selectPlan(later.plan, new Set([lateKid.sourceFile]));
    assert.deepEqual(picked.map((item) => item.sourceId), ["a-kid"]);
    const parentMeta = (await store.list()).find((meta) => meta.title === "阿");
    assert.equal(picked[0]?.parentId, parentMeta?.id);
  });

  test("probeProma：只 stat 索引；有索引的根各列一组路径，一个都没有时列第一个候选根", async () => {
    const other = join(root, ".proma");
    await mkdir(other, { recursive: true });
    const missing = await probeProma([other, promaRoot], join(root, "fallback"));
    assert.equal(missing.found, false);
    assert.ok(missing.paths.includes(join(other, "agent-sessions.json")));
    assert.ok(!missing.paths.includes(join(promaRoot, "agent-sessions.json")));
    assert.ok((await probeProma([], join(root, "fallback"))).paths.includes(join(root, "fallback", "agent-sessions.json")));

    await writeIndex([]);
    const found = await probeProma([other, promaRoot], join(root, "fallback"));
    assert.equal(found.found, true);
    // 没有索引的根不列
    assert.ok(found.paths.includes(join(promaRoot, "sdk-config", "sessions")));
    assert.ok(!found.paths.includes(join(other, "agent-sessions.json")));
  });
});

describe("Proma 的置顶与星标是两个字段", () => {
  test("pinned → 置顶；starred → 星标、不置顶；落盘时没星标就不写 starred 键", async () => {
    const a = await writePiSession("2026-09-01T00-00-00-000Z_pin-000000000000001.jsonl", "/tmp/p");
    const b = await writePiSession("2026-09-01T00-01-00-000Z_sta-000000000000002.jsonl", "/tmp/p");
    await writeIndex([
      { id: "pinned", title: "置顶的", piSessionFile: a, pinned: true, createdAt: 1, updatedAt: 2 },
      { id: "starred", title: "星标的", piSessionFile: b, starred: true, createdAt: 3, updatedAt: 4 },
    ]);
    const report = await scanImport(deps());
    const by = new Map(report.plan.map((item) => [item.sourceId, item]));
    assert.deepEqual([by.get("pinned")?.pinned, by.get("pinned")?.starred], [true, false]);
    assert.deepEqual([by.get("starred")?.pinned, by.get("starred")?.starred], [false, true]);
    await runImport(deps());
    const metas = await store.list();
    const pinnedMeta = metas.find((meta) => meta.title === "置顶的");
    const starredMeta = metas.find((meta) => meta.title === "星标的");
    assert.equal(pinnedMeta?.pinned, true);
    assert.equal(pinnedMeta?.starred, false);
    assert.equal(starredMeta?.pinned, false);
    assert.equal(starredMeta?.starred, true);
  });
});

describe("会话时间按问答时间算", () => {
  test("索引的 updatedAt 被非消息操作推高 → 用最后一条问答的时刻；没有消息才退回索引", async () => {
    // writePiSession 的两条消息时间是 1780000001000 / 1780000002000
    const withMessages = await writePiSession("2026-09-01T00-00-00-000Z_qat-000000000000001.jsonl", "/tmp/q");
    const empty = join(promaRoot, "sdk-config", "sessions", "2026-09-01T00-00-00-000Z_emp-000000000000002.jsonl");
    await writeFile(empty, `${JSON.stringify({ type: "session", version: 3, id: "emp", timestamp: "2026-09-01T00:00:00.000Z", cwd: "/tmp/q" })}\n`);
    await writeIndex([
      { id: "archived-later", title: "归档推高", piSessionFile: withMessages, createdAt: 1779999999000, updatedAt: 1790000000000 },
      { id: "no-messages", title: "空会话", piSessionFile: empty, createdAt: 1779000000000, updatedAt: 1779500000000 },
    ]);
    const report = await scanImport(deps());
    const by = new Map(report.plan.map((item) => [item.sourceId, item]));
    assert.equal(by.get("archived-later")?.updatedAt, 1780000002000);
    assert.equal(by.get("no-messages")?.updatedAt, 1779500000000);
  });

  test("分叉会话带着源会话的旧消息：不早于它被创建的时刻", async () => {
    const forked = await writePiSession("2026-09-01T00-00-00-000Z_frk-000000000000003.jsonl", "/tmp/q");
    await writeIndex([{ id: "fork", title: "分叉", piSessionFile: forked, createdAt: 1785000000000, updatedAt: 1785000000500 }]);
    const report = await scanImport(deps());
    assert.equal(report.plan[0]?.updatedAt, 1785000000000);
  });
});

describe("用户消息还原成原文（Proma 的 prompt builder 拼进去的东西不进 transcript）", () => {
  /** 第二条用户消息：Proma 拼好的整段（时间 + 工作区 + 工作目录 + 原文） */
  const enveloped = {
    type: "message",
    id: "e3",
    parentId: "e2",
    timestamp: "2026-09-01T00:00:03.000Z",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: "**当前时间: Tuesday, September 1, 2026 at 08:00 AM GMT+8**\n\n<workspace_state>\n项目: 默认工作区\n</workspace_state>\n\n<working_directory>/Users/me/.proma-dev/w</working_directory>\n\n@file:/Users/me/plan.html 这个计划太描述性了",
        },
      ],
      timestamp: 1780000003000,
    },
  };

  async function seed(renderLog: unknown[] | null): Promise<void> {
    const pi = await writePiSession("2026-09-01T00-00-00-000Z_env-000000000000001.jsonl", "/tmp/e", [enveloped]);
    await writeIndex([{ id: "s-env", title: "带信封", piSessionFile: pi, createdAt: 1, updatedAt: 2 }]);
    if (renderLog !== null) {
      await mkdir(join(promaRoot, "agent-sessions"), { recursive: true });
      await writeFile(
        join(promaRoot, "agent-sessions", "s-env.jsonl"),
        renderLog.map((row) => JSON.stringify(row)).join("\n") + "\n",
      );
    }
  }

  const userRow = (text: string): Record<string, unknown> => ({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  });

  async function userTexts(): Promise<string[]> {
    const [meta] = await store.list();
    assert.ok(meta !== undefined);
    const detail = await store.load(meta.id);
    assert.ok(detail !== null);
    return detail.transcript.flatMap((record) =>
      record.role === "user" ? record.content.flatMap((block) => (block.type === "text" ? [block.text] : [])) : [],
    );
  }

  test("有界面日志且条数对得上：用界面日志里的原文，@file 解码；最近提问也是原文；pi 副本原样", async () => {
    await seed([
      userRow("第一条用户消息"),
      { type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "回答" }] }, parent_tool_use_id: null },
      userRow("@file:%2FUsers%2Fme%2Fplan.html 这个计划太描述性了"),
    ]);
    await runImport(deps());
    assert.deepEqual(await userTexts(), ["第一条用户消息", "@/Users/me/plan.html 这个计划太描述性了"]);
    const [meta] = await store.list();
    assert.equal(meta?.recentQueries[0], "@/Users/me/plan.html 这个计划太描述性了");
    const copy = await readFile(meta?.piSessionFile ?? "", "utf8");
    assert.match(copy, /当前时间/);
  });

  test("没有界面日志：按 Proma 的拼接格式剥", async () => {
    await seed(null);
    await runImport(deps());
    assert.deepEqual(await userTexts(), ["第一条用户消息", "@/Users/me/plan.html 这个计划太描述性了"]);
  });

  test("界面日志条数对不上：不硬配，同样按格式剥", async () => {
    await seed([userRow("只有一条")]);
    await runImport(deps());
    assert.deepEqual(await userTexts(), ["第一条用户消息", "@/Users/me/plan.html 这个计划太描述性了"]);
  });
});

describe("再次导入：对照 orbita 的副本与导入清单", () => {
  /** Proma 里又聊了一轮：user + assistant 两条消息接在 e2 后面 */
  const moreTurn = (suffix: string): unknown[] => [
    {
      type: "message",
      id: `p-${suffix}-u`,
      parentId: "e2",
      timestamp: "2026-09-02T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: `Proma 里的追问 ${suffix}` }], timestamp: 1780100001000 },
    },
    {
      type: "message",
      id: `p-${suffix}-a`,
      parentId: `p-${suffix}-u`,
      timestamp: "2026-09-02T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Proma 里的回答" }],
        provider: "proma-x",
        model: "glm-5.3",
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: 1780100002000,
      },
    },
  ];

  /** 在 orbita 接着聊：往 orbita 的副本里追加一条 Proma 没有的 entry */
  async function continueInOrbita(meta: SessionMeta): Promise<void> {
    const line = {
      type: "message",
      id: "orbita-only",
      parentId: "e2",
      timestamp: "2026-09-03T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "在 orbita 问的" }], timestamp: 1780200000000 },
    };
    await writeFile(meta.piSessionFile ?? "", `${await readFile(meta.piSessionFile ?? "", "utf8")}${JSON.stringify(line)}\n`);
  }

  async function appendToSource(path: string, lines: unknown[]): Promise<void> {
    await writeFile(path, `${await readFile(path, "utf8")}${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  }

  async function importAll(): Promise<void> {
    await runImport(deps({ existingMetas: await store.list() }));
  }

  test("Proma 有新消息、orbita 没接着聊 → updated：追加进同一条会话，orbita 这边的标题与星标不被盖掉", async () => {
    const pi = await writePiSession("2026-09-01T00-00-00-000Z_upd-000000000000001.jsonl", "/tmp/r");
    await writeIndex([{ id: "a", title: "原标题", piSessionFile: pi, createdAt: 1, updatedAt: 2 }]);
    await importAll();
    const [before] = await store.list();
    assert.ok(before !== undefined);
    await store.rename(before.id, "在 orbita 改的名");
    await store.setStarred(before.id, true);

    await appendToSource(pi, moreTurn("1"));
    // Proma 侧改标题、归档：不跟
    await writeIndex([{ id: "a", title: "Proma 后来改的名", piSessionFile: pi, createdAt: 1, updatedAt: 9, archived: true }]);

    const report = await scanImport(deps({ existingMetas: await store.list() }));
    assert.equal(report.plan.length, 1);
    const item = report.plan[0];
    assert.ok(item !== undefined);
    assert.deepEqual([item.change, item.newMessages, item.sessionId], ["updated", 2, before.id]);
    assert.equal(report.newWorkspaces.length, 0);

    const run = await runImport(deps({ existingMetas: await store.list() }));
    assert.deepEqual([run.imported, run.updated, run.failed.length], [0, 1, 0]);
    const metas = await store.list();
    assert.equal(metas.length, 1);
    const after = metas[0];
    assert.ok(after !== undefined);
    assert.equal(after.id, before.id);
    assert.equal(after.title, "在 orbita 改的名");
    assert.equal(after.starred, true);
    assert.equal(after.archived, false);
    assert.equal(after.updatedAt, 1780100002000);
    assert.equal(after.recentQueries[0], "Proma 里的追问 1");
    const detail = await store.load(after.id);
    assert.equal(detail?.transcript.length, 4);
    // 副本与源再次一致；重扫不再列出
    assert.equal(await readFile(after.piSessionFile ?? "", "utf8"), await readFile(pi, "utf8"));
    const again = await scanImport(deps({ existingMetas: await store.list() }));
    assert.equal(again.plan.length, 0);
    assert.equal(again.skipped.filter((skip) => skip.reason === "already-imported").length, 1);
  });

  test("两边都接着聊了 → diverged：另导一份放在原会话旁边，原会话与它的副本不动", async () => {
    const pi = await writePiSession("2026-09-01T00-00-00-000Z_div-000000000000002.jsonl", "/tmp/r");
    await writeIndex([{ id: "b", title: "两边都聊", piSessionFile: pi, createdAt: 1, updatedAt: 2 }]);
    await importAll();
    const [original] = await store.list();
    assert.ok(original !== undefined);
    await continueInOrbita(original);
    const originalCopy = await readFile(original.piSessionFile ?? "", "utf8");
    await appendToSource(pi, moreTurn("2"));

    const report = await scanImport(deps({ existingMetas: await store.list() }));
    const item = report.plan[0];
    assert.ok(item !== undefined);
    assert.deepEqual([item.change, item.newMessages], ["diverged", 2]);
    assert.notEqual(item.sessionId, original.id);
    assert.deepEqual([item.workspaceId, item.cwd, item.folder], [original.workspaceId, original.cwd, null]);

    const run = await runImport(deps({ existingMetas: await store.list() }));
    assert.deepEqual([run.imported, run.updated], [1, 0]);
    assert.equal(await readFile(original.piSessionFile ?? "", "utf8"), originalCopy);
    const copy = (await store.list()).find((meta) => meta.id !== original.id);
    assert.ok(copy !== undefined && copy.piSessionFile !== null);
    assert.notEqual(copy.piSessionFile, original.piSessionFile);
    assert.equal(copy.importedFrom, pi);
    // 另起的 pi 文件换了 session id（= 新会话的 orbita id），entries 原样
    const header = JSON.parse((await readFile(copy.piSessionFile, "utf8")).split("\n")[0] ?? "{}") as { id?: string };
    assert.equal(header.id, copy.id);
    assert.equal((await store.load(copy.id))?.transcript.length, 4);
    // 另导的那份跟上了源：再扫不列
    assert.equal((await scanImport(deps({ existingMetas: await store.list() }))).plan.length, 0);
  });

  test("orbita 接着聊了、Proma 没动；或 Proma 只多了换模型这类非消息 entry → 都不列", async () => {
    const a = await writePiSession("2026-09-01T00-00-00-000Z_orb-000000000000003.jsonl", "/tmp/r");
    const b = await writePiSession("2026-09-01T00-00-00-000Z_mdl-000000000000004.jsonl", "/tmp/r");
    await writeIndex([
      { id: "c", title: "只在 orbita 聊", piSessionFile: a, createdAt: 1, updatedAt: 2 },
      { id: "d", title: "只换了模型", piSessionFile: b, createdAt: 1, updatedAt: 2 },
    ]);
    await importAll();
    const metas = await store.list();
    const inOrbita = metas.find((meta) => meta.title === "只在 orbita 聊");
    assert.ok(inOrbita !== undefined);
    await continueInOrbita(inOrbita);
    await appendToSource(b, [
      { type: "model_change", id: "mc", parentId: "e2", timestamp: "2026-09-02T00:00:00.000Z", provider: "x", modelId: "kimi-k3" },
    ]);
    const report = await scanImport(deps({ existingMetas: await store.list() }));
    assert.equal(report.plan.length, 0);
    assert.equal(report.skipped.filter((skip) => skip.reason === "already-imported").length, 2);
  });

  test("导过、在 orbita 删了 → deleted；清单第一次写时补记此前导入的会话", async () => {
    const a = await writePiSession("2026-09-01T00-00-00-000Z_del-000000000000005.jsonl", "/tmp/r");
    await writeIndex([{ id: "e", title: "清单之前导的", piSessionFile: a, createdAt: 1, updatedAt: 2 }]);
    // 清单出现之前的导入：写到别处，imports.jsonl 里没有它
    await runImport(deps({ ledgerFile: join(root, "elsewhere.jsonl") }));
    const b = await writePiSession("2026-09-01T00-00-00-000Z_new-000000000000006.jsonl", "/tmp/r");
    await writeIndex([
      { id: "e", title: "清单之前导的", piSessionFile: a, createdAt: 1, updatedAt: 2 },
      { id: "f", title: "这次导的", piSessionFile: b, createdAt: 3, updatedAt: 4 },
    ]);
    await importAll();
    const ledger = (await readFile(join(root, "imports.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { action: string; at: number | null; sourceFile: string });
    assert.deepEqual(
      ledger.map((line) => [line.action, line.at === null, line.sourceFile]),
      [
        ["backfill", true, a],
        ["import", false, b],
      ],
    );

    for (const meta of await store.list()) await store.remove(meta.id);
    const report = await scanImport(deps({ existingMetas: await store.list() }));
    assert.deepEqual(
      report.plan.map((item) => [item.sourceId, item.change]).sort(),
      [
        ["e", "deleted"],
        ["f", "deleted"],
      ],
    );
    assert.equal(typeof report.lastImportAt, "number");
  });

  test("母会话有新消息、Proma 里又派了子会话 → 子会话挂到既有的母会话上", async () => {
    const parentPi = await writePiSession("2026-09-01T00-00-00-000Z_pp-000000000000007.jsonl", "/tmp/r");
    await writeIndex([{ id: "p", title: "母", piSessionFile: parentPi, createdAt: 1, updatedAt: 2 }]);
    await importAll();
    const [parent] = await store.list();
    assert.ok(parent !== undefined);
    await appendToSource(parentPi, moreTurn("3"));
    const childPi = await writePiSession("2026-09-01T00-01-00-000Z_cc-000000000000008.jsonl", "/tmp/r");
    await writeIndex([
      { id: "p", title: "母", piSessionFile: parentPi, createdAt: 1, updatedAt: 2 },
      { id: "c", title: "子", piSessionFile: childPi, createdAt: 3, updatedAt: 4, parentSessionId: "p" },
    ]);
    const report = await scanImport(deps({ existingMetas: await store.list() }));
    const sub = report.plan.find((item) => item.sourceId === "c");
    assert.deepEqual([sub?.change, sub?.parentId], ["new", parent.id]);
    await runImport(deps({ existingMetas: await store.list() }));
    const metas = await store.list();
    assert.equal(metas.length, 2);
    assert.equal(metas.find((meta) => meta.title === "子")?.parentId, parent.id);
  });
});

describe("Proma 的几个数据根（.proma 与 .proma-* 变体）", () => {
  /** 排在 promaRoot（proma-dev）前面的另一个数据根 */
  const oldRoot = (): string => join(root, ".proma");

  async function writeIndexAt(dir: string, entries: unknown[]): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "agent-sessions.json"), JSON.stringify({ version: 2, sessions: entries }));
  }

  /** 把一份 pi 真源复制到另一个根的 sdk-config/sessions 下（迁移时 Proma 就是这么整份复制的） */
  async function copyInto(dir: string, file: string, name = file.split("/").pop() ?? "x.jsonl"): Promise<string> {
    const target = join(dir, "sdk-config", "sessions", name);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file, target);
    return target;
  }

  async function append(path: string, lines: unknown[]): Promise<void> {
    await writeFile(path, `${await readFile(path, "utf8")}${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  }

  /** 接着聊的一轮：user + assistant 接在 e2 后面 */
  const turn = (suffix: string): unknown[] => [
    {
      type: "message",
      id: `t-${suffix}-u`,
      parentId: "e2",
      timestamp: "2026-09-02T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: `追问 ${suffix}` }], timestamp: 1780100001000 },
    },
    {
      type: "message",
      id: `t-${suffix}-a`,
      parentId: `t-${suffix}-u`,
      timestamp: "2026-09-02T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "回答" }],
        provider: "proma-x",
        model: "glm-5.3",
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: 1780100002000,
      },
    },
  ];

  test("同一条会话在两个根里字节相同 → 只进一条，另一份 duplicate、detail 指向留下的；各自独有的都进", async () => {
    const same = await writePiSession("2026-09-01T00-00-00-000Z_same-00000000000001.jsonl", "/tmp/p");
    const devOnly = await writePiSession("2026-09-01T00-01-00-000Z_dev-000000000000002.jsonl", "/tmp/p");
    await writeIndex([
      { id: "same", title: "两边都有", piSessionFile: same, createdAt: 1, updatedAt: 2 },
      { id: "dev-only", title: "只在 dev", piSessionFile: devOnly, createdAt: 3, updatedAt: 4 },
    ]);
    const sameOld = await copyInto(oldRoot(), same);
    const oldOnly = await copyInto(oldRoot(), devOnly, "2026-09-01T00-02-00-000Z_old-000000000000003.jsonl");
    await writeIndexAt(oldRoot(), [
      { id: "same", title: "两边都有", piSessionFile: sameOld, createdAt: 1, updatedAt: 2 },
      { id: "old-only", title: "只在旧根", piSessionFile: oldOnly, createdAt: 5, updatedAt: 6 },
    ]);

    const report = await scanImport(deps({ promaRoots: [oldRoot(), promaRoot] }));
    assert.deepEqual(report.plan.map((item) => item.sourceId).sort(), ["dev-only", "old-only", "same"]);
    // 一样长时留排在前面的根的那份
    assert.equal(report.plan.find((item) => item.sourceId === "same")?.sourceFile, sameOld);
    // 每条带着它所在的全部根，留下的那份的根在最前（页面按它筛）
    assert.deepEqual(
      report.plan.map((item) => [item.sourceId, item.dataRoots]).sort(),
      [
        ["dev-only", [promaRoot]],
        ["old-only", [oldRoot()]],
        ["same", [oldRoot(), promaRoot]],
      ],
    );
    assert.deepEqual(
      report.skipped.map((skip) => [skip.sourceId, skip.reason, skip.detail]),
      [["same", "duplicate", sameOld]],
    );
  });

  test("一份是另一份的前缀（复制过去之后接着聊了）→ 留长的那份，不管它在哪个根", async () => {
    const dev = await writePiSession("2026-09-01T00-00-00-000Z_pre-000000000000001.jsonl", "/tmp/p");
    const old = await copyInto(oldRoot(), dev);
    await append(dev, turn("dev"));
    await writeIndex([{ id: "s", title: "接着聊过", piSessionFile: dev, createdAt: 1, updatedAt: 2 }]);
    await writeIndexAt(oldRoot(), [{ id: "s", title: "接着聊过", piSessionFile: old, createdAt: 1, updatedAt: 2 }]);

    const report = await scanImport(deps({ promaRoots: [oldRoot(), promaRoot] }));
    assert.deepEqual(report.plan.map((item) => item.sourceFile), [dev]);
    assert.deepEqual(report.skipped.map((skip) => [skip.reason, skip.detail]), [["duplicate", dev]]);
  });

  test("同一个 id 下两份内容分了叉 → 两份都导，哪份都不丢", async () => {
    const dev = await writePiSession("2026-09-01T00-00-00-000Z_div-000000000000001.jsonl", "/tmp/p");
    const old = await copyInto(oldRoot(), dev);
    await append(dev, turn("dev"));
    await append(old, turn("old"));
    await writeIndex([{ id: "s", title: "分叉", piSessionFile: dev, createdAt: 1, updatedAt: 2 }]);
    await writeIndexAt(oldRoot(), [{ id: "s", title: "分叉", piSessionFile: old, createdAt: 1, updatedAt: 2 }]);

    const report = await scanImport(deps({ promaRoots: [oldRoot(), promaRoot] }));
    assert.deepEqual(report.plan.map((item) => item.sourceFile).sort(), [dev, old].sort());
    assert.equal(report.skipped.length, 0);
  });

  test("上次只从一个根导过，这次另一个根也在：认得出、不重复导；另一个根接着聊了 → 追加进同一条", async () => {
    const dev = await writePiSession("2026-09-01T00-00-00-000Z_imp-000000000000001.jsonl", "/tmp/p");
    await writeIndex([{ id: "s", title: "导过", piSessionFile: dev, createdAt: 1, updatedAt: 2 }]);
    await runImport(deps());
    const [before] = await store.list();
    assert.ok(before !== undefined);

    // 旧根里是字节相同的一份，且排在前面——留下的仍是导过的那份
    const old = await copyInto(oldRoot(), dev);
    await writeIndexAt(oldRoot(), [{ id: "s", title: "导过", piSessionFile: old, createdAt: 1, updatedAt: 2 }]);
    const both = deps({ promaRoots: [oldRoot(), promaRoot], existingMetas: await store.list() });
    const again = await scanImport(both);
    assert.equal(again.plan.length, 0);
    assert.deepEqual(again.skipped.map((skip) => skip.reason).sort(), ["already-imported", "duplicate"]);

    // 旧根那份接着聊了：它更长，留它；orbita 里导过的是它的前缀 → updated，不是新会话
    await append(old, turn("old"));
    const later = await scanImport(deps({ promaRoots: [oldRoot(), promaRoot], existingMetas: await store.list() }));
    assert.deepEqual(
      later.plan.map((item) => [item.change, item.sourceFile, item.sessionId, item.newMessages]),
      [["updated", old, before.id, 2]],
    );
    const run = await runImport(deps({ promaRoots: [oldRoot(), promaRoot], existingMetas: await store.list() }));
    assert.deepEqual([run.imported, run.updated, run.failed.length], [0, 1, 0]);
    assert.equal((await store.list()).length, 1);
  });

  test("导过又在 orbita 删了：换一个根里的同一份也认得出是 deleted", async () => {
    const dev = await writePiSession("2026-09-01T00-00-00-000Z_del-000000000000001.jsonl", "/tmp/p");
    await writeIndex([{ id: "s", title: "删过", piSessionFile: dev, createdAt: 1, updatedAt: 2 }]);
    await runImport(deps());
    const [imported] = await store.list();
    assert.ok(imported !== undefined);
    await store.remove(imported.id);

    const old = await copyInto(oldRoot(), dev);
    await append(old, turn("old"));
    await writeIndexAt(oldRoot(), [{ id: "s", title: "删过", piSessionFile: old, createdAt: 1, updatedAt: 2 }]);
    const report = await scanImport(deps({ promaRoots: [oldRoot(), promaRoot], existingMetas: await store.list() }));
    assert.deepEqual(report.plan.map((item) => [item.change, item.sourceFile]), [["deleted", old]]);
  });

  test("claude legacy 的界面日志两个根里一模一样 → 只导一条；没有会话源的条目按 id 去重计数", async () => {
    const rows = [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "问" }] }, parent_tool_use_id: null, _createdAt: 1780000000000 },
      {
        type: "assistant",
        message: { id: "m1", role: "assistant", type: "message", model: "glm-5.1", content: [{ type: "text", text: "答" }], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } },
        parent_tool_use_id: null,
        _createdAt: 1780000001000,
      },
    ];
    const entries = [
      { id: "legacy", title: "claude 时代", createdAt: 1, updatedAt: 2, legacyTranscript: { sourceRuntime: "claude" } },
      { id: "draft", title: "草稿", createdAt: 3, updatedAt: 4 },
    ];
    for (const dir of [oldRoot(), promaRoot]) {
      await mkdir(join(dir, "agent-sessions"), { recursive: true });
      await writeFile(join(dir, "agent-sessions", "legacy.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      await writeIndexAt(dir, entries);
    }

    const report = await scanImport(deps({ promaRoots: [oldRoot(), promaRoot] }));
    assert.deepEqual(report.plan.map((item) => [item.sourceKind, item.sourceFile]), [
      ["claude-legacy", join(oldRoot(), "agent-sessions", "legacy.jsonl")],
    ]);
    assert.deepEqual(report.skipped.map((skip) => [skip.sourceId, skip.reason]), [["legacy", "duplicate"]]);
    assert.equal(report.withoutPiSession, 1);
  });

  test("某个根的索引坏了 → 记一条 bad-index-entry、别的根照读；一个索引都没有才报错", async () => {
    const pi = await writePiSession("2026-09-01T00-00-00-000Z_ok-0000000000000001.jsonl", "/tmp/p");
    await writeIndex([{ id: "ok", title: "好的", piSessionFile: pi, createdAt: 1, updatedAt: 2 }]);
    await mkdir(oldRoot(), { recursive: true });
    await writeFile(join(oldRoot(), "agent-sessions.json"), "{ 半截");

    const report = await scanImport(deps({ promaRoots: [oldRoot(), promaRoot] }));
    assert.deepEqual(report.plan.map((item) => item.sourceId), ["ok"]);
    assert.deepEqual(report.skipped.map((skip) => [skip.sourceId, skip.reason]), [
      [join(oldRoot(), "agent-sessions.json"), "bad-index-entry"],
    ]);
    await assert.rejects(scanImport(deps({ promaRoots: [join(root, ".proma-empty")] })), /找不到 Proma 会话索引/);
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

describe("Claude Code 来源", () => {
  let projectsDir = "";
  let desktopDir = "";
  let home = "";

  beforeEach(async () => {
    projectsDir = join(root, "claude", "projects");
    desktopDir = join(root, "claude-desktop", "claude-code-sessions");
    home = join(root, "home");
    await mkdir(projectsDir, { recursive: true });
    await mkdir(home, { recursive: true });
  });

  const ccDeps = (overrides: Partial<RunImporterDeps> = {}): RunImporterDeps =>
    deps({ claudeCode: [{ root: dirname(projectsDir), projectsDir, desktopSessionsDir: desktopDir, home, skillsDir: join(root, "claude", "skills"), claudeJson: join(root, "claude.json") }], ...overrides });

  /** 一份 Claude Code 会话文件：rootUuid 决定分叉关系；prompts 是用户每轮说的话 */
  async function writeClaudeCodeSession(
    id: string,
    cwd: string,
    prompts: string[],
    options: { rootUuid?: string; extra?: unknown[] } = {},
  ): Promise<string> {
    const dir = join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(dir, { recursive: true });
    const lines: unknown[] = [{ type: "mode", mode: "default", sessionId: id }];
    let parent: string | null = null;
    let minute = 0;
    prompts.forEach((prompt, index) => {
      const userUuid: string = index === 0 ? (options.rootUuid ?? `${id}-u0`) : `${id}-u${index}`;
      const time = (): string => new Date(Date.UTC(2026, 8, 20, 10, minute++)).toISOString();
      lines.push({ type: "user", uuid: userUuid, parentUuid: parent, isSidechain: false, cwd, sessionId: id, timestamp: time(), message: { role: "user", content: prompt } });
      const assistantUuid = `${id}-a${index}`;
      lines.push({
        type: "assistant",
        uuid: assistantUuid,
        parentUuid: userUuid,
        isSidechain: false,
        cwd,
        sessionId: id,
        timestamp: time(),
        message: { id: `${id}-m${index}`, role: "assistant", model: "kimi-k3", content: [{ type: "text", text: `答 ${index}` }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 4 } },
      });
      parent = assistantUuid;
    });
    lines.push(...(options.extra ?? []));
    const path = join(dir, `${id}.jsonl`);
    await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    return path;
  }

  async function writeDesktopSession(name: string, body: Record<string, unknown>): Promise<void> {
    const dir = join(desktopDir, "account", "org");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `local_${name}.json`), JSON.stringify(body));
  }

  test("只勾 Claude Code 不读 Proma；同文件夹两条建工作区、一条进 Tasks、家目录与不在盘上的不算文件夹", async () => {
    const repo = join(root, "repo");
    const notes = join(root, "notes");
    await mkdir(repo, { recursive: true });
    await mkdir(notes, { recursive: true });
    await writeClaudeCodeSession("c-repo-1", repo, ["修 bug"]);
    await writeClaudeCodeSession("c-repo-2", repo, ["加测试"]);
    await writeClaudeCodeSession("c-notes", notes, ["整理笔记"]);
    await writeClaudeCodeSession("c-home", home, ["升级一下 claude"]);
    await writeClaudeCodeSession("c-gone", join(root, "deleted-worktree"), ["试一下"]);
    // Proma 数据根里什么都没有：勾了 Proma 会因为读不到索引而抛错
    const report = await scanImport(ccDeps(), [], ["claude-code"]);

    const byId = new Map(report.plan.map((item) => [item.sourceId, item]));
    assert.equal(report.plan.length, 5);
    assert.equal(report.newWorkspaces.length, 1);
    assert.equal(report.newWorkspaces[0]?.path, repo);
    assert.equal(report.newWorkspaces[0]?.name, "repo");
    assert.equal(byId.get("c-repo-1")?.workspaceId, report.newWorkspaces[0]?.id);
    assert.equal(byId.get("c-repo-2")?.workspaceId, report.newWorkspaces[0]?.id);
    assert.deepEqual(
      { workspaceId: byId.get("c-notes")?.workspaceId, folder: byId.get("c-notes")?.folder, cwd: byId.get("c-notes")?.cwd },
      { workspaceId: null, folder: notes, cwd: notes },
    );
    assert.deepEqual({ folder: byId.get("c-home")?.folder, cwd: byId.get("c-home")?.cwd }, { folder: null, cwd: home });
    assert.deepEqual({ folder: byId.get("c-gone")?.folder, cwd: byId.get("c-gone")?.cwd }, { folder: null, cwd: DEFAULT_CWD });
    const first = byId.get("c-repo-1");
    assert.equal(first?.source, "claude-code");
    assert.equal(first?.sourceKind, "claude-code");
    assert.equal(first?.title, "修 bug");
    assert.equal(first?.importedModel, "kimi-k3");
    assert.deepEqual([first?.archived, first?.pinned, first?.starred], [false, false, false]);
  });

  test("文件夹已是 orbita 工作区 → 挂上去，不管有几条", async () => {
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    await writeClaudeCodeSession("c-1", repo, ["一"]);
    const workspace = orbitaWorkspace(repo);
    const report = await scanImport(ccDeps({ workspaces: [workspace] }), [], ["claude-code"]);
    assert.equal(report.plan[0]?.workspaceId, workspace.id);
    assert.deepEqual(report.mergedWorkspaceIds, [workspace.id]);
  });

  test("桌面应用的续接与分叉：旧文件与桌面里已不在的分叉不列；标题取桌面清单的", async () => {
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    await writeClaudeCodeSession("old-1", repo, ["第一问"], { rootUuid: "root-a" });
    await writeClaudeCodeSession("old-2", repo, ["第一问", "第二问"], { rootUuid: "root-a" });
    await writeClaudeCodeSession("current", repo, ["第一问", "第二问", "第三问"], { rootUuid: "root-a" });
    await writeClaudeCodeSession("dropped-fork", repo, ["第一问", "另一个第二问"], { rootUuid: "root-a" });
    await writeClaudeCodeSession("cli-only", repo, ["命令行里的会话"]);
    await writeDesktopSession("x", {
      cliSessionId: "current",
      priorCliSessionIds: ["old-1", "old-2"],
      title: "桌面里的标题",
      createdAt: Date.UTC(2026, 8, 19),
      cwd: repo,
    });
    const report = await scanImport(ccDeps(), [], ["claude-code"]);
    assert.deepEqual(report.plan.map((item) => item.sourceId).sort(), ["cli-only", "current"]);
    assert.equal(report.plan.find((item) => item.sourceId === "current")?.title, "桌面里的标题");
    assert.equal(report.plan.find((item) => item.sourceId === "current")?.createdAt, Date.UTC(2026, 8, 19));
    assert.equal(report.skipped.length, 0);
  });

  test("执行：transcript 只有用户写的话，pi 副本保留模型读到的通知；清单记 claude-code；重扫即已导入", async () => {
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const notification = {
      type: "user",
      uuid: "n1",
      parentUuid: "s-a1",
      isSidechain: false,
      origin: { kind: "task-notification" },
      timestamp: new Date(Date.UTC(2026, 8, 20, 11)).toISOString(),
      message: { role: "user", content: "<task-notification>\n<status>completed</status>\n</task-notification>" },
    };
    const reply = {
      type: "assistant",
      uuid: "n2",
      parentUuid: "n1",
      isSidechain: false,
      timestamp: new Date(Date.UTC(2026, 8, 20, 11, 1)).toISOString(),
      message: { id: "m-n", role: "assistant", model: "kimi-k3", content: [{ type: "text", text: "后台任务完成了" }], stop_reason: "end_turn", usage: {} },
    };
    const file = await writeClaudeCodeSession("s", repo, ['看下 @"/a b/c.md"', "<command-name>/model</command-name><command-args>kimi-k3</command-args>"], {
      extra: [notification, reply],
    });

    const report = await runImport(ccDeps(), { sources: ["claude-code"], sessions: new Set([file]), destinations: [] });
    assert.equal(report.imported, 1);
    assert.deepEqual(report.failed, []);

    const [meta] = await store.list();
    assert.equal(meta?.importedFrom, file);
    assert.equal(meta?.titleSource, "user");
    const records = (await store.load(meta?.id ?? ""))?.transcript ?? [];
    const userTexts = records
      .filter((record): record is Extract<SessionRecord, { role: "user" }> => record.role === "user")
      .map((record) => record.content.map((block) => (block.type === "text" ? block.text : "")).join(""));
    assert.deepEqual(userTexts, ["看下 @/a b/c.md", "/model kimi-k3"]);
    assert.equal(records.filter((record) => record.role === "assistant").length, 3);

    const pi = await readFile(meta?.piSessionFile ?? "", "utf8");
    assert.match(pi, /task-notification/);

    const ledger = (await readFile(join(root, "imports.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(ledger.map((line) => [line["source"], line["action"], line["sourceFile"]]), [["claude-code", "import", file]]);

    const again = await scanImport(ccDeps({ existingMetas: await store.list() }), [], ["claude-code"]);
    assert.equal(again.plan.length, 0);
    assert.deepEqual(again.skipped.map((item) => item.reason), ["already-imported"]);
  });

  test("只发了一句就断掉的会话（没有 assistant 消息）进跳过清单", async () => {
    const dir = join(projectsDir, "p");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "lonely.jsonl"),
      JSON.stringify({ type: "user", uuid: "u", parentUuid: null, cwd: "/x", timestamp: "2026-09-20T10:00:00.000Z", message: { role: "user", content: "hi" } }) + "\n",
    );
    const report = await scanImport(ccDeps(), [], ["claude-code"]);
    assert.equal(report.plan.length, 0);
    assert.deepEqual(report.skipped.map((item) => [item.sourceId, item.reason]), [["lonely", "unsupported-format"]]);
  });

  test("「只随手发了一句」检查的候选：用户只写过一条的；接着聊过的不算；扫描本身照常列出", async () => {
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    await writeClaudeCodeSession("c-hi", repo, ["hi"]);
    await writeClaudeCodeSession("c-test", repo, ["Test."]);
    await writeClaudeCodeSession("c-hi-then-work", repo, ["hi", "帮我看下构建为什么挂了"]);
    const model = { providerId: "kimi", modelId: "kimi-k3" };
    const env = ccDeps({ greetingModel: { model } });
    const report = await scanImport(env, [], ["claude-code"]);
    assert.equal(report.plan.length, 3);
    assert.deepEqual(report.greetingCheck, { candidates: 2, model, unavailable: null });
    const candidates = await scanGreetingCandidates(env, ["claude-code"]);
    assert.deepEqual([...candidates.values()].sort(), ["Test.", "hi"]);
    assert.ok([...candidates.keys()].every((file) => file.endsWith("c-hi.jsonl") || file.endsWith("c-test.jsonl")));
  });

  test("探测：会话根目录在不在；paths 列出扫描会读的两处", async () => {
    const found = await probeClaudeCode([{ root: dirname(projectsDir), projectsDir, desktopSessionsDir: desktopDir, home, skillsDir: join(root, "claude", "skills"), claudeJson: join(root, "claude.json") }]);
    assert.equal(found.found, true);
    assert.deepEqual(found.paths, [projectsDir, desktopDir, join(root, "claude", "skills"), join(root, "claude.json")]);
    const missing = await probeClaudeCode([{ root, projectsDir: join(root, "nope"), desktopSessionsDir: desktopDir, home, skillsDir: join(root, "claude", "skills"), claudeJson: join(root, "claude.json") }]);
    assert.equal(missing.found, false);
  });

  // —— 再次导入与多数据目录（转换类来源按内容指纹判，Claude Code 作代表） ——

  /** 扫一遍再把计划里的全部导进来（只勾 Claude Code） */
  async function importAllCc(overrides: Partial<RunImporterDeps> = {}) {
    const report = await scanImport(ccDeps({ existingMetas: await store.list(), ...overrides }), [], ["claude-code"]);
    const run = await runImport(ccDeps({ existingMetas: await store.list(), ...overrides }), {
      sources: ["claude-code"],
      sessions: new Set(report.plan.map((item) => item.sourceFile)),
      destinations: [],
    });
    return { report, run };
  }

  async function userTexts(sessionId: string): Promise<string[]> {
    const records = (await store.load(sessionId))?.transcript ?? [];
    return records
      .filter((record): record is Extract<SessionRecord, { role: "user" }> => record.role === "user")
      .map((record) => record.content.map((block) => (block.type === "text" ? block.text : "")).join(""));
  }

  test("导过之后 Claude Code 里又聊了 → updated：追加进同一条会话，pi 副本的 header 不变；再扫即已导入", async () => {
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    await writeClaudeCodeSession("s1", repo, ["第一问"]);
    await importAllCc();
    const [before] = await store.list();
    assert.ok(before !== undefined && before.piSessionFile !== null);
    const header = (await readFile(before.piSessionFile, "utf8")).split("\n")[0];

    await writeClaudeCodeSession("s1", repo, ["第一问", "第二问", "第三问"]);
    const { report, run } = await importAllCc();
    assert.deepEqual(
      report.plan.map((item) => [item.change, item.newMessages, item.sessionId]),
      [["updated", 4, before.id]],
    );
    assert.deepEqual([run.imported, run.updated, run.failed.length], [0, 1, 0]);
    const metas = await store.list();
    assert.equal(metas.length, 1);
    assert.deepEqual(await userTexts(before.id), ["第一问", "第二问", "第三问"]);
    assert.equal((await readFile(before.piSessionFile, "utf8")).split("\n")[0], header, "会话在 orbita 里的身份不变");

    const again = await scanImport(ccDeps({ existingMetas: await store.list() }), [], ["claude-code"]);
    assert.equal(again.plan.length, 0);
    assert.deepEqual(again.skipped.map((skip) => skip.reason), ["already-imported"]);
  });

  test("两边都接着聊了 → diverged：另导一份放在原会话旁边；只在 orbita 聊了 → 不列", async () => {
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    await writeClaudeCodeSession("s1", repo, ["第一问"]);
    await importAllCc();
    const [original] = await store.list();
    assert.ok(original !== undefined && original.piSessionFile !== null);
    // 在 orbita 接着聊：副本末尾追加一条源里没有的用户消息
    const lines = (await readFile(original.piSessionFile, "utf8")).trim().split("\n");
    const lastId = (JSON.parse(lines[lines.length - 1] ?? "{}") as { id: string }).id;
    const mine = { type: "message", id: "orbita-only", parentId: lastId, timestamp: "2026-09-21T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "在 orbita 问的" }], timestamp: 1790000000000 } };
    await writeFile(original.piSessionFile, `${lines.join("\n")}\n${JSON.stringify(mine)}\n`);

    const onlyHere = await scanImport(ccDeps({ existingMetas: await store.list() }), [], ["claude-code"]);
    assert.equal(onlyHere.plan.length, 0, "源没有新消息：orbita 接着聊的不算要导的");

    await writeClaudeCodeSession("s1", repo, ["第一问", "Claude Code 里的追问"]);
    const { report, run } = await importAllCc();
    const item = report.plan[0];
    assert.deepEqual([report.plan.length, item?.change, item?.newMessages], [1, "diverged", 2]);
    assert.deepEqual([item?.workspaceId, item?.cwd], [original.workspaceId, original.cwd]);
    assert.notEqual(item?.sessionId, original.id);
    assert.deepEqual([run.imported, run.updated], [1, 0]);
    assert.equal((await store.list()).length, 2);
  });

  test("两个 Claude 数据目录里的同一条会话：内容相同只导一份，dataRoots 两个都记；一份是另一份的前缀留长的", async () => {
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const main = await writeClaudeCodeSession("s1", repo, ["第一问"]);
    const other = join(root, "claude-wt");
    const copy = join(other, "projects", basename(dirname(main)), basename(main));
    await mkdir(dirname(copy), { recursive: true });
    await copyFile(main, copy);
    const both = ccDeps();
    const twoRoots = [...(both.claudeCode ?? []), { ...(both.claudeCode ?? [])[0]!, root: other, projectsDir: join(other, "projects") }];

    const same = await scanImport(ccDeps({ claudeCode: twoRoots }), [], ["claude-code"]);
    assert.deepEqual(same.plan.map((item) => [item.sourceFile, item.dataRoots]), [[main, [dirname(projectsDir), other]]]);
    assert.deepEqual(same.skipped.map((skip) => [skip.reason, skip.detail]), [["duplicate", main]]);

    // 另一个目录里那份接着聊了：它更长，留它
    await writeClaudeCodeSession("s1", repo, ["第一问", "第二问"]);
    await copyFile(main, copy);
    await writeClaudeCodeSession("s1", repo, ["第一问"]);
    const longer = await scanImport(ccDeps({ claudeCode: twoRoots }), [], ["claude-code"]);
    assert.deepEqual(longer.plan.map((item) => [item.sourceFile, item.dataRoots]), [[copy, [other, dirname(projectsDir)]]]);
  });

  test("从一个数据目录导过，另一个目录里那份更长 → updated 进原会话，不另导一条", async () => {
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const main = await writeClaudeCodeSession("s1", repo, ["第一问"]);
    await importAllCc();
    const [before] = await store.list();
    assert.ok(before !== undefined);

    const other = join(root, "claude-wt");
    const copy = join(other, "projects", basename(dirname(main)), basename(main));
    await mkdir(dirname(copy), { recursive: true });
    await writeClaudeCodeSession("s1", repo, ["第一问", "第二问"]);
    await copyFile(main, copy);
    await writeClaudeCodeSession("s1", repo, ["第一问"]);
    const base = ccDeps();
    const twoRoots = [...(base.claudeCode ?? []), { ...(base.claudeCode ?? [])[0]!, root: other, projectsDir: join(other, "projects") }];

    const { report, run } = await importAllCc({ claudeCode: twoRoots });
    assert.deepEqual(report.plan.map((item) => [item.change, item.sourceFile, item.sessionId]), [["updated", copy, before.id]]);
    assert.deepEqual([run.imported, run.updated], [0, 1]);
    assert.equal((await store.list()).length, 1);
  });

  test("补记导入清单：Claude Code 导入的会话记成 claude-code（此前一律记成 proma）", async () => {
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    await writeClaudeCodeSession("s1", repo, ["第一问"]);
    // 清单出现之前的导入：写到别处
    await importAllCc({ ledgerFile: join(root, "elsewhere.jsonl") });
    await writeClaudeCodeSession("s2", repo, ["另一条"]);
    await importAllCc();
    const ledger = (await readFile(join(root, "imports.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { action: string; source: string });
    assert.deepEqual(ledger.map((line) => [line.action, line.source]), [
      ["backfill", "claude-code"],
      ["import", "claude-code"],
    ]);
  });
});

describe("Kimi Code 来源", () => {
  let kimiRoot = "";
  let home = "";

  beforeEach(async () => {
    kimiRoot = join(root, "kimi");
    home = join(root, "home");
    await mkdir(join(kimiRoot, "sessions", ".index-cache"), { recursive: true });
    await mkdir(home, { recursive: true });
  });

  const kimiPaths = () => ({
    root: kimiRoot,
    sessionsDir: join(kimiRoot, "sessions"),
    workspacesFile: join(kimiRoot, "workspaces.json"),
    mcpFile: join(kimiRoot, "mcp.json"),
    home,
  });
  const kimiDeps = (overrides: Partial<RunImporterDeps> = {}): RunImporterDeps => deps({ kimiCode: [kimiPaths()], ...overrides });

  let clock = Date.UTC(2026, 8, 21, 2);
  const line = (record: Record<string, unknown>): Record<string, unknown> => ({ ...record, time: (clock += 1000) });
  const userLine = (text: string, origin: Record<string, unknown> = { kind: "user" }) =>
    line({ type: "context.append_message", message: { role: "user", content: [{ type: "text", text }], toolCalls: [], origin } });
  const loopLine = (event: Record<string, unknown>) => line({ type: "context.append_loop_event", agentId: "main", event });
  /** 一问一答（可带一次工具调用，结果里一张图） */
  const exchange = (prompt: string, reply: string, image?: string): Record<string, unknown>[] => [
    userLine(prompt),
    line({ type: "llm.request", model: "k3" }),
    loopLine({ type: "step.begin", uuid: `${prompt}-1` }),
    ...(image === undefined
      ? []
      : [
          loopLine({ type: "tool.call", toolCallId: `${prompt}-t`, name: "ReadMediaFile", args: { path: "/f.png" } }),
          loopLine({ type: "tool.result", toolCallId: `${prompt}-t`, result: { output: [{ type: "image_url", imageUrl: { url: `blobref:image/png;${image}` } }] } }),
          loopLine({ type: "step.end", uuid: `${prompt}-1`, finishReason: "tool_use", usage: {} }),
          loopLine({ type: "step.begin", uuid: `${prompt}-2` }),
        ]),
    loopLine({ type: "content.part", part: { type: "text", text: reply } }),
    loopLine({ type: "step.end", uuid: `${prompt}-2`, finishReason: "end_turn", usage: { inputOther: 3, output: 4 } }),
  ];

  async function writeKimiSession(
    workspace: string,
    id: string,
    state: Record<string, unknown> | null,
    lines: Record<string, unknown>[],
    blobs: Record<string, string> = {},
  ): Promise<string> {
    const dir = join(kimiRoot, "sessions", workspace, id);
    await mkdir(join(dir, "agents", "main", "blobs"), { recursive: true });
    if (state !== null) await writeFile(join(dir, "state.json"), JSON.stringify({ id, version: 2, ...state }));
    const wire = join(dir, "agents", "main", "wire.jsonl");
    await writeFile(wire, [{ type: "metadata", protocol_version: "1.5" }, ...lines].map((item) => JSON.stringify(item)).join("\n") + "\n");
    for (const [sha, body] of Object.entries(blobs)) await writeFile(join(dir, "agents", "main", "blobs", sha), body);
    return wire;
  }

  test("扫描：一个会话目录一条；旧版没记 cwd 取工作区 root；源里删掉的工作区不列；只开了个头的进跳过清单", async () => {
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    await writeFile(
      join(kimiRoot, "workspaces.json"),
      JSON.stringify({
        version: 1,
        workspaces: { wd_repo: { root: repo, name: "repo" }, wd_home: { root: home, name: "home" }, wd_gone: { root: "/gone" } },
        deleted_workspace_ids: ["wd_gone"],
      }),
    );
    await writeKimiSession("wd_repo", "session_a", { title: "New Session", isCustomTitle: false, cwd: repo, createdAt: 1000, updatedAt: 2000 }, exchange("修一下构建", "好了"));
    await writeKimiSession("wd_repo", "session_b", { title: "发版前检查", createdAt: "2026-06-23T11:32:27.132Z" }, exchange("检查一下", "都过了"));
    await writeKimiSession("wd_home", "session_c", { title: "闲聊", cwd: home, createdAt: 3000 }, exchange("你能看视频吗", "能读帧"));
    await writeKimiSession("wd_home", "session_empty", { title: "New Session", createdAt: 4000 }, [userLine("hi")]);
    await writeKimiSession("wd_gone", "session_gone", { title: "删掉的", cwd: "/gone", createdAt: 5000 }, exchange("x", "y"));

    const report = await scanImport(kimiDeps(), [], ["kimi-code"]);
    const byId = new Map(report.plan.map((item) => [item.sourceId, item]));
    assert.deepEqual([...byId.keys()].sort(), ["session_a", "session_b", "session_c"]);
    assert.deepEqual(report.skipped.map((item) => [item.sourceId, item.reason]), [["session_empty", "unsupported-format"]]);
    // 同一文件夹两条 → 新建工作区；标题「New Session」不算，取第一句用户写的话
    assert.equal(report.newWorkspaces.length, 1);
    assert.equal(byId.get("session_a")?.workspaceId, report.newWorkspaces[0]?.id);
    assert.equal(byId.get("session_b")?.workspaceId, report.newWorkspaces[0]?.id);
    assert.equal(byId.get("session_a")?.title, "修一下构建");
    assert.equal(byId.get("session_b")?.title, "发版前检查");
    assert.equal(byId.get("session_b")?.createdAt, Date.parse("2026-06-23T11:32:27.132Z"));
    assert.deepEqual({ folder: byId.get("session_c")?.folder, cwd: byId.get("session_c")?.cwd }, { folder: null, cwd: home });
    const first = byId.get("session_a");
    assert.deepEqual([first?.source, first?.sourceKind, first?.importedModel], ["kimi-code", "kimi-code", "k3"]);
    assert.deepEqual([first?.archived, first?.pinned, first?.starred], [false, false, false]);
  });

  test("与 Claude Code 同一文件夹各一条：跨来源计数，一起进新建的工作区", async () => {
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    await writeKimiSession("wd_repo", "session_k", { title: "Kimi 这边", cwd: repo, createdAt: 1000 }, exchange("一", "二"));
    const projectDir = join(root, "claude", "projects", "repo");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "cc.jsonl"),
      [
        { type: "user", uuid: "u", parentUuid: null, cwd: repo, timestamp: "2026-09-20T10:00:00.000Z", message: { role: "user", content: "hi" } },
        { type: "assistant", uuid: "a", parentUuid: "u", cwd: repo, timestamp: "2026-09-20T10:01:00.000Z", message: { id: "m", role: "assistant", model: "x", content: [{ type: "text", text: "yo" }], usage: {} } },
      ].map((item) => JSON.stringify(item)).join("\n") + "\n",
    );
    const claudeCode = [{ root: join(root, "claude"), projectsDir: join(root, "claude", "projects"), desktopSessionsDir: join(root, "none"), home, skillsDir: join(root, "none"), claudeJson: join(root, "none.json") }];
    const report = await scanImport(kimiDeps({ claudeCode }), [], ["claude-code", "kimi-code"]);
    assert.equal(report.plan.length, 2);
    assert.equal(report.newWorkspaces.length, 1);
    assert.deepEqual(new Set(report.plan.map((item) => item.workspaceId)), new Set([report.newWorkspaces[0]?.id]));
  });

  test("执行：图从会话的 blobs 读进 pi 副本；transcript 只有用户写的话；清单记 kimi-code；重扫即已导入；MCP 一并列出", async () => {
    const sha = "c".repeat(64);
    const wire = await writeKimiSession("wd_home", "session_x", { title: "看图", cwd: home, createdAt: 1000 }, [
      userLine("<system-reminder>date</system-reminder>", { kind: "injection", variant: "date_change" }),
      ...exchange("看看这张图", "是个图标", sha),
    ], { [sha]: "PNG" });
    await writeFile(join(kimiRoot, "mcp.json"), JSON.stringify({ mcpServers: { "kimi-cu": { command: "/bin/cu", args: ["mcp"] } } }));

    const scanned = await scanImport(kimiDeps(), [], ["kimi-code"]);
    assert.deepEqual(scanned.mcp.map((item) => [item.name, item.status, item.origins[0]?.source]), [["kimi-cu", "new", "kimi-code"]]);

    const report = await runImport(kimiDeps(), { sources: ["kimi-code"], sessions: new Set([wire]), destinations: [] });
    assert.equal(report.imported, 1);
    assert.deepEqual(report.failed, []);
    const [meta] = await store.list();
    assert.equal(meta?.importedFrom, wire);
    const records = (await store.load(meta?.id ?? ""))?.transcript ?? [];
    const userTexts = records
      .filter((record): record is Extract<SessionRecord, { role: "user" }> => record.role === "user")
      .map((record) => record.content.map((block) => (block.type === "text" ? block.text : "")).join(""));
    assert.deepEqual(userTexts, ["看看这张图"]);
    const pi = await readFile(meta?.piSessionFile ?? "", "utf8");
    assert.match(pi, /system-reminder/);
    assert.match(pi, new RegExp(Buffer.from("PNG").toString("base64")));

    const ledger = (await readFile(join(root, "imports.jsonl"), "utf8")).trim().split("\n").map((item) => JSON.parse(item) as Record<string, unknown>);
    assert.deepEqual(ledger.map((item) => [item["source"], item["action"]]), [["kimi-code", "import"]]);
    const again = await scanImport(kimiDeps({ existingMetas: await store.list() }), [], ["kimi-code"]);
    assert.equal(again.plan.length, 0);
    assert.deepEqual(again.skipped.map((item) => item.reason), ["already-imported"]);
  });

  test("「只随手发了一句」的候选：注入不算用户说的话", async () => {
    const wire = await writeKimiSession("wd_home", "session_t", { title: "New Session", cwd: home, createdAt: 1000 }, [
      userLine("<system-reminder>date</system-reminder>", { kind: "injection", variant: "date_change" }),
      ...exchange("test", "Test received."),
    ]);
    const candidates = await scanGreetingCandidates(kimiDeps(), ["kimi-code"]);
    assert.deepEqual([...candidates], [[wire, "test"]]);
  });

  test("探测：会话根目录在不在；paths 列出扫描会读的三处", async () => {
    const found = await probeKimiCode([kimiPaths()]);
    assert.equal(found.found, true);
    assert.deepEqual(found.paths, [join(kimiRoot, "sessions"), join(kimiRoot, "workspaces.json"), join(kimiRoot, "mcp.json")]);
    assert.equal((await probeKimiCode([{ ...kimiPaths(), sessionsDir: join(root, "nope") }])).found, false);
  });
});

describe("opencode 来源", () => {
  let dbFile = "";
  let home = "";

  beforeEach(async () => {
    dbFile = join(root, "opencode", "opencode.db");
    home = join(root, "home");
    await mkdir(dirname(dbFile), { recursive: true });
    await mkdir(home, { recursive: true });
    const db = new DatabaseSync(dbFile);
    db.exec(`
      create table session (id text primary key, project_id text, parent_id text, directory text, title text, time_created integer, time_updated integer, revert text);
      create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
      create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);
    `);
    db.close();
  });

  const paths = () => ({ root: dirname(dbFile), dbFile, configFile: join(root, "opencode", "opencode.json"), home });
  const ocDeps = (overrides: Partial<RunImporterDeps> = {}): RunImporterDeps => deps({ opencode: [paths()], ...overrides });

  let seq = 0;
  /** 一条根会话（或子会话）：每个 prompt 一问一答 */
  function writeSession(id: string, directory: string, title: string, prompts: string[], parent: string | null = null): void {
    const db = new DatabaseSync(dbFile);
    db.prepare("insert into session values (?, 'p', ?, ?, ?, ?, ?, null)").run(id, parent, directory, title, 1000 + seq, 2000 + seq);
    const insertMessage = db.prepare("insert into message values (?, ?, ?, ?, ?)");
    const insertPart = db.prepare("insert into part values (?, ?, ?, 0, 0, ?)");
    for (const prompt of prompts) {
      seq += 1;
      const userId = `msg_${String(seq).padStart(4, "0")}u`;
      const replyId = `msg_${String(seq).padStart(4, "0")}v`;
      insertMessage.run(userId, id, 10_000 + seq * 10, 0, JSON.stringify({ role: "user", time: { created: 10_000 + seq * 10 } }));
      insertPart.run(`prt_${seq}a`, userId, id, JSON.stringify({ type: "text", text: prompt }));
      insertPart.run(`prt_${seq}b`, userId, id, JSON.stringify({ type: "text", text: "<system-reminder>mode</system-reminder>", synthetic: true }));
      insertMessage.run(replyId, id, 10_000 + seq * 10 + 1, 0, JSON.stringify({ role: "assistant", time: { created: 10_000 + seq * 10 + 1 }, providerID: "zhipuai", modelID: "glm-5.1" }));
      insertPart.run(`prt_${seq}c`, replyId, id, JSON.stringify({ type: "step-start" }));
      insertPart.run(`prt_${seq}d`, replyId, id, JSON.stringify({ type: "text", text: `答：${prompt}` }));
      insertPart.run(`prt_${seq}e`, replyId, id, JSON.stringify({ type: "step-finish", reason: "stop", tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } } }));
    }
    db.close();
  }

  test("扫描：只列根会话；默认标题取第一句用户写的话；同文件夹两条建工作区；执行后 transcript 只有用户写的话、清单记 opencode、重扫即已导入", async () => {
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    writeSession("ses_a", repo, "New session - 2026-01-17T07:10:22.607Z", ["修测试", "再跑一次"]);
    writeSession("ses_b", repo, "发版检查", ["检查一下"]);
    writeSession("ses_child", repo, "子任务", ["子 agent 的活"], "ses_a");
    writeSession("ses_home", home, "闲聊", ["你好"]);
    const db = new DatabaseSync(dbFile);
    db.prepare("insert into session values ('ses_empty', 'p', null, ?, 'x', 9, 9, null)").run(repo);
    db.prepare("insert into message values ('msg_x', 'ses_empty', 1, 1, ?)").run(JSON.stringify({ role: "user", time: { created: 1 } }));
    db.prepare("insert into part values ('prt_x', 'msg_x', 'ses_empty', 0, 0, ?)").run(JSON.stringify({ type: "text", text: "hi" }));
    db.close();

    const report = await scanImport(ocDeps(), [], ["opencode"]);
    const byId = new Map(report.plan.map((item) => [item.sourceId, item]));
    assert.deepEqual([...byId.keys()].sort(), ["ses_a", "ses_b", "ses_home"]);
    assert.deepEqual(report.skipped.map((item) => [item.sourceId, item.reason]), [["ses_empty", "unsupported-format"]]);
    assert.equal(byId.get("ses_a")?.title, "修测试");
    assert.equal(byId.get("ses_a")?.sourceFile, `${dbFile}#ses_a`);
    assert.deepEqual([byId.get("ses_a")?.source, byId.get("ses_a")?.sourceKind, byId.get("ses_a")?.importedModel], ["opencode", "opencode", "glm-5.1"]);
    assert.equal(report.newWorkspaces.length, 1);
    assert.equal(byId.get("ses_b")?.workspaceId, report.newWorkspaces[0]?.id);
    assert.deepEqual({ folder: byId.get("ses_home")?.folder, cwd: byId.get("ses_home")?.cwd }, { folder: null, cwd: home });

    const run = await runImport(ocDeps(), { sources: ["opencode"], sessions: new Set([`${dbFile}#ses_a`]), destinations: [] });
    assert.equal(run.imported, 1);
    assert.deepEqual(run.failed, []);
    const [meta] = await store.list();
    const records = (await store.load(meta?.id ?? ""))?.transcript ?? [];
    const userTexts = records
      .filter((record): record is Extract<SessionRecord, { role: "user" }> => record.role === "user")
      .map((record) => record.content.map((block) => (block.type === "text" ? block.text : "")).join(""));
    assert.deepEqual(userTexts, ["修测试", "再跑一次"]);
    assert.match(await readFile(meta?.piSessionFile ?? "", "utf8"), /system-reminder/);
    const ledger = (await readFile(join(root, "imports.jsonl"), "utf8")).trim().split("\n").map((item) => JSON.parse(item) as Record<string, unknown>);
    assert.deepEqual(ledger.map((item) => [item["source"], item["sourceFile"]]), [["opencode", `${dbFile}#ses_a`]]);
    const again = await scanImport(ocDeps({ existingMetas: await store.list() }), [], ["opencode"]);
    assert.equal(again.skipped.find((item) => item.sourceId === "ses_a")?.reason, "already-imported");
  });

  test("MCP 从 opencode.json 的 mcp 读：local 的命令数组拆成命令与参数，remote 走 http", async () => {
    await writeFile(
      join(root, "opencode", "opencode.json"),
      JSON.stringify({
        mcp: {
          vision: { type: "local", command: ["npx", "-y", "vision-mcp"], environment: { KEY: "k" }, enabled: true },
          reader: { type: "remote", url: "https://r/mcp", headers: { Authorization: "Bearer k" }, enabled: false },
        },
      }),
    );
    const report = await scanImport(ocDeps(), [], ["opencode"]);
    assert.deepEqual(
      report.mcp.map((item) => [item.name, item.transport, item.detail, item.carriesSecrets]),
      [
        ["reader", "http", "https://r/mcp", true],
        ["vision", "stdio", "npx -y vision-mcp", true],
      ],
    );
  });

  test("「只随手发了一句」的候选：synthetic 文字不算用户说的话", async () => {
    writeSession("ses_hi", home, "New session - 2026-01-17T07:10:22.607Z", ["你好！"]);
    const candidates = await scanGreetingCandidates(ocDeps(), ["opencode"]);
    assert.deepEqual([...candidates], [[`${dbFile}#ses_hi`, "你好！"]]);
  });

  test("探测：库在不在；paths 列出库与配置", async () => {
    const found = await probeOpencode([paths()]);
    assert.equal(found.found, true);
    assert.deepEqual(found.paths, [dbFile, join(root, "opencode", "opencode.json")]);
    assert.equal((await probeOpencode([{ ...paths(), dbFile: join(root, "nope.db") }])).found, false);
  });
});


describe("reasonix 来源", () => {
  let projectsRoot = "";
  let home = "";

  beforeEach(async () => {
    projectsRoot = join(root, "reasonix", "projects");
    home = join(root, "home");
    await mkdir(join(projectsRoot, "proj-a", "sessions"), { recursive: true });
    await mkdir(home, { recursive: true });
  });

  const rxDeps = (overrides: Partial<RunImporterDeps> = {}): RunImporterDeps =>
    deps({ reasonix: [{ root: dirname(projectsRoot), projectsRoot, home }], ...overrides });

  /** 一条会话：主 JSONL + meta 侧车。行形状按 2026-09-27 抽样（tool_calls 拍平形）。 */
  async function writeSession(dir: string, name: string, meta: Record<string, unknown> | null, rows: Record<string, unknown>[]): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    if (meta !== null) await writeFile(join(dir, `${name}.meta`), JSON.stringify(meta), "utf8");
  }

  const repoRows = (prompt: string): Record<string, unknown>[] => [
    { role: "user", content: prompt, raw_content: prompt, origin: "user", createdAt: 1757134310000 },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", name: "ls", arguments: '{"path": "."}' }] },
    { role: "tool", tool_call_id: "c1", name: "ls", content: "a.txt" },
    { role: "assistant", content: "好了。" },
  ];

  test("扫描与执行：meta 带标题/模型/工作区，同址建工作区，transcript 只有用户写的话，重扫即已导入", async () => {
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const meta = (id: string, title: string, workspaceRoot: string): Record<string, unknown> => ({
      id, topic_title: title, model: "opencode-go/deepseek-v4", workspace_root: workspaceRoot,
      created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:10:00Z",
    });
    const sessions = join(projectsRoot, "proj-a", "sessions");
    await writeSession(sessions, "s-a.jsonl", meta("a", "标题A", repo), repoRows("修测试"));
    await writeSession(sessions, "s-a2.jsonl", meta("a2", "标题A2", repo), repoRows("再跑一次"));
    await writeSession(sessions, "s-b.jsonl", meta("b", "在家里的", home), repoRows("你好"));
    await writeFile(join(sessions, "s-empty.jsonl"), "", "utf8");

    const report = await scanImport(rxDeps(), [], ["reasonix"]);
    const byId = new Map(report.plan.map((item) => [item.sourceId, item]));
    assert.deepEqual([...byId.keys()].sort(), ["a", "a2", "b"]);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0]?.reason, "unsupported-format");
    assert.equal(byId.get("a")?.title, "标题A");
    assert.deepEqual([byId.get("a")?.source, byId.get("a")?.sourceKind, byId.get("a")?.importedModel], ["reasonix", "reasonix", "opencode-go/deepseek-v4"]);
    assert.equal(byId.get("a")?.createdAt, Date.parse("2026-09-01T00:00:00Z"));
    assert.deepEqual([byId.get("b")?.folder, byId.get("b")?.cwd], [null, home]);
    assert.equal(report.newWorkspaces.length, 1);
    assert.equal(byId.get("a2")?.workspaceId, report.newWorkspaces[0]?.id);

    const run = await runImport(rxDeps(), { sources: ["reasonix"], sessions: new Set([byId.get("a")?.sourceFile ?? ""]), destinations: [] });
    assert.equal(run.imported, 1);
    assert.deepEqual(run.failed, []);
    const [importedMeta] = await store.list();
    const records = (await store.load(importedMeta?.id ?? ""))?.transcript ?? [];
    const userTexts = records
      .filter((record): record is Extract<SessionRecord, { role: "user" }> => record.role === "user")
      .map((record) => record.content.map((block) => (block.type === "text" ? block.text : "")).join(""));
    assert.deepEqual(userTexts, ["修测试"]);
    const ledger = (await readFile(join(root, "imports.jsonl"), "utf8")).trim().split("\n").map((item) => JSON.parse(item) as Record<string, unknown>);
    assert.deepEqual(ledger.map((item) => item["source"]), ["reasonix"]);
    const again = await scanImport(rxDeps({ existingMetas: await store.list() }), [], ["reasonix"]);
    assert.equal(again.skipped.find((item) => item.sourceId === "a")?.reason, "already-imported");
  });

  test("v5 新版会话库在：扫描如实报一条「不支持」，不静默漏掉；不在：不报", async () => {
    const sessions = join(projectsRoot, "proj-a", "sessions");
    await writeSession(sessions, "s-a.jsonl", null, repoRows("修测试"));
    const without = await scanImport(rxDeps(), [], ["reasonix"]);
    assert.equal(without.skipped.some((item) => item.sourceId === "desktop-sessions-v5"), false);
    await mkdir(join(projectsRoot, "..", "desktop-sessions-v5"), { recursive: true });
    const withV5 = await scanImport(rxDeps(), [], ["reasonix"]);
    const v5 = withV5.skipped.find((item) => item.sourceId === "desktop-sessions-v5");
    assert.equal(v5?.reason, "unsupported-format");
    assert.match(v5?.detail ?? "", /not supported yet/);
    assert.equal(withV5.plan.length, 1);
  });

  test("meta 的 workspace_root 是空串 → 与缺席同为无归属：folder null、cwd 退 defaultCwd（不是进程 cwd）", async () => {
    const sessions = join(projectsRoot, "proj-a", "sessions");
    await writeSession(sessions, "s-a.jsonl", { id: "a", workspace_root: "" }, repoRows("修测试"));
    const report = await scanImport(rxDeps(), [], ["reasonix"]);
    const [item] = report.plan;
    assert.deepEqual([item?.folder, item?.cwd], [null, "/Users/tester"]);
  });

  test("探测：projects 根在不在；paths 列出扫描会读的一处", async () => {
    const found = await probeReasonix([{ root: dirname(projectsRoot), projectsRoot, home }]);
    assert.equal(found.found, true);
    assert.deepEqual(found.paths, [projectsRoot]);
    assert.equal((await probeReasonix([{ root, projectsRoot: join(root, "nope"), home }])).found, false);
  });
});

describe("zcode 来源", () => {
  let dbFile = "";
  let home = "";

  beforeEach(async () => {
    dbFile = join(root, "zcode", "db.sqlite");
    home = join(root, "home");
    await mkdir(dirname(dbFile), { recursive: true });
    await mkdir(home, { recursive: true });
    const db = new DatabaseSync(dbFile);
    db.exec(`
      create table session (id text primary key, parent_id text, directory text, title text, revert text, time_created integer, time_updated integer);
      create table message (id text primary key, session_id text, time_created integer, data text, sequence integer);
      create table part (id text primary key, message_id text, session_id text, time_created integer, data text, sequence integer);
    `);
    db.close();
  });

  const paths = () => ({ root: dirname(dbFile), dbFile, home });
  const zDeps = (overrides: Partial<RunImporterDeps> = {}): RunImporterDeps => deps({ zcode: [paths()], ...overrides });

  /** ZCode 库最小 schema（2026-09-28 对本机库 pragma 抄的）+ 两个真实形状的会话。 */
  async function writeDb(sessions: { id: string; directory: string | null; title: string | null; revert?: string; parent?: string; rows: { seq: number; data: Record<string, unknown>; parts?: Record<string, unknown>[] }[] }[]): Promise<void> {
    const db = new DatabaseSync(dbFile);
    for (const session of sessions) {
      db.prepare("insert into session values (?, ?, ?, ?, ?, 1000, 2000)").run(
        session.id, session.parent ?? null, session.directory, session.title, session.revert ?? null,
      );
      for (const row of session.rows) {
        const id = `${session.id}_m${row.seq}`;
        db.prepare("insert into message (id, session_id, time_created, data, sequence) values (?, ?, ?, ?, ?)").run(
          id, session.id, row.seq, JSON.stringify(row.data), row.seq,
        );
        (row.parts ?? []).forEach((part, index) => {
          db.prepare("insert into part (id, message_id, session_id, time_created, data, sequence) values (?, ?, ?, ?, ?, ?)").run(
            `${id}_p${index}`, id, session.id, row.seq, JSON.stringify(part), row.seq * 10 + index,
          );
        });
      }
    }
    db.close();
  }

  const turn = (prompt: string): { seq: number; data: Record<string, unknown>; parts?: Record<string, unknown>[] }[] => [
    { seq: 1, data: { role: "user", time: { created: 10000 } }, parts: [{ type: "text", text: prompt }] },
    {
      seq: 2,
      data: { role: "assistant", time: { created: 10001 }, providerId: "account:bigmodel-start-plan", modelId: "GLM-5.3-Flash" },
      parts: [{ type: "step-start" }, { type: "text", text: `答：${prompt}` }, { type: "step-finish", reason: "stop", tokens: { input: 1, output: 1 } }],
    },
  ];

  test("扫描与执行：子会话不列、rewind 只留可见分支、transcript 只有用户写的话、重扫即已导入", async () => {
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    await writeDb([
      { id: "ses_a", directory: repo, title: "标题A", rows: turn("修测试") },
      { id: "ses_b", directory: repo, title: "标题B", rows: turn("再跑一次") },
      { id: "ses_child", directory: repo, title: "子任务", parent: "ses_a", rows: turn("子 agent 的活") },
      {
        id: "ses_rw",
        directory: repo,
        title: "回退过的",
        // 真实形状：回退到 m3（它被回退掉），保留 m1、m2；没有接着聊（cut 游标就是 m3）
        revert: JSON.stringify({
          kind: "conversation_rewind",
          targetMessageID: "ses_rw_m3",
          keptMessageIDs: ["ses_rw_m1", "ses_rw_m2"],
          branchCutAfterMessageID: "ses_rw_m3",
        }),
        rows: [...turn("先问"), { seq: 3, data: { role: "user", time: { created: 20000 } }, parts: [{ type: "text", text: "回退掉的话" }] }],
      },
    ]);

    const report = await scanImport(zDeps(), [], ["zcode"]);
    const byId = new Map(report.plan.map((item) => [item.sourceId, item]));
    assert.deepEqual([...byId.keys()].sort(), ["ses_a", "ses_b", "ses_rw"]);
    assert.equal(byId.get("ses_a")?.title, "标题A");
    assert.deepEqual([byId.get("ses_a")?.source, byId.get("ses_a")?.sourceKind, byId.get("ses_a")?.importedModel], ["zcode", "zcode", "GLM-5.3-Flash"]);
    assert.equal(byId.get("ses_b")?.workspaceId, report.newWorkspaces[0]?.id);
    assert.equal(report.newWorkspaces.length, 1);

    // 执行 ses_a：transcript 只有用户写的话
    const run = await runImport(zDeps(), { sources: ["zcode"], sessions: new Set([byId.get("ses_a")?.sourceFile ?? ""]), destinations: [] });
    assert.equal(run.imported, 1);
    assert.deepEqual(run.failed, []);
    const [meta] = await store.list();
    const records = (await store.load(meta?.id ?? ""))?.transcript ?? [];
    const userTexts = records
      .filter((record): record is Extract<SessionRecord, { role: "user" }> => record.role === "user")
      .map((record) => record.content.map((block) => (block.type === "text" ? block.text : "")).join(""));
    assert.deepEqual(userTexts, ["修测试"]);
    const ledger = (await readFile(join(root, "imports.jsonl"), "utf8")).trim().split("\n").map((item) => JSON.parse(item) as Record<string, unknown>);
    assert.deepEqual(ledger.map((item) => item["source"]), ["zcode"]);
    const again = await scanImport(zDeps({ existingMetas: await store.list() }), [], ["zcode"]);
    assert.equal(again.skipped.find((item) => item.sourceId === "ses_a")?.reason, "already-imported");
  });

  test("探测：库在不在；paths 列出扫描会读的一处", async () => {
    const found = await probeZcode([paths()]);
    assert.equal(found.found, true);
    assert.deepEqual(found.paths, [dbFile]);
    assert.equal((await probeZcode([{ ...paths(), dbFile: join(root, "nope.sqlite") }])).found, false);
  });
});

describe("Skills 随扫描与执行走", () => {
  test("只勾共用 skills 目录：不读 Proma；扫描列出组，执行按勾选复制进中心存储，报告计数", async () => {
    const agentSkillsDir = join(root, "agents-skills");
    await mkdir(join(agentSkillsDir, "archify"), { recursive: true });
    await writeFile(join(agentSkillsDir, "archify", "SKILL.md"), "---\nname: archify\ndescription: diagrams\n---\nbody\n");
    await mkdir(join(agentSkillsDir, "tdd"), { recursive: true });
    await writeFile(join(agentSkillsDir, "tdd", "SKILL.md"), "---\nname: tdd\n---\nbody\n");
    const skillStore = new SkillStore(join(root, "orbita"));
    const env = deps({ agentSkillsDir, existingSkills: ["tdd"], skillTarget: skillStore });

    const report = await scanImport(env, [], ["agent-skills"]);
    assert.equal(report.plan.length, 0);
    assert.deepEqual(
      report.skills.map((group) => [group.source, group.skills.map((skill) => `${skill.slug}:${skill.status}`)]),
      [["agent-skills", ["archify:new", "tdd:in-orbita"]]],
    );

    const run = await runImport(env, {
      sources: ["agent-skills"],
      sessions: new Set(),
      destinations: [],
      skills: { skills: new Set([join(agentSkillsDir, "archify"), join(agentSkillsDir, "tdd")]), mode: "copy", scopes: [] },
    });
    assert.equal(run.skillsImported, 1);
    assert.deepEqual(run.skillsFailed, []);
    assert.deepEqual((await skillStore.list()).map((skill) => [skill.slug, skill.global]), [["archify", true]]);
  });
});

describe("MCP servers 随扫描与执行走", () => {
  test("只勾 Claude Code：扫描列出 ~/.claude.json 的 server；执行把勾选的停用写入，已有同名的不动", async () => {
    const claudeJson = join(root, "claude.json");
    await writeFile(
      claudeJson,
      JSON.stringify({
        mcpServers: {
          search: { type: "http", url: "https://s/mcp", headers: { Authorization: "Bearer k" } },
          mine: { type: "stdio", command: "mine" },
        },
      }),
    );
    const added: string[] = [];
    const env = deps({
      claudeCode: [
        {
          root,
          projectsDir: join(root, "none"),
          desktopSessionsDir: join(root, "none-desktop"),
          home: root,
          skillsDir: join(root, "none-skills"),
          claudeJson,
        },
      ],
      existingMcp: ["mine"],
      mcpTarget: {
        add: async (name, server) => {
          added.push(`${name}:${server.disabled === true ? "off" : "on"}`);
        },
        reload: async () => undefined,
      },
    });
    const report = await scanImport(env, [], ["claude-code"]);
    assert.deepEqual(
      report.mcp.map((item) => [item.name, item.status, item.carriesSecrets]),
      [
        ["mine", "in-orbita", false],
        ["search", "new", true],
      ],
    );
    assert.equal(JSON.stringify(report).includes("Bearer k"), false);
    const run = await runImport(env, { sources: ["claude-code"], sessions: new Set(), destinations: [], mcp: new Set(["search", "mine"]) });
    assert.equal(run.mcpImported, 1);
    assert.deepEqual(added, ["search:off"]);
  });
});

describe("Proma：「只随手发了一句」检查的候选", () => {
  test("pi 会话：只有一句 hi 的是候选；hi 之后接着聊的不是；导过的不是", async () => {
    const hi = await writePiSession("2026-09-01T00-00-00-000Z_hi0-000000000000001.jsonl", "/tmp/p");
    await writeFile(hi, (await readFile(hi, "utf8")).replace("第一条用户消息", "hi"));
    const more = await writePiSession("2026-09-01T00-01-00-000Z_hi1-000000000000002.jsonl", "/tmp/p", [
      {
        type: "message",
        id: "e3",
        parentId: "e2",
        timestamp: "2026-09-01T00:00:03.000Z",
        message: { role: "user", content: [{ type: "text", text: "帮我整理一下这周的笔记" }], timestamp: 1780000003000 },
      },
    ]);
    await writeFile(more, (await readFile(more, "utf8")).replace("第一条用户消息", "hi"));
    await writeIndex([
      { id: "only-hi", title: "hi", piSessionFile: hi, createdAt: 1, updatedAt: 2 },
      { id: "hi-then-more", title: "整理笔记", piSessionFile: more, createdAt: 3, updatedAt: 4 },
    ]);
    const report = await scanImport(deps());
    assert.deepEqual(report.plan.map((item) => item.sourceId).sort(), ["hi-then-more", "only-hi"]);
    assert.equal(report.greetingCheck.candidates, 1);
    // 没传 greetingModel（生产里主进程总会传）＝当作一个可用模型都没有
    assert.deepEqual(report.greetingCheck, { candidates: 1, model: null, unavailable: "no-provider" });
    assert.deepEqual([...(await scanGreetingCandidates(deps(), ["proma"]))], [[hi, "hi"]]);
  });

  test("检查的家务活模型不可用的两种状态：没 provider / 没选家务活模型", async () => {
    await writeIndex([]);
    const noChore = deps({ greetingModel: { unavailable: "no-chore-model" } });
    const report = await scanImport(noChore);
    assert.equal(report.greetingCheck.candidates, 0);
    assert.equal(report.greetingCheck.model, null);
    assert.equal(report.greetingCheck.unavailable, "no-chore-model");
  });
});

describe("messageSignature：转换类来源的内容指纹", () => {
  test("只看有文字的 user / assistant；纯工具调用、工具结果、空白不计；同样的对话同样的指纹", () => {
    const talk = [
      { role: "user", content: "问" },
      { role: "assistant", content: [{ type: "toolCall", id: "t", name: "read", arguments: {} }] },
      { role: "toolResult", content: [{ type: "text", text: "文件内容" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "想" }, { type: "text", text: "答" }] },
      { role: "user", content: [{ type: "text", text: "   " }] },
    ];
    const signature = messageSignature(talk);
    assert.equal(signature.length, 2);
    assert.deepEqual(messageSignature(talk), signature);
    // 思考内容变了不影响：比的是用户看得到的文字
    assert.deepEqual(
      messageSignature([talk[0], { role: "assistant", content: [{ type: "thinking", thinking: "别的" }, { type: "text", text: "答" }] }]),
      signature,
    );
    assert.notDeepEqual(messageSignature([{ role: "user", content: "问" }, { role: "assistant", content: "别的答" }]), signature);
  });

  test("compareSignatures：公共前缀之后各自多出来的", () => {
    assert.deepEqual(compareSignatures(["a", "b", "c"], ["a", "b"]), { newMessages: 1, continuedHere: false });
    assert.deepEqual(compareSignatures(["a", "b"], ["a", "b", "x"]), { newMessages: 0, continuedHere: true });
    assert.deepEqual(compareSignatures(["a", "b", "c"], ["a", "x"]), { newMessages: 2, continuedHere: true });
    // 一条公共的都没有：源的全部算新消息、副本算接着聊过 → diverged，不会被当成没变藏掉
    assert.deepEqual(compareSignatures(["a"], ["x"]), { newMessages: 1, continuedHere: true });
  });
});
