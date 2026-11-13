/**
 * 外部来源逐个只读：每个来源一份最小 fixture（格式照各解析器测试里的真实形状），走真 reader
 * 列目录、按 ref 读全文、源目录读前读后零写入。Kimi 两家的细节在 external-session.test.ts。
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExternalSourceId } from "../../shared/external-sources.ts";
import type { SessionRecord } from "../../shared/session.ts";
import { createExternalSessionReader, type ExternalSessionReader, type ExternalSourceRoots } from "./external-session.ts";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-external-adapters-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function readerFor(groups: readonly Omit<ExternalSourceRoots, "enabled">[], enabled: Partial<Record<ExternalSourceId, boolean>> = {}): ExternalSessionReader {
  return createExternalSessionReader({
    defaultCwd: join(dir, "default-cwd"),
    claudeDesktopDir: join(dir, "claude-desktop"),
    sources: async () => groups.map((group) => ({ ...group, enabled: enabled[group.source] ?? true })),
  });
}

/** 目录树里每个文件的相对路径 + 大小 + mtime：读前读后逐字相等 = 零写入（含新冒出来的文件）。 */
async function fingerprint(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const info = await stat(full);
        out.push(`${relative(root, full)}:${info.size}:${info.mtimeMs}`);
      }
    }
  };
  await walk(root);
  return out.sort();
}

function texts(records: readonly SessionRecord[]): string[] {
  return records.map((record) => {
    if (record.role === "user" || record.role === "assistant") {
      return `${record.role}:${record.content.map((block) => (block.type === "text" ? block.text : block.type)).join("|")}`;
    }
    if (record.role === "tool") return `tool:${record.toolName}`;
    return record.role;
  });
}

/** 列一个来源、取唯一一条、按 ref 读全文；顺带核对源目录零写入。 */
async function listAndLoad(reader: ExternalSessionReader, root: string) {
  const before = await fingerprint(root);
  const [section] = await reader.list();
  assert.ok(section !== undefined, "该来源有一段");
  assert.deepEqual(section.problems, []);
  const [summary] = section.summaries;
  assert.ok(summary !== undefined);
  assert.match(summary.ref, new RegExp(`^ext:${section.source}:[0-9a-f]{16}$`));
  const detail = await reader.load(summary.ref);
  assert.ok(detail !== null);
  assert.deepEqual(await fingerprint(root), before, "源目录零写入");
  return { section, summary, detail };
}

// ---------------------------------------------------------------------------

function claudeRow(type: "user" | "assistant", uuid: string, parentUuid: string | null, content: unknown, at: string): string {
  return JSON.stringify({
    type,
    uuid,
    parentUuid,
    isSidechain: false,
    cwd: "/repo/app",
    timestamp: at,
    message:
      type === "user"
        ? { role: "user", content }
        : { id: `msg-${uuid}`, role: "assistant", model: "claude-opus-5-5", content: [content], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } },
  });
}

describe("Claude Code", () => {
  test("列 projects 下的会话、标题取首条提问、cwd 取行里的；读全文工具调用成对；桌面应用续接取代的旧文件不列", async () => {
    const root = join(dir, ".claude");
    const project = join(root, "projects", "-repo-app");
    await mkdir(project, { recursive: true });
    const lines = [
      claudeRow("user", "u1", null, "把 README 改短", "2026-09-20T10:00:01.000Z"),
      claudeRow("assistant", "a1", "u1", { type: "tool_use", id: "t1", name: "Read", input: { file_path: "README.md" } }, "2026-09-20T10:00:02.000Z"),
      claudeRow("user", "r1", "a1", [{ type: "tool_result", tool_use_id: "t1", content: "# 很长" }], "2026-09-20T10:00:03.000Z"),
      claudeRow("assistant", "a2", "r1", { type: "text", text: "改好了" }, "2026-09-20T10:00:04.000Z"),
    ];
    await writeFile(join(project, "s-new.jsonl"), `${lines.join("\n")}\n`);
    // 旧文件：桌面应用的清单说它被 s-new 续接取代
    await writeFile(join(project, "s-old.jsonl"), `${lines.slice(0, 1).join("\n")}\n`);
    const org = join(dir, "claude-desktop", "acct", "org");
    await mkdir(org, { recursive: true });
    await writeFile(join(org, "local_1.json"), JSON.stringify({ cliSessionId: "s-new", priorCliSessionIds: ["s-old"], title: "README 精简" }));

    const { section, summary, detail } = await listAndLoad(readerFor([{ source: "claude-code", roots: [root] }]), root);
    assert.equal(section.total, 1);
    assert.equal(summary.title, "README 精简");
    assert.equal(summary.cwd, "/repo/app");
    assert.deepEqual(texts(detail.records), ["user:把 README 改短", "assistant:toolCall", "tool:Read", "assistant:改好了"]);
    assert.equal(detail.meta.modelId, "claude-opus-5-5");
  });
});

function codexLine(type: string, payload: unknown, timestamp = "2026-09-12T10:00:00.000Z"): string {
  return JSON.stringify({ timestamp, type, payload });
}

describe("Codex", () => {
  test("列 sessions/YYYY/MM/DD 下的 rollout；标题剥掉注入；源里续写后再读看得到新内容", async () => {
    const root = join(dir, ".codex");
    const day = join(root, "sessions", "2026", "09", "12");
    await mkdir(day, { recursive: true });
    const file = join(day, "rollout-2026-09-12T09-00-00-6f1c2b70-0000-4000-8000-000000000001.jsonl");
    await writeFile(
      file,
      [
        codexLine("session_meta", { id: "6f1c2b70", timestamp: "2026-09-12T09:00:00.000Z", cwd: "/Users/fjm/paper" }),
        codexLine("turn_context", { cwd: "/Users/fjm/paper", model: "gpt-5-codex" }),
        codexLine("response_item", {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<environment_context>\nmode: cli\n</environment_context>\n\n理一遍第二章" }],
        }),
        codexLine("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "第二章是铺垫。" }] }),
      ].join("\n"),
    );
    const reader = readerFor([{ source: "codex", roots: [root] }]);
    const { summary, detail } = await listAndLoad(reader, root);
    assert.equal(summary.title, "理一遍第二章");
    assert.equal(summary.cwd, "/Users/fjm/paper");
    assert.deepEqual(texts(detail.records), ["user:理一遍第二章", "assistant:第二章是铺垫。"]);

    // 源应用接着写：同一个 ref 再读读到新的一轮（没有陈旧缓存）
    await appendFile(
      file,
      `\n${[
        codexLine("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "再理第三章" }] }),
        codexLine("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "第三章是结论。" }] }),
      ].join("\n")}`,
    );
    const again = await reader.load(summary.ref);
    assert.deepEqual(texts(again?.records ?? []).slice(-2), ["user:再理第三章", "assistant:第三章是结论。"]);
  });
});

/** OpenCode / ZCode 共用的最小库：一条根会话（一问一答）+ 一条子会话（不列）。 */
function writeOpencodeLikeDb(file: string, zcode: boolean): void {
  const db = new DatabaseSync(file);
  db.exec(
    zcode
      ? `create table session (id text primary key, parent_id text, directory text, title text, revert text, time_created integer, time_updated integer);
         create table message (id text primary key, session_id text, time_created integer, data text, sequence integer);
         create table part (id text primary key, message_id text, session_id text, time_created integer, data text, sequence integer);`
      : `create table session (id text primary key, project_id text, parent_id text, directory text, title text, time_created integer, time_updated integer, revert text);
         create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
         create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);`,
  );
  const session = (id: string, parent: string | null, title: string | null): void => {
    if (zcode) db.prepare("insert into session values (?, ?, '/repo/db', ?, null, 1000, 2000)").run(id, parent, title);
    else db.prepare("insert into session values (?, 'p', ?, '/repo/db', ?, 1000, 2000, null)").run(id, parent, title);
  };
  session("ses_root", null, zcode ? "库里的标题" : "New session - 2026-01-17T07:10:22.607Z");
  session("ses_child", "ses_root", "task");
  const message = (id: string, seq: number, info: Record<string, unknown>, parts: Record<string, unknown>[]): void => {
    if (zcode) db.prepare("insert into message values (?, 'ses_root', ?, ?, ?)").run(id, seq, JSON.stringify(info), seq);
    else db.prepare("insert into message values (?, 'ses_root', ?, ?, ?)").run(id, seq, seq, JSON.stringify(info));
    parts.forEach((part, index) => {
      const partId = `${id}_p${index}`;
      if (zcode) db.prepare("insert into part values (?, ?, 'ses_root', ?, ?, ?)").run(partId, id, seq, JSON.stringify(part), seq * 100 + index);
      else db.prepare("insert into part values (?, ?, 'ses_root', ?, ?, ?)").run(partId, id, seq, seq, JSON.stringify(part));
    });
  };
  message("msg_1", 1, { role: "user", time: { created: 1000 } }, [{ type: "text", text: "库里的第一问" }]);
  message("msg_2", 2, { role: "assistant", time: { created: 2000 }, providerID: "zhipuai", modelID: "glm-5.1" }, [
    { type: "step-start" },
    { type: "text", text: "库里的回答" },
    { type: "step-finish", reason: "stop", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
  ]);
  db.close();
}

describe("OpenCode / ZCode（SQLite）", () => {
  test("OpenCode：只列根会话、默认标题退回首条提问；读全文；源目录（库）零写入、不新建 -wal / -shm", async () => {
    const root = join(dir, "opencode");
    await mkdir(root, { recursive: true });
    writeOpencodeLikeDb(join(root, "opencode.db"), false);
    const { section, summary, detail } = await listAndLoad(readerFor([{ source: "opencode", roots: [root] }]), root);
    assert.equal(section.total, 1);
    assert.equal(summary.title, "库里的第一问");
    assert.equal(summary.cwd, "/repo/db");
    assert.deepEqual(texts(detail.records), ["user:库里的第一问", "assistant:库里的回答"]);
    assert.equal(detail.meta.modelId, "glm-5.1");
  });

  test("ZCode：库在 cli/db/db.sqlite，标题用库里的", async () => {
    const root = join(dir, ".zcode");
    await mkdir(join(root, "cli", "db"), { recursive: true });
    writeOpencodeLikeDb(join(root, "cli", "db", "db.sqlite"), true);
    const { summary, detail } = await listAndLoad(readerFor([{ source: "zcode", roots: [root] }]), root);
    assert.equal(summary.title, "库里的标题");
    assert.deepEqual(texts(detail.records), ["user:库里的第一问", "assistant:库里的回答"]);
  });

  test("库认不出（不是 SQLite）：这一段如实报错，别的来源照常列", async () => {
    const broken = join(dir, "opencode-broken");
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "opencode.db"), "not a database");
    const zcodeRoot = join(dir, ".zcode");
    await mkdir(join(zcodeRoot, "cli", "db"), { recursive: true });
    writeOpencodeLikeDb(join(zcodeRoot, "cli", "db", "db.sqlite"), true);
    const sections = await readerFor([
      { source: "opencode", roots: [broken] },
      { source: "zcode", roots: [zcodeRoot] },
    ]).list();
    const opencode = sections.find((section) => section.source === "opencode");
    assert.equal(opencode?.summaries.length, 0);
    assert.match(opencode?.problems[0] ?? "", /could not list .*opencode-broken/);
    assert.equal(sections.find((section) => section.source === "zcode")?.summaries.length, 1);
  });
});

describe("Reasonix", () => {
  test("列 projects/*/sessions 的主 JSONL，标题与目录取 meta 侧车；新版库如实标出没读", async () => {
    const root = join(dir, "reasonix");
    const sessions = join(root, "projects", "p1", "sessions");
    await mkdir(sessions, { recursive: true });
    await mkdir(join(root, "desktop-sessions-v5"), { recursive: true });
    const file = join(sessions, "20260906-021150-deepseek.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({ role: "user", content: "<x>包装</x>\n看看 tmp.py", raw_content: "看看 tmp.py", origin: "user", createdAt: 1757134310000 }),
        JSON.stringify({ role: "assistant", content: "看完了。" }),
      ].join("\n"),
    );
    await writeFile(`${file}.meta`, JSON.stringify({ id: "r-1", topic_title: "tmp.py 检查", workspace_root: "/repo/rx", model: "deepseek-v4" }));
    // 派生物不列
    await writeFile(`${file}.events.jsonl`, "{}");
    const before = await fingerprint(root);
    const [section] = await readerFor([{ source: "reasonix", roots: [root] }]).list();
    assert.equal(section?.total, 1);
    assert.equal(section?.summaries[0]?.title, "tmp.py 检查");
    assert.equal(section?.summaries[0]?.cwd, "/repo/rx");
    assert.match(section?.problems[0] ?? "", /newer store .* not supported yet/);
    const detail = await readerFor([{ source: "reasonix", roots: [root] }]).load(section?.summaries[0]?.ref ?? "");
    assert.deepEqual(texts(detail?.records ?? []), ["user:看看 tmp.py", "assistant:看完了。"]);
    assert.equal(detail?.meta.modelId, "deepseek-v4");
    assert.deepEqual(await fingerprint(root), before);
  });
});

describe("Proma", () => {
  test("按索引列根会话（pi 本子 + Claude 时代界面日志）；子会话不列；用户原文按界面日志还原", async () => {
    const root = join(dir, ".proma");
    const piDir = join(root, "sdk-config", "sessions");
    await mkdir(piDir, { recursive: true });
    await mkdir(join(root, "agent-sessions"), { recursive: true });
    const piFile = join(piDir, "2026-07-20_pi-1.jsonl");
    await writeFile(
      piFile,
      [
        JSON.stringify({ type: "session", version: 3, id: "pi-1", timestamp: "2026-07-20T04:24:59.893Z", cwd: "/repo/proma" }),
        JSON.stringify({
          type: "message",
          id: "e1",
          parentId: null,
          timestamp: "2026-07-20T04:25:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "**当前时间: 2026-07-20**\n\n帮我写周报" }], timestamp: 1 },
        }),
        JSON.stringify({
          type: "message",
          id: "e2",
          parentId: "e1",
          timestamp: "2026-07-20T04:25:01.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "周报写好了" }], provider: "x", model: "glm-5.1", stopReason: "stop", timestamp: 2 },
        }),
      ].join("\n"),
    );
    await writeFile(
      join(root, "agent-sessions.json"),
      JSON.stringify({
        sessions: [
          { id: "pi-1", title: "周报", piSessionFile: piFile, createdAt: 1, updatedAt: 2 },
          { id: "child", title: "子会话", piSessionFile: piFile, parentSessionId: "pi-1", createdAt: 1, updatedAt: 2 },
          { id: "legacy-1", title: "Claude 时代", legacyTranscript: { sourceRuntime: "claude" }, createdAt: 3, updatedAt: 4 },
        ],
      }),
    );
    // Claude 时代的会话：本体就是界面日志（agent-sessions/<id>.jsonl）
    await writeFile(
      join(root, "agent-sessions", "legacy-1.jsonl"),
      [
        { type: "user", message: { role: "user", content: [{ type: "text", text: "看看 @file:%2Frepo%2Fa.md" }] }, parent_tool_use_id: null, _createdAt: 1780000000000 },
        {
          type: "assistant",
          message: { id: "m1", role: "assistant", type: "message", model: "glm-5.1", content: [{ type: "text", text: "看过了" }], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } },
          parent_tool_use_id: null,
          _createdAt: 1780000001000,
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );
    // 两条都比界面日志 mtime 旧：pi 那条放到最新，listAndLoad 读到的是它
    const future = new Date(Date.now() + 60_000);
    await utimes(piFile, future, future);
    const reader = readerFor([{ source: "proma", roots: [root] }]);
    const { section, summary, detail } = await listAndLoad(reader, root);
    assert.equal(section.total, 2);
    assert.equal(summary.title, "周报");
    assert.equal(summary.cwd, "/repo/proma");
    // 用户原文：没有界面日志时按 Proma 的拼接格式剥掉「当前时间」段
    assert.deepEqual(texts(detail.records), ["user:帮我写周报", "assistant:周报写好了"]);

    const legacy = section.summaries.find((item) => item.title === "Claude 时代");
    assert.ok(legacy !== undefined);
    const legacyDetail = await reader.load(legacy.ref);
    assert.deepEqual(texts(legacyDetail?.records ?? []), ["user:看看 @/repo/a.md", "assistant:看过了"]);
  });

  test("索引里的 pi 路径越出 Proma 数据目录：不列、不读", async () => {
    const root = join(dir, ".proma");
    await mkdir(root, { recursive: true });
    const outside = join(dir, "elsewhere.jsonl");
    await writeFile(outside, JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "t", cwd: "/" }));
    await writeFile(join(root, "agent-sessions.json"), JSON.stringify({ sessions: [{ id: "x", title: "越界", piSessionFile: outside }] }));
    const [section] = await readerFor([{ source: "proma", roots: [root] }]).list();
    assert.equal(section?.total, 0);
  });
});

describe("开关、出错与列目录的成本", () => {
  test("关掉的来源不列；读它的 ref 说明已关闭", async () => {
    const root = join(dir, ".codex");
    const day = join(root, "sessions", "2026", "09", "12");
    await mkdir(day, { recursive: true });
    await writeFile(
      join(day, "rollout-a.jsonl"),
      [
        codexLine("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "问" }] }),
        codexLine("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "答" }] }),
      ].join("\n"),
    );
    const [summary] = (await readerFor([{ source: "codex", roots: [root] }]).list())[0]?.summaries ?? [];
    assert.ok(summary !== undefined);
    const off = readerFor([{ source: "codex", roots: [root] }], { codex: false });
    assert.deepEqual(await off.list(), []);
    // 设置页照样数得到它（关着也要让用户看见有多少条）
    assert.deepEqual(await off.inventory(), [{ source: "codex", total: 1, problems: [] }]);
    await assert.rejects(off.load(summary.ref), /Codex is turned off in Settings › External sources/);
  });

  test("格式认不出：读全文如实报错（哪个来源、哪条、哪个文件），不返回空记录", async () => {
    const root = join(dir, ".codex");
    const day = join(root, "sessions", "2026", "09", "12");
    await mkdir(day, { recursive: true });
    const file = join(day, "rollout-weird.jsonl");
    await writeFile(file, '{"some":"future format"}\n');
    const reader = readerFor([{ source: "codex", roots: [root] }]);
    const [summary] = (await reader.list())[0]?.summaries ?? [];
    assert.ok(summary !== undefined);
    await assert.rejects(reader.load(summary.ref), (error: Error) => {
      assert.match(error.message, /Could not read Codex session ext:codex:[0-9a-f]{16}/);
      assert.ok(error.message.includes(file));
      assert.match(error.message, /no messages in a format Orbita recognizes/);
      return true;
    });
  });

  test("上千个会话文件：列目录只 stat、只对入选的读头部，2 秒内列完", async () => {
    const root = join(dir, ".claude");
    const projects = join(root, "projects");
    const body = `${claudeRow("user", "u1", null, "问".repeat(200), "2026-09-20T10:00:01.000Z")}\n${claudeRow("assistant", "a1", "u1", { type: "text", text: "答" }, "2026-09-20T10:00:02.000Z")}\n`;
    for (let project = 0; project < 40; project += 1) {
      const projectDir = join(projects, `-repo-${project}`);
      await mkdir(projectDir, { recursive: true });
      for (let index = 0; index < 30; index += 1) await writeFile(join(projectDir, `s-${project}-${index}.jsonl`), body);
    }
    // 最新的一条放在中间，证明按 mtime 排而不是按文件名
    const newest = join(projects, "-repo-17", "s-17-3.jsonl");
    const future = new Date(Date.now() + 60_000);
    await utimes(newest, future, future);
    const started = performance.now();
    const [section] = await readerFor([{ source: "claude-code", roots: [root] }]).list();
    const elapsed = performance.now() - started;
    assert.equal(section?.total, 1200);
    assert.equal(section?.summaries.length, 5);
    assert.ok(elapsed < 2000, `列目录用了 ${Math.round(elapsed)}ms`);
    const detail = await readerFor([{ source: "claude-code", roots: [root] }]).load(section?.summaries[0]?.ref ?? "");
    assert.equal(detail?.sourceFile, newest);
  });
});
