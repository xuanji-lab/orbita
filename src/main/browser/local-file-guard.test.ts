/**
 * #365 的回归测试（Chromium 层）：本地网页经白名单入口打开之后，页面自己 fetch / iframe /
 * 跳转到 file:// 的请求，也必须 realpath 后落在放行根里。
 *
 * 单测（local-file.test.ts）只验判定函数；闸靠的是 Electron 对 file:// 请求触发
 * webRequest.onBeforeRequest——这一点只有真 Chromium 能证明，Electron 升级若改了这个行为，
 * 单测全绿而闸已失效。所以这里起一个隐藏的 Electron（local-file-guard.electron.cjs）跑同一页两遍：
 * 没装闸的那遍证明夹具真的会泄漏（前提），装了产品闸的那遍证明拦住了、根内资源照常。
 *
 * 跳过：装依赖时没下 Electron 二进制、Linux 上没有显示服务器（跑不起 Chromium）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** node_modules/electron 的二进制（同 electron 包 index.js 的解析：dist/ + path.txt） */
function electronBinary(): string | null {
  try {
    const pkg = createRequire(import.meta.url).resolve("electron/package.json");
    const relative = readFileSync(join(dirname(pkg), "path.txt"), "utf8").trim();
    const binary = join(dirname(pkg), "dist", relative);
    return existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

interface ProbeRun {
  page: Record<string, string | boolean>;
  afterNav: string;
  mainLoad: string;
}

function runProbe(binary: string): Promise<{ unguarded: ProbeRun; guarded: ProbeRun }> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      [join(here, "local-file-guard.electron.cjs")],
      // 探针自己 25 秒看门狗；这里再兜一层，卡死也不拖住整套测试
      { timeout: 30_000, env: { ...process.env, ELECTRON_ENABLE_LOGGING: "0" } },
      (error, stdout) => {
        const line = stdout.split("\n").find((item) => item.startsWith("RESULT "));
        if (line === undefined) {
          reject(new Error(`探针没有输出结果：${error?.message ?? ""}\n${stdout}`));
          return;
        }
        const parsed = JSON.parse(line.slice("RESULT ".length)) as { unguarded?: ProbeRun; guarded?: ProbeRun; error?: string };
        if (parsed.error !== undefined || parsed.unguarded === undefined || parsed.guarded === undefined) {
          reject(new Error(`探针出错：${parsed.error ?? line}`));
          return;
        }
        resolve({ unguarded: parsed.unguarded, guarded: parsed.guarded });
      },
    );
  });
}

test("本地网页打开之后：根外与穿过 junction 的 file:// 一律拦下，根内资源照常（真 Chromium）", async (t) => {
  const binary = electronBinary();
  if (binary === null) return t.skip("没有 Electron 二进制（node_modules/electron 未装全）");
  if (process.platform === "linux" && process.env["DISPLAY"] === undefined && process.env["WAYLAND_DISPLAY"] === undefined) {
    return t.skip("Linux 上没有显示服务器，起不了 Chromium");
  }
  const { unguarded, guarded } = await runProbe(binary);
  const leaks = (run: ProbeRun): string[] =>
    ["fetchAbs", "fetchRel", "iframe_abs", "iframe_rel"].filter((key) => String(run.page[key]).includes("OUTSIDE-SECRET"));

  // 前提：不设防时这份夹具四种方式都读得到根外——否则下面「读不到」不说明任何事
  assert.deepEqual(leaks(unguarded), ["fetchAbs", "fetchRel", "iframe_abs", "iframe_rel"], JSON.stringify(unguarded));
  assert.ok(unguarded.afterNav.includes("OUTSIDE-SECRET"), `不设防时页面应能跳到根外：${unguarded.afterNav}`);

  // 装了产品闸：四种方式都读不到，跳转与主进程加载也被拦
  assert.deepEqual(leaks(guarded), [], JSON.stringify(guarded));
  assert.ok(!guarded.afterNav.includes("OUTSIDE-SECRET"), `页面跳到根外后仍读到了：${guarded.afterNav}`);
  assert.match(guarded.mainLoad, /ERR_BLOCKED_BY_CLIENT/);
  // 根内照常：同目录子资源（fetch / iframe / script）不被一起拦掉
  assert.equal(guarded.page["fetchOk"], "INSIDE-OK");
  assert.equal(guarded.page["iframe_ok"], "INSIDE-OK");
  assert.equal(guarded.page["scriptRan"], true);
});
