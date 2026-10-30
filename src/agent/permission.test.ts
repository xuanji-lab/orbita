import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createToolCallGate, type ToolCallLike } from "./permission.ts";
import { COMMAND_TIMEOUT_DEFAULT_SECONDS, type PermissionAnswer, type PermissionMode } from "../shared/permission.ts";

function gateFor(mode: PermissionMode, answer?: PermissionAnswer) {
  const asked: ToolCallLike[] = [];
  const gate = createToolCallGate(
    () => mode,
    async (event) => {
      asked.push({ ...event, input: { ...event.input } });
      return answer ?? { behavior: "allow" };
    },
  );
  return { gate, asked };
}

function event(toolName: string, input: Record<string, unknown> = {}): ToolCallLike {
  return { toolCallId: "c1", toolName, input };
}

describe("createToolCallGate", () => {
  test("plan 下 bash 被 block，且不去打扰用户", async () => {
    const { gate, asked } = gateFor("plan");
    const result = await gate(event("bash", { cmd: "rm -rf /" }));
    assert.equal(result.block, true);
    assert.match(result.reason ?? "", /Plan mode/);
    assert.deepEqual(asked, []);
  });

  test("plan 下只读工具直接放行（空结果 = 不拦截）", async () => {
    const { gate, asked } = gateFor("plan");
    assert.deepEqual(await gate(event("read", { path: "a.ts" })), {});
    assert.deepEqual(asked, []);
  });

  test("skip 下一律放行，不询问", async () => {
    const { gate, asked } = gateFor("skip");
    assert.deepEqual(await gate(event("bash", { cmd: "ls" })), {});
    assert.deepEqual(asked, []);
  });

  test("manual 下先问；问的内容带工具名与入参", async () => {
    const { gate, asked } = gateFor("manual");
    assert.deepEqual(await gate(event("write", { path: "a.ts" })), {});
    assert.deepEqual(asked, [{ toolCallId: "c1", toolName: "write", input: { path: "a.ts" } }]);
  });

  test("用户拒绝 → block + 理由回灌给模型", async () => {
    const { gate } = gateFor("manual", { behavior: "deny", message: "别动那个文件" });
    const result = await gate(event("write", { path: "a.ts" }));
    assert.equal(result.block, true);
    assert.equal(result.reason, "别动那个文件");
  });

  test("改写入参：按 pi 的约定**原地改** event.input，不是返回新对象", async () => {
    const { gate } = gateFor("manual", { behavior: "allow", input: { cmd: "rm -rf ./build" } });
    const e = event("bash", { cmd: "rm -rf /" });
    const result = await gate(e);
    assert.deepEqual(result, {}, "放行不该带 block");
    assert.deepEqual(e.input, { cmd: "rm -rf ./build" }, "input 必须被原地改掉");
  });

  test("改写时旧键被清掉，不残留", async () => {
    const { gate } = gateFor("manual", { behavior: "allow", input: { path: "b.ts" } });
    const e = event("write", { path: "a.ts", content: "old" });
    await gate(e);
    assert.deepEqual(e.input, { path: "b.ts" }, "content 不该残留");
  });

  test("允许但没给 input → 入参原样不动", async () => {
    const { gate } = gateFor("manual", { behavior: "allow" });
    const e = event("read", { path: "a.ts" });
    await gate(e);
    assert.deepEqual(e.input, { path: "a.ts" });
  });

  test("模式每次取——中途切档立即生效", async () => {
    let mode: PermissionMode = "skip";
    const gate = createToolCallGate(() => mode, async () => ({ behavior: "allow" }));
    assert.deepEqual(await gate(event("bash")), {});
    mode = "plan";
    assert.equal((await gate(event("bash"))).block, true);
  });

  test("子会话写父会话的工作台不被路径保护拦（protectedPaths 只锁 sessions/ 与 pi-sessions/）", async () => {
    // 子会话的重要产出要写到父工作台的 subsessions/ 下（本 PR 的产出位置规矩），
    // 这条钉住它不会被会话文件只读锁误拦——不需要任何放行例外
    const gate = createToolCallGate(
      () => "skip",
      async () => ({ behavior: "allow" }),
      ["/userData/sessions", "/userData/pi-sessions"],
      "/repo",
    );
    const write = await gate(
      event("write", { path: "/userData/workbenches/parent-1/subsessions/abcd1234-report/report.md", content: "x" }),
    );
    assert.deepEqual(write, {}, "父工作台可写，不该被拦");
    // 对照：sessions/ 里的文件仍全档只读
    const blocked = await gate(event("write", { path: "/userData/sessions/parent-1.jsonl", content: "x" }));
    assert.equal(blocked.block, true);
  });
});

/**
 * 命令超时兜底。背景：pi 的 bash 工具没有系统超时（上限 2147483.647 秒），唯一的时间是
 * 模型自己填的 `timeout`。它经常填保守的小值（60s / 30s / 10s，2026-10-01 统计），
 * 慢命令就被自己的秒表砍掉——白等一分钟再重试。
 *
 * 抬升函数不导出（消费者纪律：测试不算真实调用点），全部经闸门测——顺带连「跑在
 * 早退之前」的顺序也一起被钉住。
 */
describe("命令超时兜底（经 createToolCallGate）", () => {
  /** 只看 `timeout` 一个键，其余原样返回，断言好写。skip 档直达放行，input 被原地抬 */
  async function clampedTimeout(toolName: string, timeout: unknown): Promise<unknown> {
    const { gate } = gateFor("skip");
    const input: Record<string, unknown> = { command: "bun run test" };
    if (timeout !== undefined) input["timeout"] = timeout;
    await gate({ toolCallId: "c1", toolName, input });
    return input["timeout"];
  }

  test("填了但太小 → 抬到下限 600 秒", async () => {
    assert.equal(await clampedTimeout("bash", 60), 600);
    assert.equal(await clampedTimeout("bash", 30), 600);
    assert.equal(await clampedTimeout("bash", 1), 600);
    assert.equal(await clampedTimeout("bash", 599), 600);
  });

  test("powershell 同一条兜底（Windows 上一样会自伤）", async () => {
    assert.equal(await clampedTimeout("powershell", 10), 600);
  });

  test("不填 → 补默认上限 1 小时：以前不填就永远不停，命令自己卡死时整轮挂住（461c6fce）", async () => {
    assert.equal(await clampedTimeout("bash", undefined), COMMAND_TIMEOUT_DEFAULT_SECONDS);
    assert.equal(COMMAND_TIMEOUT_DEFAULT_SECONDS, 3600);
    assert.equal(await clampedTimeout("powershell", undefined), COMMAND_TIMEOUT_DEFAULT_SECONDS);
  });

  test("显式 null 不当「不填」：那是非法值，留给 pi 报错，不偷偷补成 1 小时", async () => {
    assert.equal(await clampedTimeout("bash", null), null);
  });

  test("非命令工具不填 timeout 也不补", async () => {
    assert.equal(await clampedTimeout("read", undefined), undefined);
  });

  test("填得比下限大就尊重模型自己的判断", async () => {
    assert.equal(await clampedTimeout("bash", 600), 600);
    assert.equal(await clampedTimeout("bash", 900), 900);
    assert.equal(await clampedTimeout("bash", 120000), 120000);
  });

  test("非法值不在这里修：pi 自己会报 Invalid timeout，不替它做第二套校验", async () => {
    assert.equal(await clampedTimeout("bash", 0), 0);
    assert.equal(await clampedTimeout("bash", -5), -5);
    assert.equal(await clampedTimeout("bash", Number.NaN), Number.NaN);
    assert.equal(await clampedTimeout("bash", "60"), "60");
    assert.equal(await clampedTimeout("bash", null), null);
  });

  test("只动命令类工具：read 带上同名字段不碰", async () => {
    assert.equal(await clampedTimeout("read", 5), 5);
    assert.equal(await clampedTimeout("mcp__fs__read", 5), 5);
  });

  /**
   * 下面两条是**位置**守卫：兜底必须跑在每条早退之前。
   * default 档（skip）直接走「放行」那条早退——模型填小超时最常见的场景——
   * 把兜底挪到后面就会在这条路径上失效。
   */
  test("skip 档（直接放行那条早退）也抬", async () => {
    const { gate } = gateFor("skip");
    const e = event("bash", { command: "bun run test", timeout: 60 });
    await gate(e);
    assert.equal(e.input["timeout"], 600);
  });

  test("manual 档（问过用户之后）也抬", async () => {
    const { gate, asked } = gateFor("manual");
    const e = event("bash", { command: "bun run test", timeout: 30 });
    await gate(e);
    assert.equal(asked.length, 1, "该问就问");
    assert.equal(e.input["timeout"], 600);
  });

  test("protectedPaths 拦住的那条早退也先抬（否则拒绝理由里带的是旧值）", async () => {
    const gate = createToolCallGate(
      () => "skip",
      async () => ({ behavior: "allow" }),
      // 用正斜杠的绝对路径：两平台字面一致。写成 C:\\secrets 只在 Windows 上成立
      // （反斜杠与大小写的折叠只在 win32 做），macOS 上这条会误红
      ["/secrets"],
      "/work",
    );
    const e = event("bash", { command: "cat /secrets/a.json", timeout: 30 });
    const result = await gate(e);
    assert.equal(result.block, true, "受保护路径本就该拒");
    assert.equal(e.input["timeout"], 600, "拒绝这条路上也要先抬");
  });

  test("人在审批卡片里明确填的秒表说了算——兜底不覆盖人工选择", async () => {
    const { gate } = gateFor("manual", { behavior: "allow", input: { command: "bun run test", timeout: 30 } });
    const e = event("bash", { command: "bun run test", timeout: 60 });
    await gate(e);
    assert.equal(e.input["timeout"], 30);
  });
});
