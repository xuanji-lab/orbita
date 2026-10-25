import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  commandTimeoutNotice,
  createToolCallGate,
  takeCommandTimeoutDecision,
  type ToolCallLike,
  type ToolResultLike,
} from "./permission.ts";
import {
  COMMAND_TIMEOUT_DEFAULT_SECONDS,
  COMMAND_TIMEOUT_FLOOR_SECONDS,
  COMMAND_TIMEOUT_HARD_MAX_SECONDS,
  type PermissionAnswer,
  type PermissionMode,
} from "../shared/permission.ts";

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

/** 取走闸门记下的决定（取用即删，顺带把「表不会长住」也验了） */
function takeDecision(toolCallId: string) {
  return takeCommandTimeoutDecision(toolCallId);
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
});

/**
 * 命令超时闸门。背景：pi 的 bash 工具没有系统超时（上限 2147483.647 秒），唯一的时间是
 * 模型自己填的 `timeout`。两个方向都要管：它经常填保守的小值（60s / 30s / 10s，2026-10-01
 * 统计），慢命令就被自己的秒表砍掉；不填则**完全无上限**（实测有命令跑 3.7 小时）。
 *
 * 夹紧函数不导出（消费者纪律：测试不算真实调用点），全部经闸门测——顺带连「跑在
 * 早退之前」的顺序也一起被钉住。
 */
describe("命令超时闸门（经 createToolCallGate）", () => {
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

  test("不填 → 补默认上限（本 PR 的行为变更：不填不再是无上限）", async () => {
    assert.equal(await clampedTimeout("bash", undefined), COMMAND_TIMEOUT_DEFAULT_SECONDS);
    assert.equal(await clampedTimeout("powershell", undefined), COMMAND_TIMEOUT_DEFAULT_SECONDS);
  });

  test("填得比下限大就尊重模型自己的判断（不超过天花板上限）", async () => {
    assert.equal(await clampedTimeout("bash", 600), 600);
    assert.equal(await clampedTimeout("bash", 900), 900);
    assert.equal(await clampedTimeout("bash", 2900), 2900, "实测 44 分钟的验收脚本自己声明了 2900");
    assert.equal(await clampedTimeout("bash", COMMAND_TIMEOUT_HARD_MAX_SECONDS), COMMAND_TIMEOUT_HARD_MAX_SECONDS);
  });

  test("填得比天花板大 → 夹到 HARD_MAX（声明 120000 秒，实际只给 3600）", async () => {
    assert.equal(await clampedTimeout("bash", 99999), COMMAND_TIMEOUT_HARD_MAX_SECONDS);
    assert.equal(await clampedTimeout("bash", 120000), COMMAND_TIMEOUT_HARD_MAX_SECONDS);
  });

  test("默认值与模型声明值能区分（tool_result 侧靠这个决定要不要说话）", async () => {
    const { gate } = gateFor("skip");

    const absent = { toolCallId: "absent", toolName: "bash", input: { command: "x" } };
    await gate(absent);
    assert.deepEqual(takeDecision("absent"), { effective: COMMAND_TIMEOUT_DEFAULT_SECONDS, declared: false });

    const declared = { toolCallId: "declared", toolName: "bash", input: { command: "x", timeout: 900 } };
    await gate(declared);
    assert.deepEqual(takeDecision("declared"), { effective: 900, declared: true });

    const tooBig = { toolCallId: "tooBig", toolName: "bash", input: { command: "x", timeout: 99999 } };
    await gate(tooBig);
    assert.deepEqual(takeDecision("tooBig"), { effective: COMMAND_TIMEOUT_HARD_MAX_SECONDS, declared: true });
  });

  test("非法值不在这里修：pi 自己会报 Invalid timeout，不替它做第二套校验", async () => {
    assert.equal(await clampedTimeout("bash", 0), 0);
    assert.equal(await clampedTimeout("bash", -5), -5);
    assert.equal(await clampedTimeout("bash", Number.NaN), Number.NaN);
    assert.equal(await clampedTimeout("bash", "60"), "60");
    assert.equal(await clampedTimeout("bash", null), null);
  });

  test("只动命令类工具：read 带上同名字段不碰，也不记账", async () => {
    assert.equal(await clampedTimeout("read", 5), 5);
    assert.equal(await clampedTimeout("mcp__fs__read", 5), 5);

    const { gate } = gateFor("skip");
    await gate({ toolCallId: "notCommand", toolName: "read", input: { path: "a.ts", timeout: 5 } });
    assert.equal(takeDecision("notCommand"), undefined);
  });

  test("被拒的调用不记账——它不会执行、也不会触发 tool_result，记了没人取（会长住）", async () => {
    const plan = createToolCallGate(() => "plan", async () => ({ behavior: "allow" }));
    await plan({ toolCallId: "blockedByPlan", toolName: "bash", input: { command: "x" } });
    assert.equal(takeDecision("blockedByPlan"), undefined);

    const guarded = createToolCallGate(
      () => "skip",
      async () => ({ behavior: "allow" }),
      ["/secrets"],
      "/work",
    );
    await guarded({ toolCallId: "blockedByPath", toolName: "bash", input: { command: "cat /secrets/a" } });
    assert.equal(takeDecision("blockedByPath"), undefined);

    const denied = createToolCallGate(() => "manual", async () => ({ behavior: "deny", message: "no" }));
    await denied({ toolCallId: "deniedByUser", toolName: "bash", input: { command: "x" } });
    assert.equal(takeDecision("deniedByUser"), undefined);
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

/**
 * 结果侧的诚实交代：达到上限时 pi 是**杀进程**（做不到 dsh / ZCode 那样转后台），
 * 命令的进度全部作废。默认上限是我们补的、模型不知道有它，所以到点被杀必须说一句，
 * 否则它只会原样重发同一条、再等一轮超时。
 */
describe("命令超时结果的交代（commandTimeoutNotice）", () => {
  const timedOut = (toolCallId: string, seconds: number, toolName = "bash"): ToolResultLike => ({
    toolCallId,
    toolName,
    isError: true,
    content: [{ type: "text", text: `partial output\n\nCommand timed out after ${seconds} seconds` }],
  });

  /** 过一遍闸门，把「这条命令会跑多久、是不是我们替它定的」记进去（真实链路的顺序） */
  async function gateCommand(toolCallId: string, input: Record<string, unknown>, toolName = "bash"): Promise<void> {
    const { gate } = gateFor("skip");
    await gate({ toolCallId, toolName, input });
  }

  test("默认值被杀 → 追加一段说明，报出的秒数是 pi 实际报的那个", async () => {
    const id = "noticeDefault";
    await gateCommand(id, { command: "bun run dev" });
    const patch = commandTimeoutNotice(timedOut(id, COMMAND_TIMEOUT_DEFAULT_SECONDS));
    assert.ok(patch, "补的默认值到点被杀，必须说话");
    const appended = patch.content[1];
    assert.equal(appended?.type, "text");
    const text = appended?.type === "text" ? appended.text : "";
    // 契约段：seconds 取 pi 报的那个，declared=no（模型没说过 timeout，默认值是我们补的）
    assert.match(text, /\[orbita\] kind=cap seconds=1800 declared=no \| /);
    assert.match(text, /did not pass timeout/);
    assert.match(text, /pass timeout explicitly/);
    assert.equal(patch.content[0]?.type, "text", "原输出留在前面，不替换");
    assert.equal("isError" in patch, false, "不改 isError：被杀确实是失败");
  });

  test("powershell 同一条", async () => {
    const id = "noticePowerShell";
    await gateCommand(id, { command: "bun run test" }, "powershell");
    assert.ok(commandTimeoutNotice(timedOut(id, COMMAND_TIMEOUT_DEFAULT_SECONDS, "powershell")));
  });

  test("模型自己声明了 900 被杀 → 不说（那是它自己的判断）", async () => {
    const id = "noticeDeclared";
    await gateCommand(id, { command: "x", timeout: 900 });
    assert.equal(commandTimeoutNotice(timedOut(id, 900)), undefined);
  });

  test("声明超过天花板（被夹到 HARD_MAX）被杀 → 说，并报出实际的 3600", async () => {
    const id = "noticeClamped";
    await gateCommand(id, { command: "x", timeout: 99999 });
    const patch = commandTimeoutNotice(timedOut(id, COMMAND_TIMEOUT_HARD_MAX_SECONDS));
    assert.ok(patch);
    const appended = patch.content[1];
    const text = appended?.type === "text" ? appended.text : "";
    // 被夹到 HARD_MAX：declared=yes，散文里说清「你要的更大，被夹到 3600」
    assert.match(text, /\[orbita\] kind=cap seconds=3600 declared=yes \| /);
    assert.match(text, /clamped to 3600s/);
  });

  test("非超时的错误不说；而且条目取用即删，不会再被第二次命中", async () => {
    const id = "noticeOtherError";
    await gateCommand(id, { command: "x" });
    const failed = {
      toolCallId: id,
      toolName: "bash",
      isError: true,
      content: [{ type: "text" as const, text: "Command exited with code 1" }],
    };
    assert.equal(commandTimeoutNotice(failed), undefined);
    assert.equal(commandTimeoutNotice(timedOut(id, COMMAND_TIMEOUT_DEFAULT_SECONDS)), undefined, "条目已被取走");
  });

  test("不在表里（未经闸门的调用、或已取过）→ 不说", () => {
    assert.equal(commandTimeoutNotice(timedOut("neverGated", 1800)), undefined);
  });

  test("被拒的调用没有记录 → 即便文本碰巧像超时也不说", async () => {
    const plan = createToolCallGate(() => "plan", async () => ({ behavior: "allow" }));
    await plan({ toolCallId: "blockedNotice", toolName: "bash", input: { command: "x" } });
    assert.equal(commandTimeoutNotice(timedOut("blockedNotice", 1800)), undefined);
  });

  test("isError 为 false 的普通结果不说（文本里出现同句可能是命令自己 echo 的）", async () => {
    const id = "noticeNotError";
    await gateCommand(id, { command: "x" });
    assert.equal(commandTimeoutNotice({ ...timedOut(id, 1800), isError: false }), undefined);
  });
});
