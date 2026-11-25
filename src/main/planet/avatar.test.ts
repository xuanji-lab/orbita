import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AvatarJobs, parseManifest, policySlots, type AvatarDeps, type ScriptResult } from "./avatar.ts";
import { applySubAgentRequest } from "./sub-agent-requests.ts";
import { SubAgentStore } from "./sub-agents.ts";
import type { SubmitAgentInput } from "../../shared/agent-ipc.ts";
import { defaultThinkingLevel } from "../../shared/model-defaults.ts";
import { resolveAvatarModel, type AvatarGenerateRequest, type AvatarJob } from "../../shared/planet-avatar.ts";
import type { ProviderDto } from "../../shared/provider.ts";
import type { SessionMeta } from "../../shared/session.ts";
import { DEFAULT_SETTINGS, type AvatarModelChoice } from "../../shared/settings.ts";
import type { Workspace } from "../../shared/workspace.ts";

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** 一座有主星设计稿和一颗行星（rec，有档案）的星系；插件根里放一份 image_first 原则 */
async function fixture(): Promise<{ ws: Workspace; root: string }> {
  const path = await mkdtemp(join(tmpdir(), "orbita-avatar-"));
  await mkdir(join(path, "planet", "agents", "rec"), { recursive: true });
  await writeFile(join(path, "planet", "design.json"), JSON.stringify({ name: "烛霓", mass: { value: 600, unit: "M⊕" } }));
  await writeFile(
    join(path, "planet", "galaxy.json"),
    JSON.stringify({ version: 1, main: { flip: true }, planets: [{ id: "rec", name: "聆箴", composition: "rock", orbit: 19, mix: { seed: 7, items: [{ id: "Fe", kind: "element", scope: "bulk", basis: "mass_fraction", share: 0.3, origin: "user" }] } }] }),
  );
  await writeFile(join(path, "planet", "agents", "rec", "agent.json"), JSON.stringify({ version: 1, id: "rec", name: "聆箴", role: "记忆系统调研", createdAt: 1, updatedAt: 1, source: "panel" }));
  const root = await mkdtemp(join(tmpdir(), "orbita-avatar-plugin-"));
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(join(root, "data", "render-policy.json"), JSON.stringify({ label: "Qwen 2 张 + SVG 1 张", candidates: ["image_model", "image_model", "model_svg"] }));
  return { ws: { id: "w1", name: "orbita", path } as Workspace, root };
}

interface Harness {
  jobs: AvatarJobs;
  emitted: AvatarJob[];
  submitted: SubmitAgentInput[];
  metas: SessionMeta[];
  scripts: string[][];
  aborted: string[];
}

/** 每个用例建的任务表都在用例结束时 dispose（停掉轮询与超时计时），不留东西拖住 node --test 退出 */
const made: AvatarJobs[] = [];
afterEach(() => {
  for (const jobs of made.splice(0)) jobs.dispose();
});

function harness(ws: Workspace, root: string | null, overrides: Partial<AvatarDeps> = {}): Harness {
  const h: Harness = { jobs: null as unknown as AvatarJobs, emitted: [], submitted: [], metas: [], scripts: [], aborted: [] };
  let n = 0;
  h.jobs = new AvatarJobs({
    workspaces: { list: async () => [ws] },
    pluginRoot: async () => root,
    sessions: { ensureSession: async (meta) => void h.metas.push(meta), remove: async () => undefined },
    resolveModel: async () => ({ ok: true, providerId: "kimi", modelId: "k3", thinkingLevel: "medium" }),
    submitTurn: async (input) => void h.submitted.push(input),
    abort: (id) => void h.aborted.push(id),
    // 每次出图前都会先读一次出图原则（policy，不碰候选目录）：不计进「对候选目录跑的脚本」
    runScript: async (_root, args): Promise<ScriptResult> => {
      if (args[0] !== "policy") h.scripts.push([...args]);
      return { code: 0, stdout: "{}", stderr: "" };
    },
    loadImage: async (path) => `data:${path.split("/").pop()}`,
    emit: (job) => void h.emitted.push(job),
    now: () => 1000,
    newId: () => `s${++n}`,
    pollMs: 5,
    timeoutMs: 2000,
    ...overrides,
  });
  made.push(h.jobs);
  return h;
}

/** 模拟插件写账本：一轮三位 */
async function writeManifest(dir: string, slots: unknown[], candidates: unknown[] = []): Promise<void> {
  await mkdir(join(dir, "candidates"), { recursive: true });
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({ version: 1, rounds: [{ round: 1, policy: { preset: "image_first", label: "Qwen 2 张 + SVG 1 张" }, notes: [], slots, candidates }] }),
  );
}

const slot = (n: number, wanted: string, backend: string, status: string, attempts: unknown[] = [], extra: Record<string, unknown> = {}) => ({ slot: n, wanted, backend, chain: [backend], status, attempts, ...extra });

async function appendManifestRound(dir: string, round: number, slots: unknown[], candidates: unknown[]): Promise<void> {
  const path = join(dir, "manifest.json");
  const manifest = await readJsonFile(path);
  (manifest["rounds"] as unknown[]).push({ round, policy: { preset: "image_first", label: "Qwen 2 张 + SVG 1 张" }, notes: [], slots, candidates });
  await writeFile(path, JSON.stringify(manifest));
}

describe("AvatarJobs：生成", () => {
  it("备好输入、开一条幕后会话（不进列表），候选位先按原则占位", async () => {
    const { ws, root } = await fixture();
    const h = harness(ws, root);
    const result = await h.jobs.generate({ workspaceId: "w1", bodyId: "rec", name: "聆箴" });
    assert.equal(result.ok, true);
    const job = (result as { ok: true; job: AvatarJob }).job;
    assert.equal(job.state, "preparing");
    assert.deepEqual(job.slots.map((each) => each.wanted), ["image_model", "image_model", "model_svg"]);
    assert.equal(job.policy, "Qwen 2 张 + SVG 1 张");
    assert.equal(h.metas[0]?.backstage, "avatar");
    const text = h.submitted[0]?.text ?? "";
    assert.match(text, /planet-render/);
    assert.match(text, /不要跑 preview、select、policy/);
    // 输入：盘上的 mix + 档案里的职能 + 按构成定的类别
    const dir = join(ws.path, "planet", "agents", "rec", "surfaces");
    const input = text.match(/--input "([^"]+)"/)?.[1] ?? "";
    assert.ok(input.startsWith(dir));
    const raw = await readJsonFile(input);
    assert.equal(raw["role"], "记忆系统调研");
    assert.equal(raw["bodyType"], "rock");
    assert.equal((raw["mix"] as { seed: number }).seed, 7);
    // 同一颗正在出图：拒绝第二次
    const again = await h.jobs.generate({ workspaceId: "w1", bodyId: "rec" });
    assert.equal(again.ok, false);
    await h.jobs.cancel({ workspaceId: "w1", bodyId: "rec" });
  });

  it("面板给的 mix 优先于盘上的；主星按 star 出图、候选放在 planet/surfaces/", async () => {
    const { ws, root } = await fixture();
    const h = harness(ws, root);
    const mix = { seed: 42, items: [{ id: "H", kind: "element", scope: "bulk", basis: "mass_fraction", share: 0.7, origin: "user" }] };
    await h.jobs.generate({ workspaceId: "w1", bodyId: "main", mix });
    const input = (h.submitted[0]?.text ?? "").match(/--input "([^"]+)"/)?.[1] ?? "";
    assert.ok(input.startsWith(join(ws.path, "planet", "surfaces")));
    const raw = await readJsonFile(input);
    assert.equal(raw["bodyType"], "star");
    assert.equal(raw["name"], "烛霓");
    assert.equal((raw["mix"] as { seed: number }).seed, 42);
    await h.jobs.cancel({ workspaceId: "w1", bodyId: "main" });
  });

  it("修改要求连同基础图与上一版提示词一起交给幕后会话；没有基础时作为附加要求", async () => {
    const { ws, root } = await fixture();
    const h = harness(ws, root);
    const dir = join(ws.path, "planet", "surfaces");
    await writeManifest(dir, [slot(1, "image_model", "image_model", "done")], [{ id: "r1-s1", slot: 1, backend: "image_model", file: "candidates/r1-s1-a1.png", prompt: "rust-red rocky globe, no face" }]);
    await writeFile(join(dir, "candidates", "r1-s1-a1.png"), "png");
    await h.jobs.generate({ workspaceId: "w1", bodyId: "main", instruction: "再暖一点，表面多些环形山", baseCandidateId: "r1-s1" });
    const text = h.submitted[0]?.text ?? "";
    assert.match(text, /再暖一点，表面多些环形山/);
    assert.match(text, /rust-red rocky globe, no face/);
    assert.ok(text.includes(join(dir, "candidates", "r1-s1-a1.png")));
    assert.match(text, /qwen_edit/);
    assert.match(text, /OOM、超时或不可用/);
    assert.match(text, /那份 SVG 上改/);
    const history = await readJsonFile(join(dir, "avatar-history.json"));
    const entries = history["entries"] as Record<string, unknown>[];
    assert.equal(entries[0]?.["instruction"], "再暖一点，表面多些环形山");
    assert.equal(entries[0]?.["baseCandidateId"], "r1-s1");
    assert.equal(entries[0]?.["plannedRound"], 2);
    await h.jobs.cancel({ workspaceId: "w1", bodyId: "main" });

    await h.jobs.generate({ workspaceId: "w1", bodyId: "main", instruction: "像木星那样有条带" });
    const fresh = h.submitted[1]?.text ?? "";
    assert.match(fresh, /像木星那样有条带/);
    assert.match(fresh, /没有指定基础候选/);
    assert.match(fresh, /附加条件/);
    await h.jobs.cancel({ workspaceId: "w1", bodyId: "main" });
  });

  it("聊天修改自动以当前地表为基础：账本候选带原提示词，老地表直接读文件与插件 surfaceLog", async () => {
    const { ws, root } = await fixture();
    const h = harness(ws, root);
    const dir = join(ws.path, "planet", "surfaces");
    await writeManifest(dir, [slot(1, "image_model", "image_model", "done")], [{ id: "r1-s1", slot: 1, backend: "image_model", file: "candidates/r1-s1-a1.png", prompt: "selected candidate prompt" }]);
    await writeFile(join(dir, "candidates", "r1-s1-a1.png"), "png");
    const galaxyPath = join(ws.path, "planet", "galaxy.json");
    const galaxy = await readJsonFile(galaxyPath);
    galaxy["main"] = { surface: "surfaces/candidates/r1-s1-a1.png", flip: false };
    await writeFile(galaxyPath, JSON.stringify(galaxy));
    await h.jobs.generate({ workspaceId: "w1", bodyId: "main", instruction: "再暖一点", useCurrentSurface: true });
    assert.match(h.submitted[0]?.text ?? "", /selected candidate prompt/);
    assert.ok((h.submitted[0]?.text ?? "").includes(join(dir, "candidates", "r1-s1-a1.png")));
    await h.jobs.cancel({ workspaceId: "w1", bodyId: "main" });

    galaxy["main"] = { surface: "legacy.svg", flip: false };
    await writeFile(galaxyPath, JSON.stringify(galaxy));
    await writeFile(join(ws.path, "planet", "legacy.svg"), "<svg/>");
    await writeFile(join(ws.path, "planet", "design.json"), JSON.stringify({ name: "烛霓", mass: { value: 60, unit: "M⊕" }, surfaceLog: { prompt: "legacy surface prompt" } }));
    await h.jobs.generate({ workspaceId: "w1", bodyId: "main", instruction: "加一圈云", useCurrentSurface: true });
    const legacy = h.submitted[1]?.text ?? "";
    assert.ok(legacy.includes(join(ws.path, "planet", "legacy.svg")));
    assert.match(legacy, /legacy surface prompt/);
    assert.match(legacy, /后端 model_svg/);
    await h.jobs.cancel({ workspaceId: "w1", bodyId: "main" });
  });

  it("没装插件、没有可用模型：不开会话，直接说原因", async () => {
    const { ws } = await fixture();
    const none = harness(ws, null);
    const a = await none.jobs.generate({ workspaceId: "w1", bodyId: "main" });
    assert.equal(a.ok, false);
    assert.match((a as { error: string }).error, /行星造物/);
    const { root } = await fixture();
    const noModel = harness(ws, root, { resolveModel: async () => ({ ok: false, error: "没有可用模型" }) });
    const b = await noModel.jobs.generate({ workspaceId: "w1", bodyId: "main" });
    assert.deepEqual(b, { ok: false, error: "没有可用模型" });
    assert.equal(noModel.metas.length, 0);
  });
});

/** 出图用的模型由面板解析后随请求带来（或主进程按设置兜底）：这里把真解析器接进任务表，验「发出去的这一轮用的是哪个模型」 */
function modelProvider(id: string, displayName: string, modelIds: string[], disabled = false): ProviderDto {
  return {
    id,
    displayName,
    disabled,
    endpoint: { baseUrl: "https://x.example", api: "anthropic-messages" },
    auth: { scheme: "api_key", hasSecret: true, masked: "abc…xyz" },
    models: { declared: modelIds.map((modelId) => ({ id: modelId })) },
  };
}

describe("AvatarJobs：这一轮用哪个模型", () => {
  const providers = [
    modelProvider("zhipu-coding", "智谱 Coding Plan", ["glm-5.4"]),
    modelProvider("kimi-coding", "Kimi Code", ["kimi-for-coding", "k3.1-pro"]),
  ];
  /** 用户正式版设置的那一段：子会话默认模型是 Kimi，会话栏用的是智谱 */
  const settings = {
    avatarModel: undefined,
    subSessionModel: { providerId: "kimi-coding", modelId: "kimi-for-coding" },
    lastUsed: { providerId: "zhipu-coding", modelId: "glm-5.4" },
  } as const;
  const withResolver =
    (choice: AvatarModelChoice | undefined = undefined, overrides: Partial<AvatarDeps> = {}): Partial<AvatarDeps> => ({
      resolveModel: async (request: AvatarGenerateRequest) =>
        resolveAvatarModel({
          requested: request.model,
          session: settings.lastUsed,
          settings: { avatarModel: choice, subSessionModel: settings.subSessionModel },
          providers,
        }),
      ...overrides,
    });

  it("请求里带的型号就是幕后会话用的型号：meta 与开轮是同一对 id，不被子会话默认模型压住", async () => {
    const { ws, root } = await fixture();
    const h = harness(ws, root, withResolver());
    const result = await h.jobs.generate({ workspaceId: "w1", bodyId: "main", model: { providerId: "kimi-coding", modelId: "k3.1-pro" } });
    assert.equal(result.ok, true);
    assert.equal(((result as { ok: true; job: AvatarJob }).job).model?.modelId, "k3.1-pro");
    assert.deepEqual(h.metas.map((meta) => [meta.providerId, meta.modelId]), [["kimi-coding", "k3.1-pro"]]);
    assert.deepEqual(h.submitted.map((input) => [input.providerId, input.modelId, input.thinkingLevel]), [["kimi-coding", "k3.1-pro", defaultThinkingLevel("k3.1-pro")]]);
    await h.jobs.cancel({ workspaceId: "w1", bodyId: "main" });
  });

  it("请求没带型号：主进程按设置兜底——没选过跟会话栏（lastUsed），选了「子会话模型」才用子会话默认模型", async () => {
    const { ws, root } = await fixture();
    const follow = harness(ws, root, withResolver());
    const a = await follow.jobs.generate({ workspaceId: "w1", bodyId: "main" });
    assert.equal(a.ok, true);
    assert.deepEqual(follow.submitted.map((input) => [input.providerId, input.modelId]), [["zhipu-coding", "glm-5.4"]]);
    await follow.jobs.cancel({ workspaceId: "w1", bodyId: "main" });

    const { ws: ws2, root: root2 } = await fixture();
    const sub = harness(ws2, root2, withResolver("sub_session"));
    const b = await sub.jobs.generate({ workspaceId: "w1", bodyId: "main" });
    assert.equal(b.ok, true);
    assert.deepEqual(sub.submitted.map((input) => [input.providerId, input.modelId]), [["kimi-coding", "kimi-for-coding"]]);
    await sub.jobs.cancel({ workspaceId: "w1", bodyId: "main" });
  });

  it("型号不可用（服务商被关 / 型号没了）：报错说清怎么办，不换成别家，也不开幕后会话", async () => {
    const { ws, root } = await fixture();
    const closed = harness(ws, root, withResolver(undefined));
    const a = await closed.jobs.generate({ workspaceId: "w1", bodyId: "main", model: { providerId: "zhipu-coding", modelId: "glm-5.3" } });
    assert.equal(a.ok, false);
    assert.match((a as { error: string }).error, /zhipu-coding\/glm-5\.3/);
    assert.equal(closed.metas.length, 0);
    assert.equal(closed.submitted.length, 0);
    // 没有活任务：同一颗可以接着再试
    const again = await closed.jobs.generate({ workspaceId: "w1", bodyId: "main", model: { providerId: "zhipu-coding", modelId: "glm-5.4" } });
    assert.equal(again.ok, true);
    await closed.jobs.cancel({ workspaceId: "w1", bodyId: "main" });
  });
});

describe("AvatarJobs：进度与收尾", () => {
  it("读插件账本推进度：收下的带小图、降级照实写；会话停了没交的位记失败，有候选就是 ready", async () => {
    const { ws, root } = await fixture();
    const h = harness(ws, root);
    await h.jobs.generate({ workspaceId: "w1", bodyId: "main" });
    const dir = join(ws.path, "planet", "surfaces");
    await writeManifest(
      dir,
      [
        slot(1, "image_model", "image_model", "done", [{ backend: "image_model", ok: true, reasons: [], tool: "mcp__qwen__qwen_generate" }]),
        slot(2, "image_model", "model_svg", "pending", [{ backend: "image_model", ok: false, reasons: ["Qwen 不在线"], unavailable: true }]),
        slot(3, "model_svg", "model_svg", "pending"),
      ],
      [{ id: "r1-s1", slot: 1, backend: "image_model", file: "candidates/r1-s1-a1.png" }],
    );
    await wait(40);
    const running = h.emitted[h.emitted.length - 1] as AvatarJob;
    assert.equal(running.state, "running");
    assert.equal(running.slots[0]?.state, "done");
    assert.equal(running.slots[0]?.image, "data:r1-s1-a1.png");
    assert.equal(running.slots[1]?.state, "working");
    assert.equal(running.slots[1]?.backend, "model_svg");
    assert.equal(running.slots[1]?.attempts[0]?.unavailable, true);
    h.jobs.onAgentEvent({ type: "phase", sessionId: "s1", phase: "idle" });
    await wait(20);
    const ended = h.emitted[h.emitted.length - 1] as AvatarJob;
    assert.equal(ended.state, "ready");
    assert.equal(ended.slots[2]?.state, "failed");
    assert.match(ended.slots[2]?.reason ?? "", /没交图/);
    // 有候选不标待出图
    assert.equal(h.scripts.length, 0);
  });

  it("一张都没出来：pending；原来没有地表且有插件稿 → 跑插件 select --pending；失败原因写插件原话", async () => {
    const { ws, root } = await fixture();
    const h = harness(ws, root);
    await h.jobs.generate({ workspaceId: "w1", bodyId: "main" });
    const dir = join(ws.path, "planet", "surfaces");
    await writeManifest(dir, [
      slot(1, "model_svg", "model_svg", "exhausted", [{ backend: "model_svg", ok: false, reasons: ["有 <text>"] }], { pendingReason: "有 <text>" }),
      slot(2, "model_svg", "model_svg", "exhausted", [{ backend: "model_svg", ok: false, reasons: ["嘴区有深色横条"] }]),
    ]);
    await wait(40);
    const done = h.emitted[h.emitted.length - 1] as AvatarJob;
    assert.equal(done.state, "pending");
    assert.equal(done.slots[0]?.reason, "有 <text>");
    assert.equal(done.slots[1]?.reason, "嘴区有深色横条");
    // 全部位都用完时 poll 就收尾了：主星原来没有地表、有插件稿 → 插件稿标「待出图」；之后会话停了也不再收尾第二次
    assert.deepEqual(h.scripts, [["select", "--dir", dir, "--pending", "--design", join(ws.path, "planet", "design.json")]]);
    h.jobs.onAgentEvent({ type: "phase", sessionId: "s1", phase: "idle" });
    await wait(10);
    assert.equal(h.scripts.length, 1);
  });

  it("超时：没交的位写超时、停掉会话；智能体没跑到 plan 就停 → failed", async () => {
    const { ws, root } = await fixture();
    const h = harness(ws, root, { timeoutMs: 20 });
    await h.jobs.generate({ workspaceId: "w1", bodyId: "main" });
    await wait(60);
    const last = h.emitted[h.emitted.length - 1] as AvatarJob;
    assert.equal(last.state, "failed");
    assert.match(last.error ?? "", /plan/);
    assert.match(last.slots[0]?.reason ?? "", /超时/);
  });
});

describe("AvatarJobs：停下", () => {
  it("用户在 plan 之前停下：不算出错（pending、没有 error），停掉幕后会话", async () => {
    const { ws, root } = await fixture();
    const h = harness(ws, root);
    await h.jobs.generate({ workspaceId: "w1", bodyId: "main" });
    const result = (await h.jobs.cancel({ workspaceId: "w1", bodyId: "main" })) as { ok: true; job: AvatarJob };
    assert.equal(result.job.state, "pending");
    assert.equal(result.job.error, null);
    assert.match(result.job.slots[0]?.reason ?? "", /停下/);
    assert.deepEqual(h.aborted, ["s1"]);
  });
});

describe("AvatarJobs：挑选与重建", () => {
  it("挑一张：galaxy.json 的 surface 指向候选（相对 planet/）、不翻转；有插件稿时跑插件 select", async () => {
    const { ws, root } = await fixture();
    const h = harness(ws, root);
    const dir = join(ws.path, "planet", "surfaces");
    await writeManifest(dir, [slot(1, "model_svg", "model_svg", "done")], [{ id: "r1-s1", slot: 1, backend: "model_svg", file: "candidates/r1-s1-a1.svg" }]);
    await writeFile(join(dir, "candidates", "r1-s1-a1.svg"), "<svg/>");
    const result = await h.jobs.select({ workspaceId: "w1", bodyId: "main", candidateId: "r1-s1" });
    assert.equal(result.ok, true);
    assert.equal((result as { ok: true; job: AvatarJob }).job.state, "selected");
    const galaxy = await readJsonFile(join(ws.path, "planet", "galaxy.json"));
    assert.deepEqual(galaxy["main"], { surface: "surfaces/candidates/r1-s1-a1.svg", flip: false });
    assert.deepEqual(h.scripts[0], ["select", "--dir", dir, "--pick", "r1-s1", "--design", join(ws.path, "planet", "design.json")]);
    // 重启后（新任务表）按账本重建：认得出选中的是哪张
    const fresh = harness(ws, root);
    const got = await fresh.jobs.get({ workspaceId: "w1", bodyId: "main" });
    const job = (got as { ok: true; job: AvatarJob }).job;
    assert.equal(job.state, "selected");
    assert.equal(job.selected, "r1-s1");
  });

  it("插件写稿没成就不改 galaxy.json；没有这张候选报错", async () => {
    const { ws, root } = await fixture();
    const h = harness(ws, root, { runScript: async () => ({ code: 2, stdout: JSON.stringify({ ok: false, message: "这张图现在过不了校验：圆外不透明" }), stderr: "" }) });
    const dir = join(ws.path, "planet", "surfaces");
    await writeManifest(dir, [slot(1, "model_svg", "model_svg", "done")], [{ id: "r1-s1", slot: 1, backend: "model_svg", file: "candidates/r1-s1-a1.svg" }]);
    await writeFile(join(dir, "candidates", "r1-s1-a1.svg"), "<svg/>");
    const bad = await h.jobs.select({ workspaceId: "w1", bodyId: "main", candidateId: "r1-s1" });
    assert.deepEqual(bad, { ok: false, error: "插件写设计稿没成：这张图现在过不了校验：圆外不透明" });
    assert.deepEqual((await readJsonFile(join(ws.path, "planet", "galaxy.json")))["main"], { flip: true });
    const missing = await h.jobs.select({ workspaceId: "w1", bodyId: "main", candidateId: "r9-s1" });
    assert.equal(missing.ok, false);
  });

  it("行星没有插件稿：只写 galaxy.json；重启后没出完的位记「上次没出完」", async () => {
    const { ws, root } = await fixture();
    const h = harness(ws, root);
    const dir = join(ws.path, "planet", "agents", "rec", "surfaces");
    await writeManifest(dir, [slot(1, "image_model", "image_model", "done"), slot(2, "model_svg", "model_svg", "pending")], [{ id: "r1-s1", slot: 1, backend: "image_model", file: "candidates/r1-s1-a1.png" }]);
    await writeFile(join(dir, "candidates", "r1-s1-a1.png"), "png");
    const got = (await h.jobs.get({ workspaceId: "w1", bodyId: "rec" })) as { ok: true; job: AvatarJob };
    assert.equal(got.job.state, "ready");
    assert.match(got.job.slots[1]?.reason ?? "", /上次没出完/);
    await h.jobs.select({ workspaceId: "w1", bodyId: "rec", candidateId: "r1-s1" });
    assert.deepEqual(h.scripts, []);
    const galaxy = await readJsonFile(join(ws.path, "planet", "galaxy.json"));
    const planet = (galaxy["planets"] as Record<string, unknown>[])[0];
    assert.equal(planet?.["surface"], "agents/rec/surfaces/candidates/r1-s1-a1.png");
    assert.equal(planet?.["orbit"], 19);
  });
});

describe("AvatarJobs：历史", () => {
  it("每一轮的要求和候选都能读回；选回旧图后重启仍认得出", async () => {
    const { ws, root } = await fixture();
    const h = harness(ws, root);
    const dir = join(ws.path, "planet", "surfaces");
    await h.jobs.generate({ workspaceId: "w1", bodyId: "main" });
    await writeManifest(dir, [slot(1, "image_model", "image_model", "done")], [{ id: "r1-s1", slot: 1, backend: "image_model", file: "candidates/r1-s1-a1.png", prompt: "old prompt" }]);
    await writeFile(join(dir, "candidates", "r1-s1-a1.png"), "one");
    await wait(40);
    assert.equal((await h.jobs.select({ workspaceId: "w1", bodyId: "main", candidateId: "r1-s1" })).ok, true);
    const justSelected = await h.jobs.get({ workspaceId: "w1", bodyId: "main" });
    assert.equal(justSelected.ok && justSelected.job?.state, "selected");
    assert.equal(justSelected.ok && justSelected.job?.selected, "r1-s1");

    await h.jobs.generate({ workspaceId: "w1", bodyId: "main", instruction: "再暖一点", baseCandidateId: "r1-s1" });
    const pending = await h.jobs.history({ workspaceId: "w1", bodyId: "main" });
    assert.equal(pending.ok, true);
    if (pending.ok) {
      assert.equal(pending.history.entries.length, 2);
      assert.equal(pending.history.entries[1]?.round, null);
      assert.equal(pending.history.entries[1]?.instruction, "再暖一点");
    }
    await appendManifestRound(dir, 2, [slot(1, "image_model", "image_model", "done")], [{ id: "r2-s1", slot: 1, backend: "image_model", file: "candidates/r2-s1-a1.png", prompt: "old prompt, warmer" }]);
    await writeFile(join(dir, "candidates", "r2-s1-a1.png"), "two");
    await wait(40);
    const ready = await h.jobs.history({ workspaceId: "w1", bodyId: "main" });
    assert.equal(ready.ok, true);
    if (ready.ok) {
      assert.equal(ready.history.entries[1]?.round, 2);
      assert.equal(ready.history.entries[1]?.candidates[0]?.candidateId, "r2-s1");
      assert.equal(ready.history.entries[1]?.candidates[0]?.image, "data:r2-s1-a1.png");
      assert.equal(ready.history.entries[1]?.baseCandidateId, "r1-s1");
    }

    // 选回第一轮，而不是刚出的第二轮；历史与重启后的当前任务都按 galaxy.json 的 surface 认出旧图
    assert.equal((await h.jobs.select({ workspaceId: "w1", bodyId: "main", candidateId: "r1-s1" })).ok, true);
    const reverted = await h.jobs.history({ workspaceId: "w1", bodyId: "main" });
    assert.equal(reverted.ok && reverted.history.selected, "r1-s1");
    const fresh = harness(ws, root);
    const current = await fresh.jobs.get({ workspaceId: "w1", bodyId: "main" });
    assert.equal(current.ok && current.job?.selected, "r1-s1");
    const restored = await fresh.jobs.history({ workspaceId: "w1", bodyId: "main" });
    assert.equal(restored.ok && restored.history.selected, "r1-s1");
    assert.equal(restored.ok && restored.history.entries.length, 2);
  });
});

describe("账本与原则的读法", () => {
  it("坏条目丢掉不抛；原则读不到按插件默认（2 张 SVG）", () => {
    assert.deepEqual(parseManifest(null), []);
    assert.deepEqual(parseManifest({ rounds: [{ round: 1, slots: [{ slot: 1, backend: "laser" }], candidates: [{ id: 3 }] }] })[0]?.slots, []);
    assert.deepEqual(policySlots(undefined).slots.map((each) => each.wanted), ["model_svg", "model_svg"]);
    assert.equal(policySlots({ candidates: ["image_model", "x", "model_svg"] }).slots.length, 2);
  });
});

describe("聊天里建子智能体", () => {
  it("没带地表图：建完开一组形象候选（面板同一套），工具回话叫主智能体别自己出图", async () => {
    const { ws } = await fixture();
    const started: string[] = [];
    const outcome = await applySubAgentRequest(
      {
        sessions: { readMeta: async () => ({ id: "c", parentId: undefined, workspaceId: "w1" }) as unknown as SessionMeta },
        workspaces: { list: async () => [ws] },
        settings: { read: async () => ({ ...DEFAULT_SETTINGS, appMode: "orchestrate" }) },
        store: new SubAgentStore({ newId: () => "agent-x" }),
        broadcast: () => undefined,
        startAvatar: async (workspaceId, bodyId) => {
          started.push(`${workspaceId}/${bodyId}`);
          return { ok: true };
        },
      },
      { type: "subAgentRequest", requestId: "r", sessionId: "c", request: { action: "create", input: { name: "衡璨", role: "评测" } } },
    );
    assert.equal(outcome.ok, true);
    assert.deepEqual(started, ["w1/agent-x"]);
    assert.match((outcome as { text: string }).text, /do not generate or set an avatar image yourself/);
  });

  it("聊天里说『再暖一点』：要求进同一出图流程，广播 avatar 让面板弹到这颗行星", async () => {
    const { ws } = await fixture();
    const started: string[] = [];
    const changes: Record<string, unknown>[] = [];
    const outcome = await applySubAgentRequest(
      {
        sessions: { readMeta: async () => ({ id: "c", parentId: undefined, workspaceId: "w1" }) as unknown as SessionMeta },
        workspaces: { list: async () => [ws] },
        settings: { read: async () => ({ ...DEFAULT_SETTINGS, appMode: "orchestrate" }) },
        store: new SubAgentStore({ newId: () => "agent-x" }),
        broadcast: (event) => void changes.push({ ...event }),
        startAvatar: async (workspaceId, bodyId, instruction) => {
          started.push(`${workspaceId}/${bodyId}/${instruction ?? ""}`);
          return { ok: true };
        },
      },
      { type: "subAgentRequest", requestId: "r", sessionId: "c", request: { action: "reviseAvatar", input: { id: "rec", instruction: "再暖一点" } } },
    );
    assert.equal(outcome.ok, true);
    assert.deepEqual(started, ["w1/rec/再暖一点"]);
    assert.deepEqual(changes, [{ workspaceId: "w1", subAgentId: "rec", action: "avatar", source: "chat", sessionId: "c" }]);
    assert.match((outcome as { text: string }).text, /Galaxy Design panel/);
    assert.match((outcome as { text: string }).text, /Do not generate, choose or set/);
  });
});

/**
 * 「用生图工具」开关：真源是插件「行星造物」的策略文件 data/render-policy.json，读写都经它的脚本
 * `render_surface.py policy`。这里的假脚本照真脚本的行为演（读：文件没有按默认回 decided=false、文件坏了回 ok:false；
 * --set：整个文件重建，只认 --prefer / --note 这两个带得回去的字段——avoid 与 maxAttempts 被它抹掉，应用侧要补回）。
 */
const FAKE_PRESETS: Record<string, string[]> = {
  svg: ["model_svg", "model_svg"],
  image_first: ["image_model", "image_model", "model_svg"],
  image_only: ["image_model", "image_model"],
  ask: ["model_svg", "model_svg"],
};
const FAKE_MAX_ATTEMPTS = { model_svg: 3, image_model: 2, user_image: 1 };

function fakePolicyScript(root: string): {
  run: (args: readonly string[]) => Promise<ScriptResult>;
  calls: string[][];
} {
  const file = join(root, "data", "render-policy.json");
  const calls: string[][] = [];
  /** 照真脚本的 read_json：文件不存在 → 默认（decided=false）；不是 JSON / 预设不认识 → ok:false 配退出码 2 */
  const read = async (): Promise<string | undefined> => readFile(file, "utf8").catch(() => undefined);
  const write = async (data: Record<string, unknown>): Promise<void> => writeFile(file, JSON.stringify(data));
  return {
    calls,
    run: async (args): Promise<ScriptResult> => {
      calls.push([...args]);
      if (args[0] !== "policy") return { code: 0, stdout: "{}", stderr: "" };
      const flag = (name: string): string | undefined => {
        const at = args.indexOf(name);
        return at === -1 ? undefined : args[at + 1];
      };
      const set = flag("--set");
      if (set !== undefined) {
        const prefer = (flag("--prefer") ?? "").split(",").filter((each) => each !== "");
        const policy = {
          version: 1,
          preset: set,
          label: `假脚本：${set}`,
          candidates: FAKE_PRESETS[set] ?? [],
          imageModel: { prefer, avoid: [] },
          maxAttempts: FAKE_MAX_ATTEMPTS,
          decidedBy: "user",
          decidedAt: "2026-11-25T23:00:00+08:00",
          note: flag("--note") ?? "",
        };
        await mkdir(join(root, "data"), { recursive: true });
        await write(policy);
        return { code: 0, stdout: JSON.stringify({ ok: true, path: file, policy }), stderr: "" };
      }
      const text = await read();
      if (text === undefined) {
        const policy = { version: 1, preset: "svg", label: "只让智能体画 SVG", candidates: FAKE_PRESETS["svg"], imageModel: { prefer: [], avoid: [] }, maxAttempts: FAKE_MAX_ATTEMPTS, decidedBy: "default", decidedAt: null, note: "用户还没选，按默认", decided: false };
        return { code: 0, stdout: JSON.stringify({ ok: true, path: file, policy }), stderr: "" };
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return { code: 2, stdout: JSON.stringify({ ok: false, message: "render-policy.json 不是合法 JSON：Expecting value" }), stderr: "" };
      }
      if (typeof (raw as { preset?: unknown })?.preset !== "string" || !((raw as { preset: string }).preset in FAKE_PRESETS)) {
        return { code: 2, stdout: JSON.stringify({ ok: false, message: "render-policy.json 格式不对：preset 缺失或不认识" }), stderr: "" };
      }
      return { code: 0, stdout: JSON.stringify({ ok: true, path: file, policy: { ...(raw as object), decided: true } }), stderr: "" };
    },
  };
}

/** 一份带满字段的用户策略（prefer / avoid / 重画上限 / 备注都有），用来验「拨开关不清掉别的字段」 */
async function writeUserPolicy(root: string, preset = "svg"): Promise<string> {
  const file = join(root, "data", "render-policy.json");
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      preset,
      label: "用户自己的原则",
      candidates: FAKE_PRESETS[preset],
      imageModel: { prefer: ["qwen"], avoid: ["dall"] },
      maxAttempts: { model_svg: 5, image_model: 1, user_image: 1 },
      decidedBy: "user",
      decidedAt: "2026-11-24T21:12:09+08:00",
      note: "用户 2026-11-24：先按建议用",
    }),
  );
  return file;
}

describe("AvatarJobs：「用生图工具」开关", () => {
  const policyHarness = (
    ws: Workspace,
    root: string | null,
    script: { run: (args: readonly string[]) => Promise<ScriptResult>; calls: string[][] } = { run: async () => ({ code: 0, stdout: "{}", stderr: "" }), calls: [] },
  ) =>
    harness(ws, root, {
      resolveModel: async () => ({ ok: true, providerId: "kimi", modelId: "k3", thinkingLevel: "medium" }),
      runScript: (_root, args): Promise<ScriptResult> => (args[0] === "policy" ? script.run(args) : Promise.resolve({ code: 0, stdout: "{}", stderr: "" })),
    });

  it("插件没装：开关读不了，原因照实回给面板", async () => {
    const { ws } = await fixture();
    const h = policyHarness(ws, null);
    const result = await h.jobs.renderPolicy();
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /行星造物/);
  });

  it("读：策略文件还没有 = 关、未决定；image_first 与 image_only = 开；svg = 关", async () => {
    const { ws, root } = await fixture();
    const script = fakePolicyScript(root as string);
    const file = join(root as string, "data", "render-policy.json");
    await writeFile(file, JSON.stringify({ label: "没有预设", candidates: ["model_svg"] }));
    const h = policyHarness(ws, root, script);

    const fresh = await h.jobs.renderPolicy();
    assert.deepEqual(fresh, { ok: true, policy: { mode: "hand_drawn", preset: null, label: null, note: null, candidates: [], decided: true, problem: "render-policy.json 格式不对：preset 缺失或不认识" } });

    await rm(file);
    const none = await h.jobs.renderPolicy();
    assert.equal(none.ok && none.policy.mode, "hand_drawn");
    assert.equal(none.ok && none.policy.decided, false);
    assert.equal(none.ok && none.policy.preset, "svg");

    await writeUserPolicy(root as string, "image_first");
    const first = await h.jobs.renderPolicy();
    assert.equal(first.ok && first.policy.mode, "image_tool");
    assert.equal(first.ok && first.policy.preset, "image_first");

    await writeUserPolicy(root as string, "svg");
    const off = await h.jobs.renderPolicy();
    assert.equal(off.ok && off.policy.mode, "hand_drawn");
    assert.equal(off.ok && off.policy.decided, true);
  });

  it("脚本的输出不是 JSON（依赖没装、traceback）：回一句原因，不抛", async () => {
    const { ws, root } = await fixture();
    const h = policyHarness(ws, root, { run: async () => ({ code: 1, stdout: "", stderr: "Traceback (most recent call last): ModuleNotFoundError: No module named 'PIL'" }), calls: [] });
    const result = await h.jobs.renderPolicy();
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /出图脚本|脚本/);
  });

  it("拨到「用生图工具」：经脚本写成 image_only；文件里原有的 prefer / avoid / 重画上限 / 备注一个不清掉", async () => {
    const { ws, root } = await fixture();
    const file = await writeUserPolicy(root as string, "svg");
    const script = fakePolicyScript(root as string);
    const h = policyHarness(ws, root, script);
    const result = await h.jobs.setRenderPolicy({ mode: "image_tool" });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.policy.mode, "image_tool");
    assert.equal(result.ok && result.policy.preset, "image_only");
    // 调的是脚本的 policy --set，带上原来的 prefer 与备注
    const write = script.calls.find((args) => args.includes("--set"));
    assert.ok(write);
    assert.equal(write?.[0], "policy");
    assert.equal(write?.[1], "--set");
    assert.equal(write?.[2], "image_only");
    assert.equal(write?.[3], "--prefer");
    assert.equal(write?.[4], "qwen");
    const onDisk = await readJsonFile(file);
    assert.equal(onDisk["preset"], "image_only");
    assert.deepEqual(onDisk["imageModel"], { prefer: ["qwen"], avoid: ["dall"] });
    assert.deepEqual(onDisk["maxAttempts"], { model_svg: 5, image_model: 1, user_image: 1 });
    assert.equal(onDisk["decidedBy"], "user");
    assert.match(String(onDisk["note"]), /^用户 2026-11-24：先按建议用/);
    assert.match(String(onDisk["note"]), /image_only/);
    // 来回拨：面板的记录不叠加，用户的备注一直在
    await h.jobs.setRenderPolicy({ mode: "hand_drawn" });
    const back = await h.jobs.setRenderPolicy({ mode: "image_tool" });
    assert.equal(back.ok && back.policy.mode, "image_tool");
    const note = String((await readJsonFile(file))["note"]);
    assert.equal(note.match(/在 Orbita 的星系设计面板里/g)?.length, 1);
    assert.match(note, /^用户 2026-11-24：先按建议用/);
  });

  it("策略文件是坏的：照样能拨——拨开关就是把它重写成合法文件的那条路", async () => {
    const { ws, root } = await fixture();
    const file = join(root as string, "data", "render-policy.json");
    await writeFile(file, "{ 这不是 JSON");
    const script = fakePolicyScript(root as string);
    const h = policyHarness(ws, root, script);
    const result = await h.jobs.setRenderPolicy({ mode: "image_tool" });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.policy.mode, "image_tool");
    assert.equal((await readJsonFile(file))["preset"], "image_only");
  });

  it("拨回手绘：写成 svg", async () => {
    const { ws, root } = await fixture();
    await writeUserPolicy(root as string, "image_only");
    const script = fakePolicyScript(root as string);
    const h = policyHarness(ws, root, script);
    const result = await h.jobs.setRenderPolicy({ mode: "hand_drawn" });
    assert.equal(result.ok && result.policy.mode, "hand_drawn");
    assert.equal(script.calls.find((args) => args.includes("--set"))?.[2], "svg");
  });

  it("脚本不肯写（原则文件目录只读、脚本自己报错）：回失败与脚本的原话，用户的文件一个字不动", async () => {
    const { ws, root } = await fixture();
    const file = await writeUserPolicy(root as string, "svg");
    const before = await readFile(file, "utf8");
    const h = policyHarness(ws, root, {
      run: async (): Promise<ScriptResult> => ({ code: 2, stdout: JSON.stringify({ ok: false, message: "原则只能是 svg / image_first" }), stderr: "" }),
      calls: [],
    });
    const result = await h.jobs.setRenderPolicy({ mode: "image_tool" });
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /原则只能是/);
    assert.equal(await readFile(file, "utf8"), before);
  });

  it("第一次出图时策略文件还没有：先按面板的默认（手绘）把它落成已决定，再开幕后会话——不让智能体在幕后会话里问「用哪种出图方式」", async () => {
    const { ws, root } = await fixture();
    const file = join(root as string, "data", "render-policy.json");
    await writeFile(file, JSON.stringify({ label: "没有预设", candidates: ["model_svg"] }));
    await rm(file);
    const script = fakePolicyScript(root as string);
    const h = harness(ws, root, {
      resolveModel: async () => ({ ok: true, providerId: "kimi", modelId: "k3", thinkingLevel: "medium" }),
      runScript: (_root, args): Promise<ScriptResult> => (args[0] === "policy" ? script.run(args) : Promise.resolve({ code: 0, stdout: "{}", stderr: "" })),
      submitTurn: async (input) => void h.submitted.push(input),
    });
    const result = await h.jobs.generate({ workspaceId: "w1", bodyId: "main" });
    assert.equal(result.ok, true);
    const order = script.calls.map((args) => args.slice(0, 2).join(" "));
    assert.deepEqual(order, ["policy", "policy --set"]);
    const write = script.calls[1] ?? [];
    assert.equal(write[2], "svg");
    assert.match(write.join(" "), /面板/);
    const onDisk = await readJsonFile(file);
    assert.equal(onDisk["preset"], "svg");
    assert.equal(onDisk["decidedBy"], "user");
    assert.equal(h.submitted.length, 1);
    // 幕后会话拿到的提示词里仍然写明不问出图方式
    assert.match(h.submitted[0]?.text ?? "", /needsPolicyChoice 为 true 也不要问/);
    // 已经定了：再出一组只读一次、不重写用户的原则
    await h.jobs.cancel({ workspaceId: "w1", bodyId: "main" });
    script.calls.length = 0;
    await h.jobs.generate({ workspaceId: "w1", bodyId: "main" });
    assert.deepEqual(script.calls, [["policy"]]);
    await h.jobs.cancel({ workspaceId: "w1", bodyId: "main" });
  });

  it("策略文件已经定了（哪怕是手绘之外的档）：出图不碰它；文件坏了也不拦出图、不去改它", async () => {
    const { ws, root } = await fixture();
    const script = fakePolicyScript(root as string);
    const decided = harness(ws, root, {
      resolveModel: async () => ({ ok: true, providerId: "kimi", modelId: "k3", thinkingLevel: "medium" }),
      runScript: (_root, args): Promise<ScriptResult> => (args[0] === "policy" ? script.run(args) : Promise.resolve({ code: 0, stdout: "{}", stderr: "" })),
      submitTurn: async () => undefined,
    });
    await writeUserPolicy(root as string, "image_only");
    const a = await decided.jobs.generate({ workspaceId: "w1", bodyId: "main" });
    assert.equal(a.ok, true);
    assert.deepEqual(script.calls.map((args) => args[0]), ["policy"]);
    await decided.jobs.cancel({ workspaceId: "w1", bodyId: "main" });

    const file = join(root as string, "data", "render-policy.json");
    await writeFile(file, "{ 这不是 JSON");
    script.calls.length = 0;
    const b = await decided.jobs.generate({ workspaceId: "w1", bodyId: "main" });
    assert.equal(b.ok, true);
    assert.deepEqual(script.calls.map((args) => args[0]), ["policy"]);
    assert.equal(await readFile(file, "utf8"), "{ 这不是 JSON");
    await decided.jobs.cancel({ workspaceId: "w1", bodyId: "main" });
  });
});
