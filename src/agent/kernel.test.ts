import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, Message, Model, Models } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { buildSessionContext, convertToLlm, migrateSessionEntries, parseSessionEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ConversationId, Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { KernelAgent } from "../shared/kernel.ts";
import { kernelCompaction, kernelSettings, KernelPool, SessionIndexDoc, withBillingPatch, withCacheRetention } from "./kernel.ts";
import { piRequestOptions } from "./kernel-prompt.ts";
import { compactionKeepRecentTokens, compactionReserveTokens } from "./compaction-settings.ts";
import { RETRY_BASE_DELAY_MS, RETRY_MAX_ATTEMPTS, RETRY_MAX_DELAY_MS } from "./retry-policy.ts";
import { assistant, book, result, user } from "./legacy-book-fixture.ts";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orbita-kernel-"));
  dirs.push(dir);
  return dir;
}
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const faux = fauxProvider({ models: [{ id: "tiny", contextWindow: 100_000, maxTokens: 1000 }] });
faux.setResponses(Array.from({ length: 50 }, (_, index) => fauxAssistantMessage(`answer ${index}`)));
const models = createModels();
models.setProvider(faux.provider);

const AGENT: KernelAgent = {
  provider: null,
  modelId: "tiny",
  thinkingLevel: "off",
  cwd: "/w",
  role: "root",
  compaction: { enabled: true, reservePercent: 20 },
};

function pool(dir: string, extra: Partial<ConstructorParameters<typeof KernelPool>[0]> = {}): KernelPool {
  return new KernelPool({ dir, models: () => models, ...extra });
}

/** 旧内核下一轮会发的上下文：pi 1.5.2 自己的 buildSessionContext + convertToLlm（纯函数，不碰文件） */
function oldContext(raw: string): Message[] {
  const entries = parseSessionEntries(raw);
  migrateSessionEntries(entries);
  const body = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
  return convertToLlm(buildSessionContext(body).messages).filter((message) => message.role !== "system");
}

const COMPARE_MODEL = { id: "m", provider: "p", api: "anthropic-messages", input: ["text", "image"] } as unknown as Model<Api>;

/**
 * 缺结果的工具调用（历史停在调用之后）两边都会补一条错误结果，只是文案不同：旧内核在 pi-ai 发请求前补
 * 「No result provided」，durable 在 context() 里补「Tool result unavailable: history ends before this call
 * completed.」。补出来的这条只比配对，不比文案——这是两个内核唯一一处已知的措辞差别。
 */
const SYNTHETIC_RESULTS = new Set(["No result provided", "Tool result unavailable: history ends before this call completed."]);

/** 每条消息一个指纹：角色 + 正文（工具结果另带配对的 toolCallId），不含时间戳 */
function fingerprints(messages: readonly Message[]): string[] {
  return transformMessages([...messages], COMPARE_MODEL).map((message) => {
    if (message.role === "toolResult" && message.isError && message.content.length === 1) {
      const only = message.content[0];
      if (only?.type === "text" && SYNTHETIC_RESULTS.has(only.text)) return `toolResult:synthetic:${message.toolCallId}`;
    }
    const body =
      message.role === "toolResult"
        ? { role: message.role, toolCallId: message.toolCallId, isError: message.isError, content: message.content }
        : { role: message.role, content: message.content };
    return `${message.role}:${createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16)}`;
  });
}

async function migratedContext(kernel: KernelPool, library: string, conversationId: number): Promise<Message[]> {
  const harness = (await kernel.library(library)).harness;
  const conversation = await harness.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT);
  assert.ok(conversation !== undefined);
  const view = await conversation.context(BACKGROUND_CONTEXT);
  return view.messages.filter((message) => message.role !== "system");
}

const COMPACTED = book([
  user("u1", "first"),
  assistant("a1", "reading", ["c1", "c2"]),
  result("r2", "c2"),
  result("r1", "c1"),
  assistant("a2", "done"),
  { type: "thinking_level_change", id: "t1", thinkingLevel: "high" },
  user("u2", "second"),
  assistant("a3", "ok"),
  { type: "compaction", id: "k1", summary: "S1", firstKeptEntryId: "t1", tokensBefore: 10 },
  user("u3", "third"),
  assistant("a4", "", [], "error"),
  { type: "custom_message", id: "cm", customType: "orbita.undo", content: "files restored", display: true },
  assistant("a5", "fine", ["c3"]),
  result("r3", "c3"),
  { type: "compaction", id: "k2", summary: "S2", firstKeptEntryId: "a5", tokensBefore: 20 },
  user("u4", "fourth"),
]);

describe("KernelPool：开库、建会话、提交、重开（剧本第 5 条，假模型 + 真 SQLite）", () => {
  it("一轮问答落盘，关库重开后历史还在", async () => {
    const dir = await tempDir();
    const first = pool(dir);
    const opened = await first.open({ library: "root-1.sqlite", sessionId: "root-1", legacy: null, agent: AGENT });
    assert.ok(opened.ok);
    assert.equal(opened.migrated, false);
    const harness = (await first.library("root-1.sqlite")).harness;
    const conversation = await harness.conversation(opened.conversationId as ConversationId, BACKGROUND_CONTEXT);
    assert.ok(conversation !== undefined);
    await conversation.configure({ model: { provider: "faux", modelId: "tiny" } }, BACKGROUND_CONTEXT);
    const submission = await conversation.submit({ type: "input", content: "hello" }, BACKGROUND_CONTEXT);
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    assert.equal(settled.status, "done");
    await first.closeAll();

    const second = pool(dir);
    const again = await second.open({ library: "root-1.sqlite", sessionId: "root-1", legacy: null, agent: AGENT });
    assert.ok(again.ok);
    assert.equal(again.conversationId, opened.conversationId);
    const messages = await migratedContext(second, "root-1.sqlite", again.conversationId);
    assert.deepEqual(
      messages.map((message) => message.role),
      ["user", "assistant"],
    );
    const answer = messages[1];
    assert.ok(answer?.role === "assistant");
    assert.match(JSON.stringify(answer.content), /answer \d+/);
    await second.closeAll();
  });
});

describe("旧会话惰性迁移（剧本第 10、11、13 条）", () => {
  it("迁后下一轮的上下文与旧内核逐条一致（两次压缩、乱序工具结果、出错回答、custom_message）", async () => {
    const dir = await tempDir();
    const file = join(dir, "book.jsonl");
    await writeFile(file, COMPACTED);
    const kernel = pool(dir);
    const opened = await kernel.open({ library: "r.sqlite", sessionId: "s1", legacy: { piSessionFile: file }, agent: AGENT });
    assert.ok(opened.ok);
    assert.equal(opened.migrated, true);
    const expected = oldContext(COMPACTED);
    const actual = await migratedContext(kernel, "r.sqlite", opened.conversationId);
    assert.deepEqual(fingerprints(actual), fingerprints(expected));
    // 第二次压缩之后：摘要 S2 + 保留段 a5 r3 + u4
    assert.equal(expected.length, 4);
    await kernel.closeAll();
  });

  it("testdata 里的三份真实本子，迁后上下文与旧内核一致", async () => {
    const dir = await tempDir();
    const kernel = pool(dir);
    const testdata = join(import.meta.dirname, "../main/session/testdata");
    const names = (await readdir(testdata)).filter((name) => name.endsWith(".jsonl"));
    assert.equal(names.length, 3);
    for (const [index, name] of names.entries()) {
      const raw = await readFile(join(testdata, name), "utf8");
      const opened = await kernel.open({ library: "t.sqlite", sessionId: `t${index}`, legacy: { piSessionFile: join(testdata, name) }, agent: AGENT });
      assert.ok(opened.ok, name);
      assert.deepEqual(fingerprints(await migratedContext(kernel, "t.sqlite", opened.conversationId)), fingerprints(oldContext(raw)), name);
    }
    await kernel.closeAll();
  });

  it("迁移是复制：原件一个字节不动；再打开不重复迁；索引里只有一份", async () => {
    const dir = await tempDir();
    const file = join(dir, "book.jsonl");
    // 末尾不带换行：pi 自己的 loadEntriesFromFile 遇到这种文件会补写一个换行，我们的只读解析不会
    const raw = COMPACTED.trimEnd();
    await writeFile(file, raw);
    const digest = createHash("sha256").update(raw).digest("hex");
    const kernel = pool(dir);
    const [a, b] = await Promise.all([
      kernel.open({ library: "r.sqlite", sessionId: "s1", legacy: { piSessionFile: file }, agent: AGENT }),
      kernel.open({ library: "r.sqlite", sessionId: "s1", legacy: { piSessionFile: file }, agent: AGENT }),
    ]);
    assert.ok(a.ok && b.ok);
    assert.equal(a.conversationId, b.conversationId);
    const third = await kernel.open({ library: "r.sqlite", sessionId: "s1", legacy: { piSessionFile: file }, agent: AGENT });
    assert.ok(third.ok);
    assert.equal(third.migrated, false);
    assert.equal(third.conversationId, a.conversationId);
    assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), digest);
    const harness = (await kernel.library("r.sqlite")).harness;
    assert.deepEqual((await harness.snapshot(SessionIndexDoc, BACKGROUND_CONTEXT))?.sessions, { s1: a.conversationId });
    await kernel.closeAll();
  });

  it("绕过进程内排队的第二个库池（模拟另一次打开）也只迁出一份", async () => {
    const dir = await tempDir();
    const file = join(dir, "book.jsonl");
    await writeFile(file, COMPACTED);
    const first = pool(dir);
    const opened = await first.open({ library: "r.sqlite", sessionId: "s1", legacy: { piSessionFile: file }, agent: AGENT });
    assert.ok(opened.ok);
    await first.closeAll();
    const second = pool(dir);
    const again = await second.open({ library: "r.sqlite", sessionId: "s1", legacy: { piSessionFile: file }, agent: AGENT });
    assert.ok(again.ok);
    assert.equal(again.migrated, false);
    assert.equal(again.conversationId, opened.conversationId);
    await second.closeAll();
  });

  it("迁到一半库写失败：这条报失败、原件不动；重开后库里没有半份，再迁一次是完整的一份", async () => {
    const dir = await tempDir();
    const file = join(dir, "book.jsonl");
    await writeFile(file, COMPACTED);
    let fail = true;
    // 迁移那次提交（带 entry 的那一次）失败：模拟磁盘满 / 进程在提交途中没了
    const flaky = (storage: Storage): Storage => new Proxy(storage, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (property !== "commit" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
        return (...args: unknown[]) => {
          const batches = args[0] as readonly { entries?: readonly unknown[] }[];
          const big = JSON.stringify(batches).includes("pi.compaction");
          if (fail && big) return Promise.reject(new Error("SQLITE_FULL: database or disk is full"));
          return (value as (...inner: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const first = pool(dir, { openStorage: async (path) => flaky(await openNodeSqliteStorage(path)) });
    const broken = await first.open({ library: "r.sqlite", sessionId: "s1", legacy: { piSessionFile: file }, agent: AGENT });
    assert.equal(broken.ok, false);
    if (!broken.ok) assert.match(broken.reason, /disk is full|迁移失败/);
    assert.equal(await readFile(file, "utf8"), COMPACTED);
    await first.closeAll().catch(() => undefined);

    fail = false;
    const second = pool(dir, { openStorage: async (path) => flaky(await openNodeSqliteStorage(path)) });
    const harness = (await second.library("r.sqlite")).harness;
    assert.equal((await harness.snapshot(SessionIndexDoc, BACKGROUND_CONTEXT))?.sessions["s1"], undefined);
    const fixed = await second.open({ library: "r.sqlite", sessionId: "s1", legacy: { piSessionFile: file }, agent: AGENT });
    assert.ok(fixed.ok);
    assert.equal(fixed.migrated, true);
    assert.deepEqual(fingerprints(await migratedContext(second, "r.sqlite", fixed.conversationId)), fingerprints(oldContext(COMPACTED)));
    await second.closeAll();
  });

  it("认不出的本子：报一句原因、原件不动、不影响同库别的会话", async () => {
    const dir = await tempDir();
    const bad = join(dir, "bad.jsonl");
    const good = join(dir, "good.jsonl");
    const badRaw = book([user("u1", "a"), { type: "context_edit", id: "e1", targetId: "u1" }]);
    await writeFile(bad, badRaw);
    await writeFile(good, COMPACTED);
    const kernel = pool(dir);
    const failed = await kernel.open({ library: "r.sqlite", sessionId: "bad", legacy: { piSessionFile: bad }, agent: AGENT });
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.match(failed.reason, /context_edit/);
    assert.equal(await readFile(bad, "utf8"), badRaw);
    const missing = await kernel.open({ library: "r.sqlite", sessionId: "gone", legacy: { piSessionFile: join(dir, "nope.jsonl") }, agent: AGENT });
    assert.equal(missing.ok, false);
    const fine = await kernel.open({ library: "r.sqlite", sessionId: "good", legacy: { piSessionFile: good }, agent: AGENT });
    assert.ok(fine.ok);
    await kernel.closeAll();
  });
});

describe("库布局：一棵会话树一库（剧本第 6 条）", () => {
  it("同一棵树的子会话进同一个库；删一棵树只删它的库文件，别的树照常打开", async () => {
    const dir = await tempDir();
    const kernel = pool(dir);
    const root = await kernel.open({ library: "tree-a.sqlite", sessionId: "tree-a", legacy: null, agent: AGENT });
    const child = await kernel.open({ library: "tree-a.sqlite", sessionId: "child-a", legacy: null, agent: { ...AGENT, role: "child" } });
    const other = await kernel.open({ library: "tree-b.sqlite", sessionId: "tree-b", legacy: null, agent: AGENT });
    assert.ok(root.ok && child.ok && other.ok);
    assert.notEqual(root.conversationId, child.conversationId);
    const index = await (await kernel.library("tree-a.sqlite")).harness.snapshot(SessionIndexDoc, BACKGROUND_CONTEXT);
    assert.deepEqual(Object.keys(index?.sessions ?? {}).sort(), ["child-a", "tree-a"]);
    await kernel.drop("tree-a.sqlite");
    const files = await readdir(dir);
    assert.equal(files.some((name) => name.startsWith("tree-a.sqlite")), false);
    assert.equal(files.includes("tree-b.sqlite"), true);
    await kernel.closeAll();
    const reopened = pool(dir);
    const back = await reopened.open({ library: "tree-b.sqlite", sessionId: "tree-b", legacy: null, agent: AGENT });
    assert.ok(back.ok);
    assert.equal(back.migrated, false);
    assert.equal(back.conversationId, other.conversationId);
    await reopened.drop("never-existed.sqlite");
    await reopened.closeAll();
  });

  it("库名带路径一律拒绝", async () => {
    const kernel = pool(await tempDir());
    const result = await kernel.open({ library: "../escape.sqlite", sessionId: "x", legacy: null, agent: AGENT });
    assert.equal(result.ok, false);
    await assert.rejects(kernel.drop("../escape.sqlite"));
  });
});

describe("withCacheRetention：缓存时长按根 / 子会话判（剧本第 8 条）", () => {
  function recording(): { models: Models; seen: (string | undefined)[] } {
    const seen: (string | undefined)[] = [];
    const inner = createModels();
    inner.setProvider(faux.provider);
    const spy = new Proxy(inner, {
      get(target, property) {
        if (property === "streamSimple") {
          return (model: Model<Api>, context: Parameters<Models["streamSimple"]>[1], options?: Parameters<Models["streamSimple"]>[2]) => {
            seen.push(options?.cacheRetention);
            return target.streamSimple(model, context, options);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { models: spy, seen };
  }
  const official = { ...faux.getModel(), api: "anthropic-messages", baseUrl: "https://api.anthropic.com" } as Model<Api>;

  it("Anthropic 官方直连的根会话补 long，子会话与显式指定的不动", () => {
    const { models: spy, seen } = recording();
    const wrapped = withCacheRetention(spy, (id) => (id === "root-session" ? "root" : "child"));
    wrapped.streamSimple(official, { messages: [] }, { sessionId: "root-session" });
    wrapped.streamSimple(official, { messages: [] }, { sessionId: "child-session" });
    wrapped.streamSimple(official, { messages: [] }, { sessionId: "root-session", cacheRetention: "none" });
    wrapped.streamSimple(faux.getModel(), { messages: [] }, { sessionId: "root-session" });
    assert.deepEqual(seen, ["long", undefined, "none", undefined]);
    // 其余方法照常透传
    assert.equal(wrapped.getModel("faux", "tiny")?.id, "tiny");
  });
});

describe("运行策略与旧内核对齐（剧本第 8 条）", () => {
  it("压缩阈值按「剩余百分比 × 模型窗口」换算，与旧内核同一个公式；不开后台压缩", () => {
    for (const window of [16_000, 200_000, 1_000_000]) {
      assert.deepEqual(kernelCompaction({ ...AGENT, compaction: { enabled: true, reservePercent: 15 } }, window), {
        enabled: true,
        reserveTokens: compactionReserveTokens(15, window),
        keepRecentTokens: compactionKeepRecentTokens(window),
        backgroundTokens: 0,
      });
    }
    assert.equal(kernelCompaction({ ...AGENT, compaction: { enabled: false, reservePercent: 20 } }, 100_000).enabled, false);
  });

  it("重试节奏同 retry-policy.ts", () => {
    assert.deepEqual(kernelSettings().retry, {
      enabled: true,
      maxRetries: RETRY_MAX_ATTEMPTS,
      baseDelayMs: RETRY_BASE_DELAY_MS,
      maxAgentDelayMs: RETRY_MAX_DELAY_MS,
    });
  });
});

describe("withBillingPatch：订阅车道改写覆盖新内核的每一个出站请求", () => {
  const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
  const oauth = (): Record<string, unknown> => ({ model: "claude", system: [{ type: "text", text: IDENTITY }, { type: "text", text: "You are an expert coding assistant." }], messages: [] });
  function capturing(): { inner: Models; seen: { kind: string; onPayload: unknown }[] } {
    const seen: { kind: string; onPayload: unknown }[] = [];
    const inner = {
      streamSimple: (_model: unknown, _context: unknown, options?: { onPayload?: unknown }) => {
        seen.push({ kind: "stream", onPayload: options?.onPayload });
        return null as unknown as ReturnType<Models["streamSimple"]>;
      },
      completeSimple: (_model: unknown, _context: unknown, options?: { onPayload?: unknown }) => {
        seen.push({ kind: "complete", onPayload: options?.onPayload });
        return Promise.resolve(null) as unknown as ReturnType<Models["completeSimple"]>;
      },
    } as unknown as Models;
    return { inner, seen };
  }
  const model = { id: "claude" } as unknown as Model<Api>;

  it("主循环（durable 已带 onPayload）与压缩（completeSimple，不带）都被改写；非 OAuth 原样", async () => {
    const { inner, seen } = capturing();
    const wrapped = withBillingPatch(inner);
    wrapped.streamSimple(model, { messages: [] } as never, { onPayload: (payload: unknown) => payload });
    await wrapped.completeSimple(model, { messages: [] } as never, {});
    assert.deepEqual(seen.map((entry) => entry.kind), ["stream", "complete"]);
    for (const entry of seen) {
      const onPayload = entry.onPayload as (payload: unknown, model: Model<Api>) => Promise<unknown>;
      const patched = (await onPayload(oauth(), model)) as { system: { text: string }[] } | undefined;
      assert.ok(patched !== undefined, `${entry.kind} 的 OAuth 请求被改写`);
      assert.doesNotMatch(JSON.stringify(patched.system), /official CLI for Claude\.","type/);
      // 非 OAuth：不改写——返回的是 durable 自己钩子链的结果（主循环）或 undefined（压缩），内容都与原样相同
      const plain = { model: "gpt", system: [{ type: "text", text: "plain" }] };
      assert.deepEqual((await onPayload(plain, model)) ?? plain, plain);
    }
  });
});

describe("piRequestOptions：请求身份与请求层选项与旧内核同值", () => {
  it("详细 User-Agent 带 pi 版本；PI_TELEMETRY=0 时不带署名，=1 时带 pi 的署名", () => {
    const previous = process.env["PI_TELEMETRY"];
    try {
      process.env["PI_TELEMETRY"] = "0";
      const off = piRequestOptions();
      assert.equal(off.identity.userAgent, "detailed");
      assert.match(String(off.identity.version), /^\d+\.\d+\.\d+/);
      assert.equal(off.identity.attribution, null);
      process.env["PI_TELEMETRY"] = "1";
      assert.equal(piRequestOptions().identity.attribution?.name, "pi");
      assert.ok(off.stream.timeoutMs > 0);
    } finally {
      if (previous === undefined) delete process.env["PI_TELEMETRY"];
      else process.env["PI_TELEMETRY"] = previous;
    }
  });
});
