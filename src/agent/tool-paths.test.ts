/**
 * tool-paths 与真工具同口径：拿新内核自带的 write 工具在 NodeExecutionEnv 上真落盘，逐形态比对落点；
 * Windows 上 Git Bash 盘符写法的折算用平台注入在 macOS 上覆盖（真机验证留给 Windows 验收）。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createWriteTool } from "@earendil-works/pi-durable/tools";
import { msysDrivePath, toolPathArgument, toolTargetPath } from "./tool-paths.ts";

let cwd = "";
before(async () => {
  cwd = await mkdtemp(join(tmpdir(), "orbita-tool-paths-"));
});
after(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/** 真工具写一次，返回它写到了哪（按我们算出的路径去读，读得到内容才算同一个地方） */
async function writeVia(path: string, content: string): Promise<void> {
  const env = new NodeExecutionEnv({ cwd });
  const tool = createWriteTool();
  const api = { env, callId: "c", output: () => undefined, diagnostic: () => undefined } as never;
  const result = (await tool.execute({ path, content } as never, api, BACKGROUND_CONTEXT)) as { isError?: boolean };
  assert.notEqual(result.isError, true, `write ${path} 失败`);
}

describe("toolTargetPath 与新内核的 write 工具落在同一个地方", () => {
  const forms = ["a.txt", "sub/deep/../b.txt", "@c.txt", "\u00A0d.txt", "e\u202Ff.txt", "@sub/g.txt"];
  for (const form of forms) {
    test(JSON.stringify(form), async () => {
      const content = `内容 ${form}`;
      await writeVia(form, content);
      assert.equal(await readFile(toolTargetPath(form, cwd), "utf8"), content);
    });
  }
  test("绝对路径与 file:// URL", async () => {
    const abs = join(cwd, "abs.txt");
    await writeVia(abs, "abs");
    assert.equal(await readFile(toolTargetPath(abs, cwd), "utf8"), "abs");
    const url = pathToFileURL(join(cwd, "url.txt")).href;
    await writeVia(url, "url");
    assert.equal(await readFile(toolTargetPath(url, cwd), "utf8"), "url");
  });
  test("~ 展开与 env 的 absolutePath 一致（不真往家目录写）", async () => {
    const env = new NodeExecutionEnv({ cwd });
    for (const form of ["~", "~/x/a.txt"]) {
      const result = await env.absolutePath(form, BACKGROUND_CONTEXT);
      assert.ok(result.ok);
      assert.equal(toolTargetPath(form, cwd), result.value, form);
    }
  });
});

describe("Windows 上 Git Bash 盘符写法的折算（平台注入）", () => {
  test("msysDrivePath：/c/…、/mnt/c/…、/cygdrive/c/… 折成盘符；大小写盘符统一大写", () => {
    assert.equal(msysDrivePath("/c/Users/x/a.ts"), "C:\\Users\\x\\a.ts");
    assert.equal(msysDrivePath("/D/work"), "D:\\work");
    assert.equal(msysDrivePath("/mnt/c/Users/x"), "C:\\Users\\x");
    assert.equal(msysDrivePath("/cygdrive/e/data/f.txt"), "E:\\data\\f.txt");
    assert.equal(msysDrivePath("/c"), "C:\\");
  });
  test("msysDrivePath：不是盘符写法的原样（UNC、带反斜杠、多字母首段、相对路径）", () => {
    for (const path of ["//server/share", "/c\\x", "/usr/local/bin", "/cc/x", "src/a.ts", "C:\\Users\\x", "~/x"]) {
      assert.equal(msysDrivePath(path), path, path);
    }
  });
  test("toolPathArgument：只在 win32 上折（macOS / Linux 上 /c 可能是真目录）；@ 与怪空格一起去掉", () => {
    assert.equal(toolPathArgument("/c/Users/x/a.ts", "win32"), "C:\\Users\\x\\a.ts");
    assert.equal(toolPathArgument("@/c/Users/x", "win32"), "C:\\Users\\x");
    assert.equal(toolPathArgument("/c/Users/x/a.ts", "darwin"), "/c/Users/x/a.ts");
    assert.equal(toolPathArgument("/c/Users/x/a.ts", "linux"), "/c/Users/x/a.ts");
    // 不是盘符写法：原样交给工具，工具自己规整
    assert.equal(toolPathArgument("@src/a.ts", "win32"), "@src/a.ts");
  });
  test("toolTargetPath（win32）：折算后按 Windows 规则解析；文件账、闸门与工具包装层同一个结果", () => {
    const winCwd = "C:\\work\\proj";
    assert.equal(toolTargetPath("/c/Users/x/a.ts", winCwd, { platform: "win32", home: "C:\\Users\\x" }), "C:\\Users\\x\\a.ts");
    assert.equal(toolTargetPath("src\\a.ts", winCwd, { platform: "win32", home: "C:\\Users\\x" }), "C:\\work\\proj\\src\\a.ts");
    assert.equal(toolTargetPath("~\\notes.md", winCwd, { platform: "win32", home: "C:\\Users\\x" }), "C:\\Users\\x\\notes.md");
    assert.equal(toolTargetPath("/c/Users/x/a.ts", "/proj", { platform: "darwin", home: "/Users/x" }), "/c/Users/x/a.ts");
  });
});
