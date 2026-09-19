/**
 * B-2 的账：start_task 的继承解析、两道门（子不能再派 / 并发上限）、meta 先行、
 * canDispatch 派生。真 store（ProviderStore / SessionStore / McpStore / SettingsStore，
 * 临时目录——write-requests.test 同款）+ 假 host（host-core.test 同款思路）。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCommand } from "../../shared/agent-ipc.ts";
import type { SessionMeta } from "../../shared/session.ts";
import { ProviderStore, type SecretsPort } from "../provider/store.ts";
import { SessionStore } from "../session/store.ts";
import { SettingsStore } from "../settings/store.ts";
import { McpStore } from "../mcp/store.ts";
import { MAX_RUNNING_CHILDREN, createTurnAssembler } from "./dispatch.ts";

const PARENT = "11111111-2222-3333-4444-555555555555";

/** host 只需要「把命令收下来、回一个 pi 本子路径」——断言打在收到的命令上。 */
class FakeHost {
  readonly commands: AgentCommand[] = [];
  submitResult: string | null = "child.jsonl";
  submit(command: Extract<AgentCommand, { type: "submit" }>): Promise<string | null> {
    this.commands.push(command);
    return Promise.resolve(this.submitResult);
  }
  interrupt(): Promise<string | null> {
    return Promise.resolve(null);
  }
  compact(): Promise<string | null> {
    return Promise.resolve(null);
  }
  generateTitle(): void {}
}

class MemorySecrets implements SecretsPort {
  readonly values = new Map<string, string>();
  async set(account: string, plaintext: string): Promise<void> {
    this.values.set(account, plaintext);
  }
  async get(account: string): Promise<string | null> {
    return this.values.get(account) ?? null;
  }
  async delete(account: string): Promise<void> {
    this.values.delete(account);
  }
}

let dir = "";
let sessions: SessionStore;
let assembler: ReturnType<typeof createTurnAssembler>;
let host: FakeHost;
let secrets: MemorySecrets;

const parentMeta = (patch: Partial<SessionMeta> = {}): SessionMeta => ({
  id: PARENT,
  title: "Parent task",
  titleSource: "auto",
  cwd: join(dir, "repo"),
  workspaceId: "ws-1",
  providerId: "openai",
  modelId: "gpt-5",
  mode: "manual",
  parentSessionId: null,
  piSessionFile: "parent.jsonl",
  pinned: false,
  archived: false,
  recentQueries: [],
  stats: null,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-dispatch-"));
  sessions = new SessionStore(join(dir, "sessions"));
  secrets = new MemorySecrets();
  const providers = new ProviderStore(dir, secrets);
  await providers.upsert({
    provider: {
      id: "openai",
      displayName: "OpenAI",
      endpoint: { baseUrl: "https://api.openai.com/v1/", api: "openai-completions" },
      models: { declared: [{ id: "gpt-5" }, { id: "gpt-5-mini" }] },
      auth: { scheme: "api_key" },
    },
    apiKey: "sk-test",
  });
  host = new FakeHost();
  assembler = createTurnAssembler({
    host,
    providers,
    sessions,
    piSessionDir: join(dir, "pi-sessions"),
    protectedPaths: [join(dir, "sessions")],
    skillDirs: (workspaceId) => [workspaceId === null ? "global" : `ws-${workspaceId}`],
    mcp: new McpStore(dir),
    settings: new SettingsStore(dir),
  });
  await sessions.ensureSession(parentMeta());
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("startTask（B-2）", () => {
  test("继承父的 cwd / workspace / provider / mode，model 可覆盖；先落 meta 再开轮，canDispatch=false", async () => {
    const result = await assembler.startTask({
      sessionId: PARENT,
      title: "Fix login",
      prompt: "Fix the redirect.",
      model: " gpt-5-mini ",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const command = host.commands[0] as Extract<AgentCommand, { type: "submit" }>;
    assert.equal(command.canDispatch, false);
    assert.equal(command.cwd, join(dir, "repo"));
    assert.equal(command.modelId, "gpt-5-mini");
    assert.equal(command.mode, "manual");
    assert.equal(command.provider.apiKey, "sk-test");
    assert.deepEqual(command.skillsDirs, ["ws-ws-1"]);
    assert.equal(command.text, "Fix the redirect.");

    const child = await sessions.getMeta(result.card.sessionId);
    assert.ok(child !== null);
    assert.equal(child.parentSessionId, PARENT);
    assert.equal(child.cwd, join(dir, "repo"));
    assert.equal(child.workspaceId, "ws-1");
    assert.equal(child.providerId, "openai");
    assert.equal(child.modelId, "gpt-5-mini");
    assert.equal(child.mode, "manual");
    assert.equal(child.titleSource, "auto");
    assert.equal(child.title, "Fix login");
    // 先落 meta 再开轮：submit 返回时 meta 已在（首条 progress 不会撞上存在性守卫）
    assert.equal(child.piSessionFile, "child.jsonl");
    assert.equal(result.card.title, "Fix login");
    // 回执要拦住父模型的两联想：不等它、别替它报完成
    assert.match(result.text, /NOT be notified/);
  });

  test("title 空着退 prompt 首行（derived）——auto-title 以后还能接手", async () => {
    const result = await assembler.startTask({ sessionId: PARENT, title: "", prompt: "Write tests\nmore lines" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const child = await sessions.getMeta(result.card.sessionId);
    assert.equal(child?.title, "Write tests");
    assert.equal(child?.titleSource, "derived");
  });

  test("父不在盘上：拒绝且不开轮", async () => {
    const result = await assembler.startTask({
      sessionId: "99999999-9999-9999-9999-999999999999",
      title: "T",
      prompt: "P",
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /not on disk/);
    assert.equal(host.commands.length, 0);
  });

  test("子不能再派：深度恒为 1 的第二道门（第一道是工具不发给子）", async () => {
    const first = await assembler.startTask({ sessionId: PARENT, title: "Child", prompt: "P" });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const result = await assembler.startTask({ sessionId: first.card.sessionId, title: "Grandchild", prompt: "P" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /depth limit/);
    assert.equal(host.commands.length, 1); // 孙会话没开出来
  });

  test(`同父在跑的子 ≥ ${MAX_RUNNING_CHILDREN}：拒绝并说明；一条 settle 后放行`, async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_RUNNING_CHILDREN; i++) {
      const result = await assembler.startTask({ sessionId: PARENT, title: `C${i}`, prompt: "P" });
      assert.equal(result.ok, true);
      if (result.ok) ids.push(result.card.sessionId);
    }
    for (const id of ids) assembler.observe({ type: "phase", sessionId: id, phase: "turn" });
    const blocked = await assembler.startTask({ sessionId: PARENT, title: "C4", prompt: "P" });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.match(blocked.error, /already running/);
    assert.equal(host.commands.length, MAX_RUNNING_CHILDREN);

    const settled = ids[0];
    assert.ok(settled !== undefined);
    assembler.observe({ type: "phase", sessionId: settled, phase: "idle" });
    const allowed = await assembler.startTask({ sessionId: PARENT, title: "C4", prompt: "P" });
    assert.equal(allowed.ok, true);
    assert.equal(host.commands.length, MAX_RUNNING_CHILDREN + 1);
  });

  test("父缺 API key：整个派发失败并如实告诉模型", async () => {
    // 密钥库被清掉（用户在系统里删了 key）：resolveApiKey 返回 null，派发不受理
    secrets.values.clear();
    const result = await assembler.startTask({ sessionId: PARENT, title: "T", prompt: "P" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /API key/);
    assert.equal(host.commands.length, 0);
  });
});

describe("canDispatch 派生（B-2）", () => {
  test("renderer 开轮：顶层 true、子会话 false——用户续聊子会话也派不出去", async () => {
    const topInput = {
      sessionId: PARENT,
      text: "hi",
      cwd: "/repo",
      workspaceId: "ws-1" as const,
      providerId: "openai",
      modelId: "gpt-5",
      mode: "manual" as const,
      resume: null,
    };
    await assembler.submit({ ...topInput, resume: null });
    assert.equal((host.commands[0] as { canDispatch?: boolean }).canDispatch, true);

    const child = await assembler.startTask({ sessionId: PARENT, title: "C", prompt: "P" });
    assert.equal(child.ok, true);
    if (!child.ok) return;
    host.commands.length = 0;
    await assembler.submit({ ...topInput, sessionId: child.card.sessionId });
    assert.equal((host.commands[0] as { canDispatch?: boolean }).canDispatch, false);
  });
});
