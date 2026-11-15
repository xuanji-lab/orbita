// 2026-11-15 独立验收在真实例里得手的两类：write / edit 用 pi 会规整的路径写法绕过；可见终端不过闸
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
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

// 2026-11-16 独立复验在真实例里又得手的几类：firmlink 前缀、/.vol、硬链接（按文件身份认）；~用户名；
// ANSI-C 引号里带空格的路径；文档 / 演示文稿工具经符号链接在受保护目录里新建
describe("按文件身份比：字符串与 realpath 认不出、但指到同一个文件或目录的写法", () => {
  // 真文件：身份比对要 stat 得到。放在系统临时目录里（不碰家目录），用完按确切路径删
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orbita-gate-id-")));
  const data = join(root, "Application Support", "orbita");
  const sessions = join(data, "sessions");
  const durable = join(data, "durable");
  const record = join(data, "automations.json");
  const work = join(root, "work");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(durable);
  mkdirSync(work);
  writeFileSync(record, "[]");
  writeFileSync(join(durable, "a.sqlite"), "x");
  writeFileSync(join(sessions, "s.jsonl"), "{}");
  writeFileSync(join(work, "doc.md"), "# doc");
  writeFileSync(join(work, "plain.txt"), "x");
  linkSync(record, join(work, "linked-record.json"));
  linkSync(join(work, "plain.txt"), join(work, "plain-link.txt"));
  symlinkSync(durable, join(work, "into-durable"));
  symlinkSync(sessions, join(work, "into-sessions"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const idGate = createToolCallGate(() => "skip", async () => ({ behavior: "allow" }), [sessions, durable], work, [record], { home: root, env: { HOME: root } });
  const run = (toolName: string, input: Record<string, unknown>) => idGate({ toolCallId: "c", toolName, input });

  const firm = "/System/Volumes/Data";
  test("firmlink 前缀（macOS）：写会话库、会话记录、自动化记录与它的 .tmp 兄弟，都拦", { skip: process.platform !== "darwin" }, async () => {
    for (const path of [firm + join(durable, "a.sqlite"), firm + join(sessions, "new.jsonl"), firm + record, `${firm}${record}.tmp`]) {
      for (const tool of ["write", "edit"]) assert.equal((await run(tool, { path, content: "x" })).block, true, `${tool} ${path}`);
    }
  });

  test("/.vol/<设备>/<inode>（macOS）：拦", { skip: process.platform !== "darwin" }, async () => {
    const file = statSync(join(durable, "a.sqlite"), { bigint: true });
    const dir = statSync(durable, { bigint: true });
    assert.equal((await run("edit", { path: `/.vol/${file.dev}/${file.ino}`, edits: [] })).block, true);
    assert.equal((await run("write", { path: `/.vol/${dir.dev}/${dir.ino}/new.sqlite`, content: "x" })).block, true);
  });

  test("工作区里指向自动化记录的硬链接：拦", async () => {
    for (const tool of ["write", "edit"]) assert.equal((await run(tool, { path: "linked-record.json", content: "x" })).block, true, tool);
  });

  test("文档与演示文稿工具经符号链接写进受保护目录：拦", async () => {
    assert.equal((await run("slides_create", { title: "t", path: "into-durable/x.slides.json" })).block, true);
    assert.equal((await run("doc_open", { path: "into-sessions/x.md", create: true })).block, true);
    assert.equal((await run("slides_write", { path: "into-sessions/x.slides.json", slides: [] })).block, true);
    assert.equal((await run("doc_export", { path: "doc.md", format: "pdf", out: "into-durable/x.pdf" })).block, true);
    assert.equal((await run("slides_export", { path: "deck.slides.json", format: "pdf", out: "../Application Support/orbita/sessions/x.pdf" })).block, true);
    assert.equal((await run("doc_insert_image", { path: "into-durable/x.md", image_path: "a.png" })).block, true);
  });

  test("不误伤：工作区里的普通文件、普通硬链接、只打开不新建的文档、导出到工作区", async () => {
    assert.equal((await run("write", { path: "notes/new.md", content: "x" })).block, undefined);
    assert.equal((await run("edit", { path: "plain-link.txt", edits: [] })).block, undefined);
    assert.equal((await run("doc_open", { path: "into-sessions/s.md" })).block, undefined);
    assert.equal((await run("slides_create", { title: "t", path: "deck.slides.json" })).block, undefined);
    assert.equal((await run("doc_export", { path: "doc.md", format: "pdf", out: "exports/doc.pdf" })).block, undefined);
    assert.equal((await run("doc_insert_image", { path: "doc.md", image_path: "a.png" })).block, undefined);
  });
});

describe("命令串：~用户名 与 ANSI-C 引号里带空格的路径", () => {
  const user = basename(homedir());
  test("~本人用户名/… 指向受保护路径：拦", async () => {
    const rel = SESSIONS.slice(homedir().length + 1).replaceAll(" ", "\\ ");
    for (const tool of ["bash", "terminal_execute"]) {
      assert.equal((await call(tool, { command: `rm -rf ~${user}/${rel}` })).block, true, tool);
      assert.equal((await call(tool, { command: `rm ~${user}/${FILE.slice(homedir().length + 1).replaceAll(" ", "\\ ")}` })).block, true, tool);
    }
  });

  test("$'…' 里整条带空格的路径（十六进制拆词）：拦", async () => {
    const durableHex = DURABLE.replace(/durable$/, "dura\\x62le");
    for (const tool of ["bash", "terminal_execute"]) {
      assert.equal((await call(tool, { command: `rm $'${durableHex}/x.sqlite'` })).block, true, tool);
    }
  });

  test("不误伤：~别人/…、引号里的普通路径", async () => {
    assert.equal((await call("bash", { command: "ls ~someone-else/projects" })).block, undefined);
    assert.equal((await call("bash", { command: "echo $'hello world' > notes.txt" })).block, undefined);
  });
});
