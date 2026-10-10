/**
 * 终端工具这一层只是翻译：参数 → terminalRequest（带发起会话）→ 回执 → pi 工具结果。
 * PTY 与所有权校验在主进程，这里用假主进程回执。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { RequestBroker } from "./request-broker.ts";
import { createTerminalTools, TERMINAL_TOOL_NAMES } from "./terminal-tools.ts";
import type { TerminalInfo, TerminalToolOutcome } from "../shared/terminal.ts";
import { TERMINAL_READ_DEFAULT_LIMIT, TERMINAL_READ_MAX_LIMIT } from "../shared/terminal.ts";

const setup = () => {
  const sent: Record<string, unknown>[] = [];
  const broker = new RequestBroker((event) => sent.push(event as Record<string, unknown>));
  const tools = new Map(
    createTerminalTools(broker, "session-1", {
      cwd: "/repo",
      authorizedDirs: ["/repo", "/data/attached"],
    }).map((tool) => [tool.name, tool]),
  );
  const answer = (index: number, outcome: TerminalToolOutcome): void =>
    broker.resolve(String(sent[index]?.["requestId"]), outcome);
  const run = (name: string, params: unknown) =>
    tools.get(name)!.execute("call", params as never, undefined, undefined, undefined as never);
  return { sent, tools, answer, run };
};

const terminal: TerminalInfo = {
  terminalId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  title: "repo",
  shell: "pwsh",
  cwd: "/repo",
  pid: 4242,
  exited: null,
  owner: { kind: "agent", sessionId: "session-1" },
};

describe("terminal_* 工具", () => {
  test("六个工具一个不少；名单与 TERMINAL_TOOL_NAMES 对得上（权限档描述认这一份）", () => {
    const { tools } = setup();
    assert.deepEqual([...tools.keys()].sort(), [...TERMINAL_TOOL_NAMES].sort());
  });

  test("execute：command 上船、带发起会话；回执正文进 content、终稿进 details 之外不带别的", async () => {
    const { sent, answer, run } = setup();
    const pending = run("terminal_execute", { command: "  git status  " });
    assert.equal(sent[0]?.["type"], "terminalRequest");
    assert.equal(sent[0]?.["sessionId"], "session-1");
    assert.deepEqual(sent[0]?.["request"], { action: "execute", command: "git status" });
    answer(0, { ok: true, text: "Started the command…", terminal });
    const result = await pending;
    assert.deepEqual(result.content, [{ type: "text", text: "Started the command…" }]);
  });

  test("execute：terminalId 与 cwd 只在给了非空值时才上船；空串当没给", async () => {
    const { sent, answer, run } = setup();
    const first = run("terminal_execute", { command: "ls", terminalId: " t-1 ", cwd: " /data/attached " });
    assert.deepEqual(sent[0]?.["request"], {
      action: "execute",
      command: "ls",
      terminalId: "t-1",
      cwd: "/data/attached",
    });
    answer(0, { ok: true, text: "ok", terminal });
    await first;
    const second = run("terminal_execute", { command: "ls", terminalId: "", cwd: "" });
    assert.deepEqual(sent[1]?.["request"], { action: "execute", command: "ls" });
    answer(1, { ok: true, text: "ok", terminal });
    await second;
  });

  test("execute / read / interrupt / close：缺必填参数当场报错，不发请求", async () => {
    const { sent, run } = setup();
    await assert.rejects(run("terminal_execute", { command: "   " }), /command is required/);
    await assert.rejects(run("terminal_read", {}), /terminalId is required/);
    await assert.rejects(run("terminal_interrupt", { terminalId: 42 }), /terminalId is required/);
    await assert.rejects(run("terminal_close", { terminalId: "" }), /terminalId is required/);
    assert.equal(sent.length, 0);
  });

  test("read：offset / limit 上船；模型写成字符串也认，NaN 当没给", async () => {
    const { sent, answer, run } = setup();
    const first = run("terminal_read", { terminalId: "t-1", offset: 0, limit: 2000 });
    assert.deepEqual(sent[0]?.["request"], { action: "read", terminalId: "t-1", offset: 0, limit: 2000 });
    answer(0, { ok: true, text: "text", terminal });
    await first;
    const second = run("terminal_read", { terminalId: "t-1", offset: "120", limit: "800" });
    assert.deepEqual(sent[1]?.["request"], { action: "read", terminalId: "t-1", offset: 120, limit: 800 });
    answer(1, { ok: true, text: "text", terminal });
    await second;
    const third = run("terminal_read", { terminalId: "t-1", offset: Number.NaN, limit: "abc" });
    assert.deepEqual(sent[2]?.["request"], { action: "read", terminalId: "t-1" });
    answer(2, { ok: true, text: "text", terminal });
    await third;
  });

  test("open：只在上船给了的字段；list 无参数", async () => {
    const { sent, answer, run } = setup();
    const first = run("terminal_open", { cwd: "/data/attached" });
    assert.deepEqual(sent[0]?.["request"], { action: "open", cwd: "/data/attached" });
    answer(0, { ok: true, text: "opened", terminal });
    await first;
    const second = run("terminal_open", {});
    assert.deepEqual(sent[1]?.["request"], { action: "open" });
    answer(1, { ok: true, text: "opened", terminal });
    await second;
    const third = run("terminal_list", {});
    assert.deepEqual(sent[2]?.["request"], { action: "list" });
    answer(2, { ok: true, text: "none" });
    await third;
  });

  test("主进程拒绝时抛给人话：模型看到的是原因，不是空结果", async () => {
    const { answer, run } = setup();
    const pending = run("terminal_execute", { command: "rm -rf build", terminalId: "t-1" });
    answer(0, { ok: false, error: 'Terminal "t-1" is not owned by this session.' });
    await assert.rejects(pending, /not owned by this session/);
  });

  test("schema 写明了执行逻辑认的可选参数——模型只看 schema，漏写就等于没有这个选项", () => {
    const { tools } = setup();
    const props = (name: string): string[] =>
      Object.keys((tools.get(name)!.parameters as { properties: Record<string, unknown> }).properties).sort();
    assert.deepEqual(props("terminal_open"), ["cwd"]);
    assert.deepEqual(props("terminal_execute"), ["command", "cwd", "terminalId"]);
    assert.deepEqual(props("terminal_read"), ["limit", "offset", "terminalId"]);
    assert.deepEqual(props("terminal_list"), []);
    assert.deepEqual(props("terminal_interrupt"), ["terminalId"]);
    assert.deepEqual(props("terminal_close"), ["terminalId"]);
    // 必填项也逐个钉住：少一个，模型就会用一个没有命令的 execute 来跑空
    const required = (name: string): string[] =>
      (tools.get(name)!.parameters as { required: string[] }).required;
    assert.deepEqual(required("terminal_execute"), ["command"]);
    assert.deepEqual(required("terminal_read"), ["terminalId"]);
    assert.deepEqual(required("terminal_interrupt"), ["terminalId"]);
    assert.deepEqual(required("terminal_close"), ["terminalId"]);
  });

  test("模型指令：execute 讲清「输出不在结果里」，每个工具都有一句 promptSnippet", () => {
    const { tools } = setup();
    const execute = tools.get("terminal_execute")!;
    assert.match(execute.description, /outputSharedWithAgent: false/);
    assert.match(execute.description, /terminal_read/);
    // 复用纪律写在 promptGuidelines（pi 0.84.3 的原生字段），不在代码里硬编码
    const guidelines = execute.promptGuidelines ?? [];
    assert.ok(guidelines.length >= 4, "execute 的复用纪律至少四条");
    assert.ok(guidelines.some((line) => /call terminal_list/.test(line)));
    assert.ok(guidelines.some((line) => /Do not reuse an interactive/.test(line)));
    assert.ok(guidelines.some((line) => /headless bash tool/.test(line)));
    assert.ok(guidelines.some((line) => /leave the terminal open/.test(line)));
    for (const name of TERMINAL_TOOL_NAMES) {
      const snippet = tools.get(name)!.promptSnippet;
      assert.equal(typeof snippet, "string", name);
      assert.ok((snippet ?? "").length > 0 && (snippet ?? "").length < 200, name);
    }
  });

  test("工具描述里带上授权目录——模型不必先撞一次墙才知道 cwd 能填什么", () => {
    const { tools } = setup();
    const description = tools.get("terminal_open")!.description;
    assert.match(description, /\/repo/);
    assert.match(description, /\/data\/attached/);
  });

  test("read 的 limit 上界与默认值跟契约同一份（12000 / 48000）", () => {
    assert.equal(TERMINAL_READ_DEFAULT_LIMIT, 12_000);
    assert.equal(TERMINAL_READ_MAX_LIMIT, 48_000);
  });
});
