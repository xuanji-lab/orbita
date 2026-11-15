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

// 2026-11-16 增量复验：`~+` / `$PWD` / `$(pwd)` 等价于当前目录，闸门原来不认，后面接的相对段落落不到受保护路径上
describe("命令串：「当前目录」的几种写法后面接相对路径", () => {
  // CWD 在家目录下一层：../Library/… 就到受保护的数据目录
  const up = `../${DURABLE.slice(homedir().length + 1)}/x.sqlite`;
  const upFile = `../${FILE.slice(homedir().length + 1)}`;
  const esc = (path: string) => path.replaceAll(" ", "\\ ");
  const forms: [string, string][] = [
    ["~+/", `rm ~+/${esc(up)}`],
    ["$PWD/", `rm "$PWD/${up}"`],
    ["${PWD}/", `rm "\${PWD}/${up}"`],
    ["$(pwd)/", `rm "$(pwd)/${up}"`],
    ["$(pwd -P)/", `rm "$(pwd -P)/${up}"`],
    ["反引号 pwd", `rm "\`pwd\`/${up}"`],
    ["$PWD 指向自动化记录", `mv "$PWD/${upFile}" /tmp/x`],
  ];
  for (const [name, command] of forms) {
    for (const tool of ["bash", "terminal_execute"]) {
      test(`${tool}：${name}`, async () => {
        assert.equal((await call(tool, { command })).block, true, command);
      });
    }
  }

  test("不误伤：当前目录写法后面是工作区里的普通路径", async () => {
    for (const command of ["ls $PWD", 'echo "$(pwd)"', "cp a.txt ~+/b.txt", 'rm "$PWD/build/out.js"', "cd $(pwd)/src && ls"]) {
      assert.equal((await call("bash", { command })).block, undefined, command);
    }
  });
});

// 2026-11-16 增量复验（二）：先改 HOME 再用 ~；cd 的目标写成 firmlink 前缀；受保护目录还不存在时的 firmlink 写
describe("命令里改 HOME、cd 到 firmlink 前缀；写到还不存在的受保护目录", () => {
  const parent = join(DATA, ".."); // Application Support
  const name = basename(DATA);
  test("先给 HOME 赋值再用 ~：拦", async () => {
    for (const tool of ["bash", "terminal_execute"]) {
      assert.equal((await call(tool, { command: `HOME="${parent}"; rm ~/${name}/sessions/x.jsonl` })).block, true, tool);
      assert.equal((await call(tool, { command: `export HOME="${parent}" && rm -rf ~/${name}/durable` })).block, true, tool);
      assert.equal((await call(tool, { command: `HOME="${parent}"; mv ~/${name}/automations.json /tmp/x` })).block, true, tool);
    }
  });

  test("cd 的目标写成 firmlink 前缀，再用相对名：拦", async () => {
    for (const tool of ["bash", "terminal_execute"]) {
      assert.equal((await call(tool, { command: `cd "/System/Volumes/Data${parent}" && rm ${name}/automations.json` })).block, true, tool);
      assert.equal((await call(tool, { command: `cd "/System/Volumes/Data${DATA}" && rm -rf durable` })).block, true, tool);
    }
  });

  test("write / edit 到还不存在的受保护目录（firmlink 前缀，stat 不到）：拦", async () => {
    // pi-sessions/ 这类目录可能还没建：身份比对认不出，靠去掉 firmlink 前缀后的字符串比对
    const notYet = join(DATA, "pi-sessions");
    const gateNotYet = createToolCallGate(() => "skip", async () => ({ behavior: "allow" }), [notYet], CWD, [], { home: homedir(), env: { HOME: homedir() } });
    for (const tool of ["write", "edit"]) {
      const result = await gateNotYet({ toolCallId: "c", toolName: tool, input: { path: `/System/Volumes/Data${notYet}/x.jsonl`, content: "x" } });
      assert.equal(result.block, true, tool);
    }
  });

  test("不误伤：给 HOME 赋值后读写别处、firmlink 前缀指向工作区", async () => {
    for (const command of ["HOME=/tmp/fakehome; ls ~", "HOME=/tmp/x bun test", `cd "/System/Volumes/Data${CWD}" && rm -rf build`]) {
      assert.equal((await call("bash", { command })).block, undefined, command);
    }
    assert.equal((await call("write", { path: `/System/Volumes/Data${CWD}/notes.md`, content: "x" })).block, undefined);
  });
});
