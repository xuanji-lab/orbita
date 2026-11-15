/**
 * pandoc 探测：显式路径 → PATH → 常见根；版本过低时 supported:false 且给升级提示。
 * 全部注入假 fs / 假 --version，不依赖本机装没装 pandoc。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createPandocProbe, type PandocProbeDeps } from "./probe.ts";

function deps(overrides: Partial<PandocProbeDeps> & { existing?: string[]; versions?: Record<string, string> }): PandocProbeDeps {
  const existing = new Set(overrides.existing ?? []);
  const versions = overrides.versions ?? {};
  return {
    platform: overrides.platform ?? "win32",
    env: overrides.env ?? { PATH: "C:\\bin", ProgramFiles: "C:\\Program Files" },
    exists: (path) => existing.has(path),
    version: async (command) => versions[command] ?? null,
  };
}

describe("pandoc 探测", () => {
  test("显式路径优先，版本够就是 supported", async () => {
    const probe = createPandocProbe(
      deps({
        existing: ["C:\\pandoc-3.12.1\\pandoc.exe", "C:\\bin\\pandoc.exe"],
        versions: {
          "C:\\pandoc-3.12.1\\pandoc.exe": "pandoc 3.12.1",
          "C:\\bin\\pandoc.exe": "pandoc 3.9",
        },
      }),
    );
    const result = await probe.probe("C:\\pandoc-3.12.1\\pandoc.exe");
    assert.equal(result.ok, true);
    assert.equal(result.path, "C:\\pandoc-3.12.1\\pandoc.exe");
    assert.equal(result.versionText, "3.12.1");
    assert.equal(result.supported, true);
  });

  test("显式路径坏了 → 回退 PATH，不把导出变成死路", async () => {
    const probe = createPandocProbe(
      deps({
        existing: ["C:\\bin\\pandoc.exe"],
        versions: { "C:\\bin\\pandoc.exe": "pandoc 3.12.1" },
      }),
    );
    const result = await probe.probe("D:\\missing\\pandoc.exe");
    assert.equal(result.ok, true);
    assert.equal(result.path, "C:\\bin\\pandoc.exe");
  });

  test("3.9 → ok 但 supported:false，消息里说清要 3.10.2", async () => {
    const probe = createPandocProbe(
      deps({ existing: ["C:\\bin\\pandoc.exe"], versions: { "C:\\bin\\pandoc.exe": "pandoc 3.9" } }),
    );
    const result = await probe.probe();
    assert.equal(result.ok, true);
    assert.equal(result.supported, false);
    assert.match(result.message, /too old/);
    assert.match(result.message, /3\.10\.2/);
  });

  test("PATH 没有就看常见根（Program Files）", async () => {
    const probe = createPandocProbe(
      deps({
        existing: ["C:\\Program Files\\Pandoc\\pandoc.exe"],
        versions: { "C:\\Program Files\\Pandoc\\pandoc.exe": "pandoc 3.12.1" },
      }),
    );
    const result = await probe.probe();
    assert.equal(result.ok, true);
    assert.equal(result.path, "C:\\Program Files\\Pandoc\\pandoc.exe");
  });

  test("完全找不到：ok:false + searched 列出找过的目录", async () => {
    const probe = createPandocProbe(deps({ existing: [] }));
    const result = await probe.probe();
    assert.equal(result.ok, false);
    assert.equal(result.path, null);
    assert.equal(result.supported, false);
    assert.match(result.message, /not found/);
    assert.ok(result.searched.includes("C:\\bin"));
  });

  test("缓存按显式路径分键；refresh 后重探", async () => {
    let calls = 0;
    const probe = createPandocProbe({
      platform: "win32",
      env: { PATH: "C:\\bin" },
      exists: (path) => path === "C:\\bin\\pandoc.exe",
      version: async () => {
        calls += 1;
        return "pandoc 3.12.1";
      },
    });
    await probe.probe();
    await probe.probe();
    assert.equal(calls, 1);
    probe.refresh();
    await probe.probe();
    assert.equal(calls, 2);
  });

  test("POSIX 平台按冒号拆 PATH，并看 /usr/local/bin", async () => {
    const probe = createPandocProbe(
      deps({
        platform: "linux",
        env: { PATH: "/usr/bin:/opt/tools" },
        existing: ["/opt/tools/pandoc"],
        versions: { "/opt/tools/pandoc": "pandoc 3.12.1" },
      }),
    );
    const result = await probe.probe();
    assert.equal(result.ok, true);
    assert.equal(result.path, "/opt/tools/pandoc");
  });
});
