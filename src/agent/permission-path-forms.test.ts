// 2026-11-15 独立验收在真实例里得手的两类：write / edit 用 pi 会规整的路径写法绕过；可见终端不过闸
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createToolCallGate } from "./permission.ts";

// 只是路径字符串：闸门不要求目录存在，测试不在家目录下创建任何东西
const DATA = join(homedir(), "Library", "Application Support", "orbita-gate-test-does-not-exist");
const SESSIONS = join(DATA, "sessions");
const DURABLE = join(DATA, "durable");
const FILE = join(DATA, "automations.json");
const CWD = join(homedir(), "orbita-gate-test-cwd");
const REL = SESSIONS.slice(homedir().length + 1);
const gate = createToolCallGate(() => "skip", async () => ({ behavior: "allow" }), [SESSIONS, DURABLE], CWD, [FILE], { home: homedir(), env: { HOME: homedir() } });
const call = (toolName: string, input: Record<string, unknown>) => gate({ toolCallId: "c", toolName, input });

describe("write / edit：pi 会规整成受保护路径的写法都要拦", () => {
  const forms: [string, string][] = [
    ["~/ 开头", `~/${REL}/x.jsonl`],
    ["@ 前缀 + 绝对路径", `@${SESSIONS}/x.jsonl`],
    ["@ 前缀 + ~/", `@~/${REL}/x.jsonl`],
    ["file:// URL", pathToFileURL(join(SESSIONS, "x.jsonl")).href],
    ["不间断空格代替普通空格", `${SESSIONS.replace("Application Support", "Application\u00A0Support")}/x.jsonl`],
    ["窄不间断空格", `${SESSIONS.replace("Application Support", "Application\u202FSupport")}/x.jsonl`],
    ["~/ 指向另一个受保护目录", `~/${DURABLE.slice(homedir().length + 1)}/a.sqlite`],
    ["~/ 指向受保护的单个文件", `~/${FILE.slice(homedir().length + 1)}`],
    ["@ 前缀 + 受保护文件的 .tmp 兄弟", `@${FILE}.tmp`],
  ];
  for (const [name, path] of forms) {
    for (const tool of ["write", "edit"]) {
      test(`${tool}：${name}`, async () => {
        assert.equal((await call(tool, { path, content: "x" })).block, true, path);
      });
    }
  }

  test("不误伤：cwd 下真的叫 ~ 的相对目录、普通文件、数据目录外的 ~/ 路径照常放行", async () => {
    assert.equal((await call("write", { path: "notes/a.md", content: "x" })).block, undefined);
    assert.equal((await call("write", { path: "~/orbita-gate-test-elsewhere/a.md", content: "x" })).block, undefined);
    assert.equal((await call("write", { path: "@notes/a.md", content: "x" })).block, undefined);
  });

  test("规整不了的输入不让闸门抛错", async () => {
    await assert.doesNotReject(() => call("write", { path: "file://%zz/bad", content: "x" }));
  });
});

describe("可见终端 terminal_execute 也过受保护路径的命令串检查", () => {
  test("删受保护文件、往会话目录里写：拦", async () => {
    assert.equal((await call("terminal_execute", { command: `rm "${FILE}"` })).block, true);
    assert.equal((await call("terminal_execute", { command: `echo x > "${SESSIONS}/a.jsonl"` })).block, true);
    assert.equal((await call("terminal_execute", { command: `rm -rf ~/${DURABLE.slice(homedir().length + 1).replaceAll(" ", "\\ ")}` })).block, true);
  });

  test("普通命令放行", async () => {
    assert.equal((await call("terminal_execute", { command: "bun run dev" })).block, undefined);
    assert.equal((await call("terminal_execute", { command: "ls -la" })).block, undefined);
  });
});
