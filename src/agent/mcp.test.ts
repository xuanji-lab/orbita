/**
 * MCP 桥接的端到端：拉起一台真的 stdio server，验证工具能列出来、能调用。
 *
 * 不 mock SDK——这一刀的全部风险都在「我们和真实 server 的握手对不对」，
 * mock 掉就等于什么都没验。
 *
 * 连接按 **(工作区, server)** 分片：同一个 server 名在不同工作区往往是不同实例
 * （参数不同、数据不同）。分片错了的后果是**静默串号**，所以这里每一刀都拿
 * 真的子进程验，不靠读代码相信它。
 */
import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpHub } from "./mcp.ts";
import {
  mcpRowDisabledFact,
  mergeMcpConfigs,
  mergeServerSources,
  parseMcpConfig,
  parseQualifiedToolName,
  qualifiedToolName,
  resolveServersForWorkspace,
  type McpServer,
} from "../shared/mcp.ts";

const FIXTURE = fileURLToPath(new URL("./mcp-fixture-server.ts", import.meta.url));

/** 没有工作区的会话（Home）用的 scope key——与 runtime 里的算法一致。 */
const HOME = "";

const hub = new McpHub();

/** 一台带身份标记的夹具 server。同名不同 tag = 两份不同的实例。 */
function tagged(tag: string, extra: Record<string, string> = {}): McpServer {
  return {
    transport: "stdio",
    command: process.execPath,
    args: [FIXTURE],
    env: { ORBITA_MCP_FIXTURE_TAG: tag, ...extra },
  };
}

before(async () => {
  await hub.ensure(
    HOME,
    {
      demo: { transport: "stdio", command: process.execPath, args: [FIXTURE] },
      off: { transport: "stdio", command: process.execPath, args: [FIXTURE], disabled: true },
      broken: { transport: "stdio", command: "definitely-not-a-real-command-xyz", args: [] },
    },
    "",
  );
});

after(async () => {
  await hub.dispose();
});

describe("McpHub", () => {
  test("连上的 server 的工具带 mcp__ 前缀进来", () => {
    const names = hub.toolsFor(HOME).map((t) => t.name).sort();
    assert.deepEqual(names, [qualifiedToolName("demo", "boom"), qualifiedToolName("demo", "echo")]);
  });

  // 多台 server 很容易各自都有 search，不加前缀就会互相覆盖
  test("前缀是 mcp__<server>__<tool>", () => {
    assert.equal(qualifiedToolName("demo", "echo"), "mcp__demo__echo");
  });

  test("server 给的 JSON Schema 原样成为工具参数", () => {
    const echo = hub.toolsFor(HOME).find((t) => t.name === "mcp__demo__echo");
    assert.deepEqual(echo?.parameters, {
      type: "object",
      properties: { text: { type: "string", description: "要回显的内容" } },
      required: ["text"],
    });
  });

  test("description 从 server 带过来", () => {
    const echo = hub.toolsFor(HOME).find((t) => t.name === "mcp__demo__echo");
    assert.equal(echo?.description, "把收到的话原样回一遍");
  });

  /**
   * 返回形状必须是 pi 的 `AgentToolResult`：`content` 块数组 + `details`。
   * 上一版返的是 `{ output }`，pi 收到后 `content` 为空——模型看到一个什么都没说的工具结果。
   */
  test("真的能调用，结果是 pi 的 content 块数组", async () => {
    const echo = hub.toolsFor(HOME).find((t) => t.name === "mcp__demo__echo");
    assert.ok(echo);
    const result = await echo.execute("call-1", { text: "在" }, undefined, undefined, undefined as never);
    assert.ok(Array.isArray(result.content));
    assert.deepEqual(result.content[0], { type: "text", text: "echo: 在" });
  });

  // 图片块的形状和 pi 的 ImageContent 完全一致，直接透传，不再降级成一行说明
  test("图片内容块原样透传给 pi", async () => {
    const echo = hub.toolsFor(HOME).find((t) => t.name === "mcp__demo__echo");
    assert.ok(echo);
    const result = await echo.execute("call-2", { text: "x" }, undefined, undefined, undefined as never);
    assert.deepEqual(result.content[1], { type: "image", data: "AAAA", mimeType: "image/png" });
  });

  /**
   * pi 只在 execute **抛出**时才把结果标成 isError（返回值上没有这个字段），
   * 所以 server 的业务失败必须翻成抛出，且 message 就是 server 给的文本。
   */
  test("server 报的业务失败翻成抛出，message 带上 server 的话", async () => {
    const boom = hub.toolsFor(HOME).find((t) => t.name === "mcp__demo__boom");
    assert.ok(boom);
    await assert.rejects(
      boom.execute("call-3", {}, undefined, undefined, undefined as never),
      (error: unknown) => error instanceof Error && /炸了/.test(error.message),
    );
  });

  // MCP server 是外部程序，装错命令是常态，不该让一台坏的挡住全部
  test("一台连不上不影响其它台", () => {
    const statuses = new Map(hub.describe().map((s) => [s.name, s.status.kind]));
    assert.equal(statuses.get("demo"), "ready");
    assert.equal(statuses.get("broken"), "failed");
  });

  test("disabled 的不连，也不出现在工具里", () => {
    const statuses = new Map(hub.describe().map((s) => [s.name, s.status.kind]));
    assert.equal(statuses.get("off"), "disabled");
    assert.equal(hub.toolsFor(HOME).some((t) => t.name.startsWith("mcp__off__")), false);
  });
});

/**
 * 分片（本刀的正题）：一个工作区一份实例。
 *
 * 这一组里每一条都在防同一类事故——**跨工作区静默串号**：论文 A 的会话拿到论文 B
 * 的 state，两边都以为自己在干活。所以断言落在「哪一份实例答的话」上，不落在
 * 「配置看起来对不对」上。
 */
describe("McpHub 的工作区分片", () => {
  test("同名 server 在不同工作区各一份实例，调用各落到自己那一份", async () => {
    const hub = new McpHub();
    await hub.ensure("paper3", { demo: tagged("paper3") }, "C:/papers/paper3");
    await hub.ensure("写稿", { demo: tagged("写稿") }, "C:/papers/写稿");

    const a = hub.toolsFor("paper3").find((t) => t.name === "mcp__demo__echo");
    const b = hub.toolsFor("写稿").find((t) => t.name === "mcp__demo__echo");
    assert.ok(a);
    assert.ok(b);
    const ra = await a.execute("c-a", { text: "hi" }, undefined, undefined, undefined as never);
    const rb = await b.execute("c-b", { text: "hi" }, undefined, undefined, undefined as never);
    assert.deepEqual(ra.content[0], { type: "text", text: "echo: hi [paper3]" });
    assert.deepEqual(rb.content[0], { type: "text", text: "echo: hi [写稿]" });
    await hub.dispose();
  });

  test("只连这一轮要用的工作区，别的不被拉起来", async () => {
    const hub = new McpHub();
    await hub.ensure("paper3", { demo: tagged("paper3") }, "");
    assert.equal(hub.toolsFor("paper3").length, 2);
    assert.deepEqual(hub.toolsFor("写稿"), []);
    await hub.dispose();
  });

  /** 一个工作区开三条会话不该拉起三个 node——子进程数随会话数线性增长是要治的病之一 */
  test("同一工作区的多条会话共用一份实例（不重复拉起子进程）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-mcp-share-"));
    const pidFile = join(dir, "child.pid");
    const hub = new McpHub();
    const server = tagged("w1", { ORBITA_MCP_FIXTURE_PID_FILE: pidFile });
    await hub.ensure("w1", { demo: server }, "");
    const first = await readFile(pidFile, "utf8");
    await hub.ensure("w1", { demo: server }, ""); // 第二条会话开机，走同一条路
    assert.equal(await readFile(pidFile, "utf8"), first);
    await hub.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  test("同一个工作区的配置变了就拆了重连（不是继续用旧参数）", async () => {
    const hub = new McpHub();
    await hub.ensure("w1", { demo: tagged("旧") }, "");
    await hub.ensure("w1", { demo: tagged("新") }, "");
    const echo = hub.toolsFor("w1").find((t) => t.name === "mcp__demo__echo");
    assert.ok(echo);
    const result = await echo.execute("c", { text: "x" }, undefined, undefined, undefined as never);
    assert.deepEqual(result.content[0], { type: "text", text: "echo: x [新]" });
    await hub.dispose();
  });

  test("这台 server 从配置里消失后，这个工作区的旧工具报干净错误", async () => {
    const hub = new McpHub();
    await hub.ensure("w1", { demo: tagged("w1") }, "");
    const echo = hub.toolsFor("w1").find((t) => t.name === "mcp__demo__echo");
    assert.ok(echo);
    await hub.ensure("w1", {}, ""); // 配置里不再有 demo
    await assert.rejects(
      echo.execute("c", { text: "x" }, undefined, undefined, undefined as never),
      /not connected/,
    );
    await hub.dispose();
  });

  /**
   * 工具名不带工作区维度（同一个名字在不同工作区指向不同实例），所以绑定必须写进
   * 描述里——模型只有看到它，才可能发现「用户说的是另一篇」。
   */
  test("绑了工作区的实例把绑定写进工具描述", async () => {
    const hub = new McpHub();
    await hub.ensure("paper3", { demo: tagged("paper3") }, "C:/papers/paper3");
    const echo = hub.toolsFor("paper3").find((t) => t.name === "mcp__demo__echo");
    assert.match(String(echo?.description), /C:\/papers\/paper3/);
    await hub.dispose();
  });

  test("没绑工作区（Home）的实例不加绑定行", () => {
    const echo = hub.toolsFor(HOME).find((t) => t.name === "mcp__demo__echo");
    assert.equal(echo?.description, "把收到的话原样回一遍");
  });

  /** 面板是全局管理面：一个工作区都没打开时也要报得出「配过什么」的状态 */
  test("describe 跨工作区取并集报状态，且带出各实例（scope/绑定/各自状态）", async () => {
    const hub = new McpHub();
    await hub.ensure("paper3", { scoped: { ...tagged("p"), workspaces: ["paper3", "写稿"] } }, "C:/papers/paper3");
    await hub.ensure("写稿", { scoped: tagged("x") }, "C:/papers/写稿");
    const rows = hub.describe();
    assert.deepEqual(rows.map((r) => r.name), ["scoped"]);
    assert.equal(rows[0]?.status.kind, "ready");
    // 实例明细：两个工作区各一份，scope 与绑定路径各自跟着自己
    const instances = rows[0]?.instances ?? [];
    assert.equal(instances.length, 2);
    const byScope = new Map(instances.map((i) => [i.scope, i]));
    assert.equal(byScope.get("paper3")?.label, "C:/papers/paper3");
    assert.equal(byScope.get("写稿")?.label, "C:/papers/写稿");
    assert.equal(byScope.get("写稿")?.status.kind, "ready");
    await hub.dispose();
  });
});

/** 热重载（1-1）的专用 hub：不共享上面的全局实例，重连会改它的状态 */
describe("McpHub.reset（热重载）", () => {
  test("拆完工具清空，但 describe 仍列得出配过什么（下一轮开机重建）", async () => {
    const hub = new McpHub();
    await hub.ensure("w1", { demo: tagged("w1") }, "");
    assert.ok(hub.toolsFor("w1").some((t) => t.name === "mcp__demo__echo"));

    await hub.reset();
    assert.deepEqual(hub.toolsFor("w1"), []);
    const statuses = new Map(hub.describe().map((s) => [s.name, s.status.kind]));
    assert.equal(statuses.get("demo"), "idle");
    await hub.dispose();
  });

  test("reset 后按新配置重建：旧工具消失、新 server 的工具进来", async () => {
    const hub = new McpHub();
    await hub.ensure("w1", { demo: tagged("w1") }, "");
    await hub.reset();
    await hub.ensure("w1", { two: tagged("w1") }, "");
    assert.deepEqual(hub.toolsFor("w1").map((t) => t.name).sort(), [
      "mcp__two__boom",
      "mcp__two__echo",
    ]);
    await hub.dispose();
  });

  // 1-1 修复的回归锚：工具闭包在开机时定格，reset + 重建后旧会话照样能用
  test("跨 reset 的调用落到新 client——已开会话的工具在 reload 后照常工作", async () => {
    const hub = new McpHub();
    await hub.ensure("w1", { demo: tagged("w1") }, "");
    const echo = hub.toolsFor("w1").find((t) => t.name === "mcp__demo__echo");
    assert.ok(echo);
    await hub.reset();
    await hub.ensure("w1", { demo: tagged("w1") }, ""); // 同一台 server 拆掉重连
    const result = await echo.execute("call-reload", { text: "重载后" }, undefined, undefined, undefined as never);
    assert.deepEqual(result.content[0], { type: "text", text: "echo: 重载后 [w1]" });
    await hub.dispose();
  });

  /** stdio 的子进程随 stdin 关闭而退出——旧 client close 后不许有孤儿 */
  test("旧 client 全部 close，子进程真的退了（无孤儿）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-mcp-reload-"));
    const pidFile = join(dir, "child.pid");
    const hub = new McpHub();
    await hub.ensure("w1", { demo: tagged("w1", { ORBITA_MCP_FIXTURE_PID_FILE: pidFile }) }, "");
    assert.ok(hub.toolsFor("w1").some((t) => t.name === "mcp__demo__echo"));
    const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    assert.ok(Number.isInteger(pid));

    await hub.reset();
    // close 是异步的：子进程退出可能晚一点，轮询等它真死（最多 5 秒）
    const deadline = Date.now() + 5_000;
    let dead = false;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        dead = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(dead, `子进程 ${pid} 在 reset 后 5 秒内没有退出`);
    await hub.dispose();
    await rm(dir, { recursive: true, force: true });
  });
});

/**
 * 工作区解析（纯函数，跑在主进程）：**这一条会话该看到哪一份 mcp.json**。
 * 白名单管「哪台 server 在哪个工作区出现」，`${workspaceFolder}` 管「同一个定义
 * 在每个工作区里指向哪里」。
 */
/**
 * 闲置回收：工作区没人用了，它的实例（与子进程）就该收工——进程和 server 侧的
 * 资源（比如论文工具挂在 state 上的锁）不该挂到 app 退出。回收只动资源不动配置：
 * 下一次 ensure 原样重连。全部拿真子进程验——「它应该退了」不能靠读代码相信。
 */
describe("McpHub 的闲置回收", () => {
  /** 等一个 pid 真的死（最多 10 秒——CI runner 慢，5 秒实测不够）。 */
  async function waitDead(pid: number): Promise<boolean> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  test("闲置超时的工作区实例被回收，子进程真的退了，管理面如实回到「还没连」", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-mcp-idle-"));
    const pidFile = join(dir, "child.pid");
    const hub = new McpHub({ idleMs: 1000, sweepMs: 50 });
    let notified = 0;
    hub.onChange = () => {
      notified += 1;
    };
    await hub.ensure("w1", { demo: tagged("w1", { ORBITA_MCP_FIXTURE_PID_FILE: pidFile }) }, "");
    assert.ok(hub.toolsFor("w1").length > 0);
    const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    assert.ok(Number.isInteger(pid));

    assert.ok(await waitDead(pid), `子进程 ${pid} 在闲置超时后 10 秒内没有退出`);
    assert.deepEqual(hub.toolsFor("w1"), []);
    // 等通知到位再断言：清扫先删表项再 close 子进程（notifyChange 在删表那一拍），
    // waitDead 一看见子进程死就往下走，别抢在通知前断言
    const notifyDeadline = Date.now() + 10_000;
    while (notified < 1 && Date.now() < notifyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(notified >= 1, "回收后没有通知（面板会停在陈旧的就绪态）");
    const statuses = new Map(hub.describe().map((s) => [s.name, s.status.kind]));
    assert.equal(statuses.get("demo"), "idle");
    await hub.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * A8：面板靠这条事件链从「连接中」走到工具数。以前只在「一轮开机之后」推一拍
   * （且只在闲置回收时补一拍），连接中的那几十秒面板根本不知道——它写「还没连上」。
   */
  test("连接状态一变就推快照：先 connecting，再 ready", async () => {
    const hub = new McpHub();
    const kinds: string[] = [];
    hub.onChange = () => {
      const row = hub.describe().find((server) => server.name === "demo");
      if (row !== undefined) kinds.push(row.status.kind);
    };
    await hub.ensure("w1", { demo: tagged("w1") }, "");
    assert.ok(
      kinds.includes("connecting"),
      `连接期间必须有一拍 connecting（面板靠它说「连接中」），实际 ${JSON.stringify(kinds)}`,
    );
    assert.equal(kinds.at(-1), "ready");
    await hub.dispose();
    // 拆干净之后最后那一拍是「不再有实例」——describe() 里回到 idle
    assert.equal(kinds.at(-1), "idle");
  });

  test("连不上也推一拍 failed（面板立刻出红字与原因，不必等下一轮）", async () => {
    const hub = new McpHub();
    const kinds: string[] = [];
    hub.onChange = () => {
      const row = hub.describe().find((server) => server.name === "broken");
      if (row !== undefined) kinds.push(row.status.kind);
    };
    await hub.ensure("w1", { broken: { transport: "stdio", command: "definitely-not-a-real-command-xyz", args: [] } }, "");
    assert.deepEqual(kinds, ["connecting", "failed"]);
    await hub.dispose();
  });

  test("活跃的工作区不被回收：开机与调用都刷新闲置计时", async () => {
    const hub = new McpHub({ idleMs: 2000, sweepMs: 60 });
    const server = tagged("w1");
    await hub.ensure("w1", { demo: server }, "");
    const echo = hub.toolsFor("w1").find((t) => t.name === "mcp__demo__echo");
    assert.ok(echo);
    // 在闲置窗口内反复活跃（两次调用、一次重复开机），总跨度 2100ms > idleMs 2000ms
    for (let i = 0; i < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      await echo.execute("c", { text: "活着" }, undefined, undefined, undefined as never);
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
    await hub.ensure("w1", { demo: server }, "");
    assert.ok(hub.toolsFor("w1").length > 0, "活跃期间实例不该被回收");
    await hub.dispose();
  });

  test("连接比闲置窗口还慢不许被回收：开机中的工作区不是闲置", async () => {
    // CI 实测挂过的竞态：windows runner 上拉起子进程 + 握手超过测试的 300ms
    // 闲置窗口，清扫器把「正在连」的 scope 当中闲置回收，ensure 回来表里什么都没有。
    // 夹具延迟 1200ms 才 connect > 闲置窗口 400ms，未修前这个测试必挂。
    const hub = new McpHub({ idleMs: 400, sweepMs: 50 });
    const server = tagged("w1", { ORBITA_MCP_FIXTURE_START_DELAY_MS: "1200" });
    await hub.ensure("w1", { demo: server }, "");
    const echo = hub.toolsFor("w1").find((t) => t.name === "mcp__demo__echo");
    assert.ok(echo, "连接慢过闲置窗口也不许被当中闲置回收——ensure 回来时实例必须在");
    const result = await echo.execute("c", { text: "慢" }, undefined, undefined, undefined as never);
    assert.deepEqual(result.content[0], { type: "text", text: "echo: 慢 [w1]" });
    await hub.dispose();
  });

  test("回收只动资源不动配置：下一次开机原样重连（新子进程，工具照常用）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-mcp-idle-"));
    const pidFile = join(dir, "child.pid");
    const hub = new McpHub({ idleMs: 1000, sweepMs: 50 });
    const server = tagged("w1", { ORBITA_MCP_FIXTURE_PID_FILE: pidFile });
    await hub.ensure("w1", { demo: server }, "");
    const firstPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    assert.ok(await waitDead(firstPid), "第一轮实例没被回收");

    await hub.ensure("w1", { demo: server }, "");
    const secondPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    assert.notEqual(secondPid, firstPid, "重连该是一份新子进程");
    const echo = hub.toolsFor("w1").find((t) => t.name === "mcp__demo__echo");
    const result = await echo!.execute("c", { text: "回来" }, undefined, undefined, undefined as never);
    assert.deepEqual(result.content[0], { type: "text", text: "echo: 回来 [w1]" });
    await hub.dispose();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("McpHub 并发", () => {
  // 两条都来自 PR #163 评审的复现（wafo210715，2026-10-06）：未修前两红。
  test("同一工作区两条会话并发开机：第二条 ensure 返回时工具应已就绪", async () => {
    const hub = new McpHub();
    const server = tagged("w1", { ORBITA_MCP_FIXTURE_START_DELAY_MS: "800" });
    const first = hub.ensure("w1", { demo: server }, "");
    await new Promise((r) => setTimeout(r, 50)); // 第二条会话几乎同时开机
    await hub.ensure("w1", { demo: server }, "");
    const toolsAtSecondOpen = hub.toolsFor("w1").length;
    await first;
    await hub.dispose();
    assert.equal(toolsAtSecondOpen, 2);
  });

  test("ensure 拆旧实例期间发生 reset：不该留下永远 connecting 的僵尸", async () => {
    const hub = new McpHub({ idleMs: 300, sweepMs: 100 });
    await hub.ensure("w1", { demo: tagged("旧") }, "");
    // 配置变了 → ensure 先拆旧的（等子进程退）；紧跟着用户点了 Reload
    const ensuring = hub.ensure("w1", { demo: tagged("新", { ORBITA_MCP_FIXTURE_START_DELAY_MS: "300" }) }, "");
    await hub.reset();
    await ensuring;
    // 再开一轮，配置相同：应该能用
    await hub.ensure("w1", { demo: tagged("新", { ORBITA_MCP_FIXTURE_START_DELAY_MS: "300" }) }, "");
    const tools = hub.toolsFor("w1").length;
    const status = hub.describe().find((s) => s.name === "demo")?.status.kind;
    await hub.dispose();
    assert.equal(tools, 2, `状态 ${status}`);
  });
});

describe("resolveServersForWorkspace", () => {
  const PAPER3 = { id: "ws-1", name: "paper3", path: "C:/papers/paper3" };
  const XIEGAO = { id: "ws-2", name: "写稿", path: "C:/papers/写稿" };

  test("没写 workspaces = 所有工作区都能用（向后兼容的默认）", () => {
    const configured = { fs: { transport: "stdio" as const, command: "npx" } };
    assert.deepEqual(Object.keys(resolveServersForWorkspace(configured, PAPER3)), ["fs"]);
    assert.deepEqual(Object.keys(resolveServersForWorkspace(configured, null)), ["fs"]);
  });

  test("白名单按工作区名或 id 任一命中", () => {
    const byName = { s: { transport: "stdio" as const, command: "node", workspaces: ["paper3"] } };
    const byId = { s: { transport: "stdio" as const, command: "node", workspaces: ["ws-2"] } };
    assert.deepEqual(Object.keys(resolveServersForWorkspace(byName, PAPER3)), ["s"]);
    assert.deepEqual(Object.keys(resolveServersForWorkspace(byName, XIEGAO)), []);
    assert.deepEqual(Object.keys(resolveServersForWorkspace(byId, XIEGAO)), ["s"]);
    // 白名单里的 server 对 Home 会话不出现
    assert.deepEqual(Object.keys(resolveServersForWorkspace(byName, null)), []);
  });

  test("${workspaceFolder} 换进 env / args / cwd / url / headers", () => {
    const configured: Record<string, McpServer> = {
      paper: {
        transport: "stdio",
        command: "node",
        args: ["${workspaceFolder}/server/index.js"],
        env: { AW_PAPER_ROOT: "${workspaceFolder}" },
        cwd: "${workspaceFolder}",
      },
      remote: {
        transport: "http",
        url: "https://x.test/${workspaceFolder}",
        headers: { "X-Root": "${workspaceFolder}" },
      },
    };
    const resolved = resolveServersForWorkspace(configured, PAPER3);
    assert.deepEqual(resolved["paper"], {
      transport: "stdio",
      command: "node",
      args: ["C:/papers/paper3/server/index.js"],
      env: { AW_PAPER_ROOT: "C:/papers/paper3" },
      cwd: "C:/papers/paper3",
    });
    assert.deepEqual(resolved["remote"], {
      transport: "http",
      url: "https://x.test/C:/papers/paper3",
      headers: { "X-Root": "C:/papers/paper3" },
    });
  });

  /**
   * Home 会话没有工作区根可换。**跳过，不塞默认值**——塞一个猜的值正是
   * 这类 server 静默空转 / 串号的来源。
   */
  test("Home 会话跳过用工作区变量的 server，别的照常", () => {
    const configured: Record<string, McpServer> = {
      paper: { transport: "stdio", command: "node", env: { AW_PAPER_ROOT: "${workspaceFolder}" } },
      plain: { transport: "stdio", command: "node" },
    };
    assert.deepEqual(Object.keys(resolveServersForWorkspace(configured, null)), ["plain"]);
  });

  test("白名单 + 工作区变量一起用：只在列出的工作区里，参数指向那个工作区", () => {
    const configured: Record<string, McpServer> = {
      "aw-mcp": {
        transport: "stdio",
        command: "node",
        args: ["C:/code/academic-writing-mcp/server/index.js"],
        env: { AW_PAPER_ROOT: "${workspaceFolder}" },
        workspaces: ["paper3", "写稿"],
      },
    };
    const paper3 = resolveServersForWorkspace(configured, PAPER3)["aw-mcp"];
    const xiegao = resolveServersForWorkspace(configured, XIEGAO)["aw-mcp"];
    const orbita = resolveServersForWorkspace(configured, {
      id: "ws-3",
      name: "orbita",
      path: "C:/code/orbita",
    });
    assert.deepEqual(paper3?.transport === "stdio" ? paper3.env : null, {
      AW_PAPER_ROOT: "C:/papers/paper3",
    });
    assert.deepEqual(xiegao?.transport === "stdio" ? xiegao.env : null, {
      AW_PAPER_ROOT: "C:/papers/写稿",
    });
    // 非论文工作区拿不到它——不然会在自己的仓库里跑起一台论文工具、还往里写 state
    assert.deepEqual(Object.keys(orbita), []);
  });
});

/**
 * 配置分层合并（纯函数）：工作区自带的 `.mcp.json` ∪ 全局 mcp.json，同名工作区赢。
 * 面板列表的合并（mergeServerSources）与之配套：行按名字收拢，来源累计。
 */
describe("mergeMcpConfigs / mergeServerSources", () => {
  test("同名工作区赢全局；不相交的并集都在", () => {
    const global: Record<string, McpServer> = {
      fetch: { transport: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
      shared: { transport: "stdio", command: "node", args: ["global.js"] },
    };
    const local: Record<string, McpServer> = {
      "aw-mcp": { transport: "stdio", command: "node", env: { AW_PAPER_ROOT: "${workspaceFolder}" } },
      shared: { transport: "stdio", command: "node", args: ["local.js"] },
    };
    const merged = mergeMcpConfigs(global, local);
    assert.deepEqual(Object.keys(merged).sort(), ["aw-mcp", "fetch", "shared"]);
    // 同名覆盖：工作区那份赢
    assert.deepEqual(merged["shared"], { transport: "stdio", command: "node", args: ["local.js"] });
    // 不改输入
    assert.deepEqual(global["shared"], { transport: "stdio", command: "node", args: ["global.js"] });
  });

  test("「在这个工作区停用全局某台」= 同名 + disabled: true", () => {
    const merged = mergeMcpConfigs(
      { fetch: { transport: "stdio", command: "uvx" } },
      { fetch: { transport: "stdio", command: "uvx", disabled: true } },
    );
    assert.equal(merged["fetch"]?.disabled, true);
  });

  test("面板行合并：来源累计，被覆盖的全局条目展示工作区那份", () => {
    const rows = mergeServerSources(
      { shared: { transport: "stdio", command: "node", args: ["global.js"] } },
      [
        { workspace: "paper3", servers: { "aw-mcp": { transport: "stdio", command: "node" }, shared: { transport: "stdio", command: "node", args: ["local.js"] } } },
        { workspace: "写稿", servers: { "aw-mcp": { transport: "stdio", command: "node" } } },
      ],
    );
    const byName = new Map(rows.map((r) => [r.name, r]));
    assert.deepEqual(byName.get("aw-mcp")?.source, { global: false, workspaces: ["paper3", "写稿"] });
    assert.deepEqual(byName.get("shared")?.source, { global: true, workspaces: ["paper3"] });
    // 同名工作区赢全局：行上展示跑得起来的那份
    assert.deepEqual((byName.get("shared")?.server as { args?: string[] }).args, ["local.js"]);
    assert.deepEqual(rows.map((r) => r.name), ["aw-mcp", "shared"]);
  });

  test("启停的事实跟按钮写的那份文件对齐（有全局来源读全局，工作区独有读自己）", () => {
    const global: Record<string, McpServer> = {
      // 全局 + 工作区同名：行上展示工作区那份定义（没有 disabled），
      // 但启停按钮只写全局文件——事实必须读全局，否则按钮看起来是死的
      shared: { transport: "stdio", command: "node", disabled: true },
      globalOnly: { transport: "stdio", command: "node", disabled: true },
    };
    const rows = mergeServerSources(global, [
      {
        workspace: "paper3",
        servers: {
          shared: { transport: "stdio", command: "node" },
          wsOnly: { transport: "stdio", command: "node", disabled: true },
        },
      },
    ]);
    const byName = new Map(rows.map((r) => [r.name, r]));
    const shared = byName.get("shared");
    const globalOnly = byName.get("globalOnly");
    const wsOnly = byName.get("wsOnly");
    assert(shared !== undefined && globalOnly !== undefined && wsOnly !== undefined);
    // 行上展示的确实是工作区那份定义（同名工作区赢，不变）
    assert.equal(shared.server.disabled, undefined);
    assert.equal(mcpRowDisabledFact(shared, global), true);
    assert.equal(mcpRowDisabledFact(globalOnly, global), true);
    // 工作区独有的行：按钮禁用、够不着写路径，读它自己的文件
    assert.equal(mcpRowDisabledFact(wsOnly, global), true);
  });
});

describe("parseMcpConfig", () => {
  test("认 Claude Desktop 的 mcpServers 格式", () => {
    const parsed = parseMcpConfig({
      mcpServers: { fs: { command: "npx", args: ["-y", "server-filesystem", "/tmp"] } },
    });
    assert.deepEqual(parsed["fs"], {
      transport: "stdio",
      command: "npx",
      args: ["-y", "server-filesystem", "/tmp"],
    });
  });

  test("http 传输另算一支", () => {
    const parsed = parseMcpConfig({
      mcpServers: { remote: { transport: "http", url: "https://example.com/mcp" } },
    });
    assert.deepEqual(parsed["remote"], { transport: "http", url: "https://example.com/mcp" });
  });

  // Claude Desktop 系的 type 写法 / 只给 url（2026-10-11）：读侧认得，不再静默丢
  test("type:「http」/ type:「streamable-http」认作 http，规范成自家格式", () => {
    const parsed = parseMcpConfig({
      mcpServers: {
        a: { type: "http", url: "https://a.example/mcp" },
        b: { type: "streamable-http", url: "https://b.example/mcp" },
      },
    });
    assert.deepEqual(parsed["a"], { transport: "http", url: "https://a.example/mcp" });
    assert.deepEqual(parsed["b"], { transport: "http", url: "https://b.example/mcp" });
  });

  test("只给 url（无传输声明无 command）当 http；已废弃的 sse 不认", () => {
    const parsed = parseMcpConfig({
      mcpServers: {
        bare: { url: "https://bare.example/mcp" },
        sse: { type: "sse", url: "https://sse.example/mcp" },
        noUrl: { type: "http" },
      },
    });
    assert.deepEqual(parsed["bare"], { transport: "http", url: "https://bare.example/mcp" });
    assert.equal(parsed["sse"], undefined);
    assert.equal(parsed["noUrl"], undefined);
  });

  test("command 与 url 同给（无传输声明）：按 stdio 的 command 认", () => {
    const parsed = parseMcpConfig({
      mcpServers: { both: { command: "node", url: "https://x.example/mcp" } },
    });
    assert.deepEqual(parsed["both"], { transport: "stdio", command: "node" });
  });

  test("workspaces 白名单原样带出来，非字符串项丢掉", () => {
    const parsed = parseMcpConfig({
      mcpServers: {
        s: { command: "node", workspaces: ["paper3", 7, "写稿", "paper3"] },
      },
    });
    assert.deepEqual(parsed["s"]?.workspaces, ["paper3", "写稿"]);
  });

  test("workspaces 不是数组 / 全被丢掉 = 当作没写（所有工作区）", () => {
    const parsed = parseMcpConfig({
      mcpServers: { a: { command: "node", workspaces: "paper3" }, b: { command: "node", workspaces: [] } },
    });
    assert.equal(parsed["a"]?.workspaces, undefined);
    assert.equal(parsed["b"]?.workspaces, undefined);
  });

  test("坏掉的一条跳过，不挡住其它 server", () => {
    const parsed = parseMcpConfig({
      mcpServers: { good: { command: "node" }, bad: { nothing: true }, alsoBad: null },
    });
    assert.deepEqual(Object.keys(parsed), ["good"]);
  });

  // 工具名会进 LLM 的 tool schema，各家 provider 对字符集都有要求
  test("名字不能拼进工具名的 server 直接跳过", () => {
    const parsed = parseMcpConfig({ mcpServers: { "bad name!": { command: "node" } } });
    assert.deepEqual(Object.keys(parsed), []);
  });

  test("整个文件不是对象时返回空，不抛", () => {
    assert.deepEqual(parseMcpConfig(null), {});
    assert.deepEqual(parseMcpConfig("nope"), {});
    assert.deepEqual(parseMcpConfig({}), {});
  });
});

describe("parseQualifiedToolName（4-5）", () => {
  test("拆出 server 与 tool", () => {
    assert.deepEqual(parseQualifiedToolName("mcp__demo__echo"), { server: "demo", tool: "echo" });
    assert.deepEqual(parseQualifiedToolName("mcp__fs_1__read_file"), { server: "fs_1", tool: "read_file" });
  });

  test("不是 MCP 形状返回 null（内建工具名照常走路）", () => {
    assert.equal(parseQualifiedToolName("bash"), null);
    assert.equal(parseQualifiedToolName("mcp__onlyone"), null);
    assert.equal(parseQualifiedToolName("mcp____tool"), null);
  });
});
