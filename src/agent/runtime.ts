/**
 * agent runtime —— 跑在 Electron utility 进程里的「家务进程」。
 *
 * **它不跑轮**：对话主循环（开轮 / 停止 / 抢跑 / 压缩 / 插话 / 切档 / 审批 / 工具请求）在 kernel 进程
 * （kernel-runtime.ts，pi-durable）。旧内核的主循环与运行时装配已删（2026-11-16）；这里只剩不属于任何一轮的几件事：
 * - 内建型号目录（listBuiltins）与联网刷新（refreshCatalogs）；
 * - 还没迁进库的旧会话的 pi 本子编辑与分支（branch / revertPiBook / undoPiBook / movePiBook，pi-book-edit.ts）——
 *   它们下一次开轮时由 kernel 按编辑后的本子迁；
 * - 没交给过 kernel 的会话换模型时的注册与校验（setModel：报 model 事件，主进程的 recorder 据此落 meta）；
 * - MCP 热重载的回执（mcpReload）；
 * - 专注小结、连接测试、收尾清单三种独立小调用（completeSimple）。
 * 这几件里有的还用着 pi-coding-agent（SessionManager、ModelRuntime）；两个进程合一留到去掉这个依赖的那一步。
 *
 * 为什么单独一个进程：这些活与 UI 抢事件循环（目录 JSON、本子解析）；崩了不带走窗口。**不碰 UI，不碰持久化路径策略。**
 */
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentEvent, AgentHouseholdCommand } from "../shared/agent-ipc.ts";
import { registerAndResolveModel, toBuiltinProvider } from "./model-registration.ts";
import { CATALOG_REFRESH_EVERY_MS, CatalogRefresher, createModelRuntime, refreshCatalogs } from "./model-catalog.ts";
import { fetchTokenrhythmCatalog, tokenrhythmCachePath } from "./tokenrhythm-catalog.ts";
import { ccBillingPatch } from "./cc-billing-patch.ts";
import { FOCUS_SUMMARY_SYSTEM_PROMPT, parseSummaryReply } from "./focus-summary.ts";
import { planBranchCut } from "./branch-cut.ts";
import { withOpencodeSession } from "./opencode-session.ts";
import { movePiBook, revertPiBook, undoPiBook } from "./pi-book-edit.ts";
import { preferIPv4 } from "../shared/dial-v4.ts";

// pi-ai 的模型调用与 main 同一个坑（同一台机器、同一个全局 fetch）
preferIPv4();

type ParentPortLike = {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
  start?(): void;
};

const parentPort = (process as typeof process & { parentPort?: ParentPortLike }).parentPort;
if (!parentPort) {
  console.error("[agent-runtime] 没有 parentPort——本文件只能作为 Electron utility 进程运行");
  process.exit(1);
}

function send(event: AgentEvent): void {
  parentPort?.postMessage(event);
}

/** 专注收工小结的硬上限（主进程那头 220 秒兑底，这里先放手）：素材比标题请求大得多 */
const FOCUS_SUMMARY_TIMEOUT_MS = 180_000;

/**
 * 专注模式的收工小结（focus-summary.ts）：一次独立的 `completeSimple`，模型与密钥面
 * 由主进程装好（家务活模型，缺席时主进程已回退到上次使用的模型）。结果经
 * `focusSummarized` 回执；模型解不出、调用出错、回复读不懂都回 null 并带原因——
 * 界面上等着这张卡，失败要说出来。每条失败路径都在这里落一条 warn（requestId /
 * 模型 / 原因），否则卡上只有一句笼统的话，事后无法归因。
 */
async function summarizeFocus(command: Extract<AgentHouseholdCommand, { type: "summarizeFocus" }>): Promise<void> {
  const fail = (reason: string): void => {
    console.warn(
      `[focus-summary] ${command.requestId} 失败（${command.provider.id}/${command.modelId}）：${reason}`,
    );
    send({ type: "focusSummarized", requestId: command.requestId, bullets: null, error: reason });
  };
  try {
    const runtime = await createModelRuntime();
    const model = registerAndResolveModel(runtime, command.provider, command.modelId);
    if (model === undefined) {
      fail(`unknown model "${command.provider.id}/${command.modelId}"`);
      return;
    }
    const response = await completeSimple(
      model,
      {
        systemPrompt: FOCUS_SUMMARY_SYSTEM_PROMPT,
        messages: [{ role: "user", content: command.prompt, timestamp: Date.now() }],
      },
      {
        apiKey: command.provider.apiKey,
        maxTokens: 2048,
        timeoutMs: FOCUS_SUMMARY_TIMEOUT_MS,
        signal: AbortSignal.timeout(FOCUS_SUMMARY_TIMEOUT_MS),
        onPayload: ccBillingPatch,
        ...(command.provider.headers ? { headers: command.provider.headers } : {}),
      },
    );
    if (response.stopReason === "error") {
      fail(response.errorMessage ?? `${model.id} returned an error`);
      return;
    }
    let output = "";
    for (const block of response.content) {
      if (block.type === "text") output += block.text;
    }
    const bullets = parseSummaryReply(output);
    if (bullets === null) {
      // 原文单独打一条（fail 那条只说“读不懂”，不给原文）；成功路径一条不落
      console.warn(`[focus-summary] ${model.id} 的回复读不懂，原文前 200 字：${JSON.stringify(output.slice(0, 200))}`);
      fail(`${model.id}'s reply couldn't be read`);
      return;
    }
    send({ type: "focusSummarized", requestId: command.requestId, bullets });
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
  }
}

/** 家务活小调用的硬上限（主进程那头 150 秒兜底，这里先放手） */
const CHORE_TIMEOUT_MS = 120_000;

/**
 * 家务活模型的一次独立小调用（收尾清单按用户反馈改写）：system + prompt 由主进程组好，
 * 这里只调模型、把回复的 text 块拼起来交回去——**不解析**：解析规则与 prompt 是同一份契约，
 * 都在 shared/wrapup-scan.ts，主进程收到原文后解析。失败回 null 带原因。
 */
async function choreComplete(command: Extract<AgentHouseholdCommand, { type: "choreComplete" }>): Promise<void> {
  const fail = (error: string): void => {
    send({ type: "choreCompleted", requestId: command.requestId, text: null, error });
  };
  try {
    const runtime = await createModelRuntime();
    const model = registerAndResolveModel(runtime, command.provider, command.modelId);
    if (model === undefined) {
      fail(`unknown model "${command.provider.id}/${command.modelId}"`);
      return;
    }
    const response = await completeSimple(
      model,
      {
        systemPrompt: command.system,
        messages: [{ role: "user", content: command.prompt, timestamp: Date.now() }],
      },
      {
        apiKey: command.provider.apiKey,
        maxTokens: 8192,
        timeoutMs: CHORE_TIMEOUT_MS,
        signal: AbortSignal.timeout(CHORE_TIMEOUT_MS),
        onPayload: ccBillingPatch,
        ...(command.provider.headers ? { headers: command.provider.headers } : {}),
      },
    );
    if (response.stopReason === "error") {
      fail(response.errorMessage ?? `${model.id} returned an error`);
      return;
    }
    let output = "";
    for (const block of response.content) {
      if (block.type === "text") output += block.text;
    }
    send({ type: "choreCompleted", requestId: command.requestId, text: output });
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
  }
}

/** 探测的硬上限（主进程那头 60 秒兑底，这里先放手） */
const PROBE_TIMEOUT_MS = 45_000;

/**
 * 连接探测（Test 的 OAuth 路由）：一次独立的 `completeSimple`——与真会话同一个
 * pi 客户端（官方 SDK + 全套身份头），这是它存在的全部理由：主进程裸 fetch
 * 的探测已被上游分类为非 Claude Code 流量而 429。模型没选时用声明清单第一个。
 * 任何非 error 的响应（含 max_tokens 到顶）都算连通——凭据过了、模型应了。
 */
async function probeProvider(command: Extract<AgentHouseholdCommand, { type: "probeProvider" }>): Promise<void> {
  const reply = (ok: boolean, message: string): void => {
    send({ type: "providerProbed", requestId: command.requestId, ok, message });
  };
  try {
    const runtime = await createModelRuntime();
    const model = registerAndResolveModel(runtime, command.provider, command.modelId);
    if (model === undefined) {
      reply(false, `unknown model "${command.provider.id}/${command.modelId}"`);
      return;
    }
    const response = await completeSimple(
      model,
      { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
      {
        apiKey: command.provider.apiKey,
        // 64 是硬上限不是目标：够模型吐一个字；思考型烧光了也是 max_tokens 而非 error，仍算连通
        maxTokens: 64,
        timeoutMs: PROBE_TIMEOUT_MS,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        // 探测的使命就是复刻真会话的 Claude Code 形状：OAuth 车道上同样要带上
        // billing header、去掉身份块，否则 opus-5-5 这类新模型会以
        // claude_code_version_too_old 拒绝探测，而真会话其实是通的
        onPayload: ccBillingPatch,
        ...(command.provider.headers ? { headers: command.provider.headers } : {}),
      },
    );
    if (response.stopReason === "error") {
      reply(false, response.errorMessage ?? `${model.id} returned an error`);
      return;
    }
    reply(true, `Connected — ${model.id} responded.`);
  } catch (cause) {
    reply(false, cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * 会话内换模型（C-4），**这次运行里没交给过 kernel 的会话**（空闲的旧会话）：自建一次性 ModelRuntime 做
 * 与开轮同一套「注册 + 解析」校验——「能不能用某个模型」必须是一套真相。成功只发 `model` 事件
 * （主进程的 recorder 落 meta，下一轮按 meta 装配）；失败发 `failed`（红字报给用户，chip 与 meta 都不动）。
 * 交给过 kernel 的会话由 kernel 自己校验（kernel-session.ts）。
 */
async function validateModel(command: Extract<AgentHouseholdCommand, { type: "setModel" }>): Promise<void> {
  try {
    // 同一套会话头注入（OpenCode Go），与开轮一致
    const scoped = withOpencodeSession(command.provider, command.sessionId);
    const runtime = await createModelRuntime();
    const model = registerAndResolveModel(runtime, scoped, command.modelId);
    if (model === undefined) {
      throw new Error(`unknown model "${scoped.id}/${command.modelId}"`);
    }
    send({ type: "model", sessionId: command.sessionId, providerId: model.provider, modelId: model.id });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    send({ type: "failed", sessionId: command.sessionId, message });
  }
}

/**
 * pi 侧分支（C-2），源是还没迁进库的旧会话：开一个**一次性的** SessionManager 读源本子，对账后用 pi 自己的
 * `createBranchedSession` 裁新文件。绝不碰活着的 manager——那个方法会把实例原地换绑到新文件上。
 * 对账输入是 **getBranch()（当前叶子路径）**：会话回退会在本子里留废枝，文件序（getEntries）会把废枝也数进来，
 * 从第一次回退起对账必然错位。
 */
function branchPiSession(command: Extract<AgentHouseholdCommand, { type: "branch" }>): void {
  const manager = SessionManager.open(command.sourcePiSessionFile, undefined, command.cwd);
  const targetId = planBranchCut(manager.getBranch(), command.roles);
  const branchFile = manager.createBranchedSession(targetId);
  if (branchFile === undefined) throw new Error("pi produced no branch file");
  // 复用 created 事件通路：主进程对 branch 与开机用同一条等待逻辑
  send({ type: "created", sessionId: command.sessionId, piSessionFile: branchFile });
}

/**
 * pi 内建 provider 目录 → 我们的 BuiltinProvider。读的是内建快照 + 本地缓存的 pi.dev 覆盖层，
 * 不联网、不读用户的 ~/.pi/agent（createModelRuntime）。
 */
async function listBuiltins(): Promise<void> {
  const runtime = await createModelRuntime();
  // 映射跟注册时的跨目录推断共用一份（toBuiltinProvider）：设置页看到的目录快照
  // 必须与 agent 借参数时用的是同一份，否则两边会对同一个模型说出两个窗口。
  send({ type: "builtins", providers: runtime.getProviders().map(toBuiltinProvider) });
}

async function handle(command: AgentHouseholdCommand): Promise<void> {
  if (command.type === "listBuiltins") {
    await listBuiltins();
    return;
  }
  if (command.type === "refreshCatalogs") {
    await catalogRefresher.request(command.scope, command.catalogIds);
    return;
  }
  // 分支带的是「新会话的 id」——不依赖任何表，直接裁文件
  if (command.type === "branch") {
    branchPiSession(command);
    return;
  }
  // 回退 / 撤销 / 挪工作区的 pi 侧一刀（详见 pi-book-edit.ts）：同步文件操作，完成经 piBookEdited 回执。
  // 「会话不在跑」由主进程保证：在跑的轮一定在 kernel 里，会话已记上 durable，本子编辑交给 kernel 而不是这里
  if (command.type === "revertPiBook") {
    revertPiBook(SessionManager.open(command.sourcePiSessionFile, undefined, command.cwd), command.roles, { targetMessageId: command.targetMessageId });
    send({ type: "piBookEdited", sessionId: command.sessionId, edit: "revert" });
    return;
  }
  if (command.type === "undoPiBook") {
    undoPiBook(SessionManager.open(command.sourcePiSessionFile, undefined, command.cwd), command.notice);
    send({ type: "piBookEdited", sessionId: command.sessionId, edit: "undo" });
    return;
  }
  if (command.type === "movePiBook") {
    movePiBook(SessionManager.open(command.sourcePiSessionFile, undefined, command.cwd), command.notice);
    send({ type: "piBookEdited", sessionId: command.sessionId, edit: "move" });
    return;
  }
  if (command.type === "setModel") {
    // fire-and-forget：成功经 `model` 事件、失败经 `failed` 事件回传
    void validateModel(command);
    return;
  }
  if (command.type === "mcpReload") {
    // 这个进程不跑轮、没有 MCP 连接（连接在 kernel 进程，它收到同一条 mcpReload 自己重建并报快照）：
    // 回执是一份空快照——与删主循环之前这里那个从没连过的 hub 报的 describe() 逐字节相同
    send({ type: "mcp", servers: [] });
    return;
  }
  if (command.type === "summarizeFocus") {
    // 不 await：独立小调用（可能到分钟量级），不挡后续命令
    void summarizeFocus(command);
    return;
  }
  if (command.type === "probeProvider") {
    // 同上：独立小调用，不挡后续命令
    void probeProvider(command);
    return;
  }
  if (command.type === "choreComplete") {
    // 同上：独立小调用，不挡后续命令
    void choreComplete(command);
    return;
  }
  // 穷尽性检查：AgentHouseholdCommand 加了新分支而这里没接，编译期就报
  command satisfies never;
}

/** 单次联网刷新的总时限：pi.dev 慢或连不上时，后台这一趟最多挂这么久 */
const CATALOG_REFRESH_TIMEOUT_MS = 60_000;

/**
 * 目录联网刷新：向 pi.dev 拉覆盖层、向基元律动拉它自家的目录，拉完重报一次目录（主进程缓存的是
 * 最后一份，设置页开着就跟着换）。**只刷主进程经 refreshCatalogs 命令说过的目录**（已添加的
 * 服务商 / 设置页点开的卡片）——启动时不主动联网，等主进程拉起本进程后送来的那份 added（审核 F-1）。
 * 失败只记日志：这家继续用旧缓存或内建快照。
 */
const catalogRefresher = new CatalogRefresher({
  refreshPi: (ids) => refreshCatalogs({ ids, signal: AbortSignal.timeout(CATALOG_REFRESH_TIMEOUT_MS) }),
  refreshTokenrhythm: () => {
    const cachePath = tokenrhythmCachePath();
    return fetchTokenrhythmCatalog(
      cachePath === undefined ? {} : { cachePath, minIntervalMs: CATALOG_REFRESH_EVERY_MS },
    );
  },
  relist: listBuiltins,
  warn: (message) => console.warn(message),
});
// 应用常开不关：之后每 4 小时按最近的 added 再来一趟（每家是否真下载由各自的节流决定）。unref：不为它续命
setInterval(() => {
  void catalogRefresher.tick().catch((error: unknown) => console.warn("[catalog] 目录刷新失败：", error));
}, CATALOG_REFRESH_EVERY_MS).unref();

parentPort.on("message", (event) => {
  const command = event.data as AgentHouseholdCommand;
  void handle(command).catch((error: unknown) => {
    send({
      type: "failed",
      sessionId: "sessionId" in command ? command.sessionId : null,
      message: error instanceof Error ? error.message : String(error),
    });
  });
});
parentPort.start?.();
send({ type: "ready" });
// 目录不依赖任何 session，启动即报——设置面不必为了填个下拉框等一次往返
void listBuiltins().catch(() => undefined);
