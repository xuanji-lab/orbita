/**
 * 内建四件（新内核自带的 read / write / edit / bash）外面 Orbita 那层包装：执行环境、Git Bash 路径折算、PDF / Word 指路、
 * 一批「准备完才执行」的节奏、bash 的实时输出与会话环境变量。工具本身的行为由新内核自己的测试守，这里只守包装。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { bashSessionEnv, builtinTools, DOC_POINTER, DOCX_POINTER, PDF_POINTER, type DurableToolScope } from "./durable-tools.ts";

let cwd = "";
before(async () => {
  cwd = await mkdtemp(join(tmpdir(), "orbita-durable-tools-"));
});
after(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const OPTIONS = { autoResizeImages: false, commandPrefix: undefined, shellPath: undefined } as const;

function scope(patch: Partial<DurableToolScope> = {}): DurableToolScope {
  return {
    cwd,
    autoResizeImages: false,
    model: () => ({ provider: "faux", id: "tiny" }) as never,
    thinkingLevel: () => "high",
    providerSessionId: () => "psid-1",
    ...patch,
  };
}

/** 不经 Harness 直接调一个工具：api 只给工具会碰到的那几样（env 由包装层换成它自己的） */
async function run(tool: ToolRegistration, args: object, callId = "c1", context: Context = BACKGROUND_CONTEXT): Promise<ToolExecutionResult & { text: string }> {
  let output = "";
  const diagnostics: unknown[] = [];
  const api = {
    callId,
    env: undefined,
    agent: async () => ({}),
    models: { getModel: () => undefined },
    output: (chunk: string | Uint8Array) => {
      output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    },
    outputWindow: undefined,
    retainedOutput: () => ({ text: output, truncated: false }),
    diagnostic: (diagnostic: unknown) => diagnostics.push(diagnostic),
  } as never;
  const result = (await tool.execute(args as never, api, context)) as ToolExecutionResult;
  const text = (result.output ?? []).flatMap((item) => (item.type === "text" ? [item.text] : [])).join("") || output;
  return { ...result, text };
}

const byName = (tools: ToolRegistration[], name: string): ToolRegistration => {
  const tool = tools.find((each) => each.name === name);
  assert.ok(tool !== undefined, name);
  return tool;
};

describe("builtinTools", () => {
  test("四件、按名字排序；write 写到本轮 cwd 下，read 读回来", async () => {
    const tools = builtinTools(cwd, OPTIONS, scope());
    assert.deepEqual(tools.map((tool) => tool.name), ["bash", "edit", "read", "write"]);
    await run(byName(tools, "write"), { path: "a.txt", content: "hello" });
    assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "hello");
    assert.equal((await run(byName(tools, "read"), { path: "a.txt" })).text, "hello");
  });

  test("read 碰到 PDF（按魔数）/ .docx / .doc（按扩展名）改回指路，不读出乱码", async () => {
    await writeFile(join(cwd, "paper.bin"), "%PDF-1.7\n\u0000\u0001binary");
    await writeFile(join(cwd, "notes.docx"), "PK\u0003\u0004zip");
    await writeFile(join(cwd, "old.doc"), "\u00d0\u00cf\u0011\u00e0legacy");
    const read = byName(builtinTools(cwd, OPTIONS, scope()), "read");
    assert.equal((await run(read, { path: "paper.bin" })).text, PDF_POINTER);
    assert.equal((await run(read, { path: "notes.docx" })).text, DOCX_POINTER);
    assert.equal((await run(read, { path: "@old.doc" })).text, DOC_POINTER);
  });

  test("bash：在本轮 cwd 里跑；子进程拿到这一轮的 PI_SESSION_ID / PI_PROVIDER / PI_MODEL / PI_REASONING_LEVEL，继承来的不漏进去", async () => {
    const bash = byName(builtinTools(cwd, OPTIONS, scope()), "bash");
    const previous = process.env["PI_SESSION_FILE"];
    process.env["PI_SESSION_FILE"] = "/someone/else.jsonl";
    try {
      const result = await run(bash, { command: 'pwd; echo "$PI_SESSION_ID|$PI_PROVIDER|$PI_MODEL|$PI_REASONING_LEVEL|${PI_SESSION_FILE-unset}"' });
      const [dir, vars] = result.text.trim().split("\n");
      assert.equal(await realpath(dir ?? ""), await realpath(cwd));
      assert.equal(vars, "psid-1|faux|tiny|high|unset");
    } finally {
      if (previous === undefined) delete process.env["PI_SESSION_FILE"];
      else process.env["PI_SESSION_FILE"] = previous;
    }
  });

  test("bash：commandPrefix 在前、孤儿善后的标签加在最前；实时输出按 partialResult 同形交给界面", async () => {
    const updates: unknown[] = [];
    const tools = builtinTools(
      cwd,
      { ...OPTIONS, commandPrefix: "export ORBITA_PREFIX=on", tagCommand: (command) => `# tagged\n${command}` },
      scope({ onUpdate: (callId, name, partial) => updates.push({ callId, name, partial }) }),
    );
    const result = await run(byName(tools, "bash"), { command: "echo $ORBITA_PREFIX" }, "call-9");
    assert.equal(result.text.trim(), "on");
    assert.deepEqual(updates.at(-1), { callId: "call-9", name: "bash", partial: { content: [{ type: "text", text: "on\n" }] } });
  });

  describe("Windows：bash 每次运行挂运行标记，停止 / 超时后按它收割（platform 注入 win32，命令在本机 bash 里真跑）", () => {
    const winTools = (reaped: string[]) =>
      builtinTools(cwd, { ...OPTIONS, platform: "win32", childTag: "orbita-t", reapRun: async (mark) => (reaped.push(mark), 1) }, scope());

    test("子进程拿到 ORBITA_KERNEL_RUN=<标签>.<运行 id>，每次不同；正常跑完不收割（留在后台的进程不该被带走）", async () => {
      const reaped: string[] = [];
      const bash = byName(winTools(reaped), "bash");
      const first = (await run(bash, { command: "echo $ORBITA_KERNEL_RUN" }, "r1")).text.trim();
      const second = (await run(bash, { command: "echo $ORBITA_KERNEL_RUN" }, "r2")).text.trim();
      assert.match(first, /^orbita-t\.[0-9a-f-]{36}$/);
      assert.match(second, /^orbita-t\.[0-9a-f-]{36}$/);
      assert.notEqual(first, second);
      assert.deepEqual(reaped, []);
    });

    test("停止：abort 时按这一次的运行标记收割一次（与子进程环境里的值对得上）", async () => {
      const reaped: string[] = [];
      const bash = byName(winTools(reaped), "bash");
      const marker = join(cwd, "run-mark.txt");
      const controller = new AbortController();
      const running = run(bash, { command: `echo -n "$ORBITA_KERNEL_RUN" > "${marker}"; sleep 5` }, "r3", withAbortSignal(controller.signal, BACKGROUND_CONTEXT)).catch((error: unknown) => error);
      for (let i = 0; i < 50; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if ((await readFile(marker, "utf8").catch(() => "")) !== "") break;
      }
      controller.abort();
      await running;
      const value = await readFile(marker, "utf8");
      assert.deepEqual(reaped, [`ORBITA_KERNEL_RUN=${value}`]);
    });

    test("超时：跑满 timeout 后收割；只收一次", async () => {
      const reaped: string[] = [];
      const bash = byName(winTools(reaped), "bash");
      await run(bash, { command: "sleep 3", timeout: 1 }, "r4").catch((error: unknown) => error);
      assert.equal(reaped.length, 1);
      assert.match(reaped[0] ?? "", /^ORBITA_KERNEL_RUN=orbita-t\.[0-9a-f-]{36}$/);
    });

    test("非 Windows 或没给标签：不挂运行标记、不收割", async () => {
      const reaped: string[] = [];
      const reapRun = async (mark: string): Promise<number> => (reaped.push(mark), 1);
      for (const options of [{ ...OPTIONS, platform: "darwin" as const, childTag: "orbita-t", reapRun }, { ...OPTIONS, platform: "win32" as const, reapRun }]) {
        const bash = byName(builtinTools(cwd, options, scope()), "bash");
        assert.equal((await run(bash, { command: 'echo "${ORBITA_KERNEL_RUN-unset}"' })).text.trim(), "unset");
        const controller = new AbortController();
        const running = run(bash, { command: "sleep 5" }, "r5", withAbortSignal(controller.signal, BACKGROUND_CONTEXT)).catch((error: unknown) => error);
        setTimeout(() => controller.abort(), 200);
        await running;
      }
      assert.deepEqual(reaped, []);
    });
  });

  test("执行前先等 beforeExecute（一批工具准备完才一起执行）", async () => {
    const order: string[] = [];
    const tools = builtinTools(
      cwd,
      OPTIONS,
      scope({
        beforeExecute: async (callId) => {
          order.push(`wait ${callId}`);
        },
      }),
    );
    await run(byName(tools, "write"), { path: "b.txt", content: "x" }, "w1");
    order.push("done");
    assert.deepEqual(order, ["wait w1", "done"]);
  });

  test("bashSessionEnv：继承来的 PI_* 全去掉，只写这一轮的四个；没有模型时不写 PROVIDER / MODEL", () => {
    const env = bashSessionEnv(
      { PATH: "/bin", PI_SESSION_ID: "old", PI_SESSION_FILE: "/x", PI_PACKAGE_DIR: "/pkg", PI_MODEL: "old" },
      { model: () => undefined, thinkingLevel: () => "", providerSessionId: () => "new" },
    );
    assert.deepEqual(env, { PATH: "/bin", PI_SESSION_ID: "new" });
  });
});
