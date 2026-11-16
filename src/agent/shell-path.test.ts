/**
 * bash 路径探测（A2）。真源与理由见 ./shell-path.ts。
 *
 * 这里钉三件事：找到就缓存（这是收益的全部）、**找不到不缓存**（用户中途装好 Git Bash
 * 下一轮要能用上）、以及默认的可用性判据会把 pi 的裸名兜底（POSIX 的 `sh`）挡在外面——
 * 那个值当 shellPath 传回去会让 pi 抛「Custom shell path not found」，本来能跑的机器
 * 反而不跑了。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createShellPathResolver, findBash } from "./shell-path.ts";

describe("createShellPathResolver", () => {
  test("探到就缓存：pi 那套查找只跑一次（收益的全部）", () => {
    let calls = 0;
    const resolve = createShellPathResolver(
      () => {
        calls += 1;
        return "/usr/bin/bash";
      },
      () => true,
    );
    assert.equal(resolve(), "/usr/bin/bash");
    assert.equal(resolve(), "/usr/bin/bash");
    assert.equal(resolve(), "/usr/bin/bash");
    assert.equal(calls, 1, "第二次以后不许再探");
  });

  test("**找不到不缓存**：探不到就每轮重试，装好 Git Bash 下一轮即生效", () => {
    let calls = 0;
    // 每一轮探测依次回一个脚本化的答案；用光之后一直是「探不到」
    const scripted: (string | undefined)[] = [undefined, undefined, "/usr/bin/bash"];
    const resolve = createShellPathResolver(
      () => {
        calls += 1;
        return scripted.shift();
      },
      () => true,
    );
    assert.equal(resolve(), undefined, "第一轮没有");
    assert.equal(resolve(), undefined, "第二轮仍然没有——所以又探了一次");
    assert.equal(resolve(), "/usr/bin/bash", "第三轮探到了");
    assert.equal(calls, 3, "前两次都不许缓存");
    assert.equal(resolve(), "/usr/bin/bash");
    assert.equal(calls, 3, "探到之后才缓存");
  });

  test("探到但不可用 → 不缓存、当没有", () => {
    let calls = 0;
    const resolve = createShellPathResolver(
      () => {
        calls += 1;
        return "sh";
      },
      () => false,
    );
    assert.equal(resolve(), undefined);
    assert.equal(resolve(), undefined);
    assert.equal(calls, 2, "不可用的结果不许进缓存");
  });

  test("默认判据：绝对路径且存在才算数", () => {
    const resolve = createShellPathResolver(() => process.execPath);
    assert.equal(resolve(), process.execPath, "node 自己就是绝对且存在的");

    // 裸名 `sh` 交下去，执行环境找不到它
    const bare = createShellPathResolver(() => "sh");
    assert.equal(bare(), undefined, "裸名不能当 shellPath");

    const missing = createShellPathResolver(() => join(process.cwd(), "no-such-bash-xyz"));
    assert.equal(missing(), undefined, "绝对但不存在也不行");
  });

  /** 装了 / 没装都必须只是「探到」或「探不到」，不许把异常抛出去把开轮打断 */
  test("默认探测不抛：装了 Git Bash 给绝对路径，没装给 undefined", () => {
    const resolve = createShellPathResolver();
    const result = resolve();
    if (result !== undefined) {
      assert.ok(result.length > 0, "探到的必须是非空路径");
    }
  });
});

describe("findBash 的查找顺序", () => {
  const has = (paths: string[]) => (path: string) => paths.includes(path);

  test("Windows：Program Files 的 Git Bash 先于 PATH", () => {
    const env = { ProgramFiles: "C:\\Program Files", PATH: "D:\\scoop\\git\\bin" };
    assert.equal(findBash("win32", env, has(["C:\\Program Files\\Git\\bin\\bash.exe", "D:\\scoop\\git\\bin\\bash.exe"])), "C:\\Program Files\\Git\\bin\\bash.exe");
    assert.equal(findBash("win32", env, has(["D:\\scoop\\git\\bin\\bash.exe"])), "D:\\scoop\\git\\bin\\bash.exe");
  });

  test("Windows：跳过 System32 的旧式 WSL bash，接着找 PATH 后面的", () => {
    const env = { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32;E:\\msys64\\usr\\bin" };
    const files = ["C:\\Windows\\System32\\bash.exe", "E:\\msys64\\usr\\bin\\bash.exe"];
    assert.equal(findBash("win32", env, has(files)), "E:\\msys64\\usr\\bin\\bash.exe");
    assert.equal(findBash("win32", env, has([files[0] as string])), undefined);
  });

  test("其它平台：/bin/bash 先于 PATH，都没有给 undefined", () => {
    assert.equal(findBash("darwin", { PATH: "/opt/homebrew/bin" }, has(["/bin/bash", "/opt/homebrew/bin/bash"])), "/bin/bash");
    assert.equal(findBash("linux", { PATH: "/usr/local/bin:/usr/bin" }, has(["/usr/bin/bash"])), "/usr/bin/bash");
    assert.equal(findBash("linux", { PATH: "/usr/bin" }, has([])), undefined);
  });
});
