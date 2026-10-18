/**
 * 「本版更新内容」落盘与读回（updater/current-notes.ts）的测试。
 *
 * 读写分两条路：写发生在 `update-downloaded`（安装包下完那一刻），读发生在启动时。
 * 读的一侧**一律不抛错**是这条功能的全部要点：它是设置页上一行可有可无的说明，
 * 文件坏了不该让更新卡整块画不出来。所以这里钉：正常路径、版本不一致、文件不存在、
 * JSON 坏了、形状不对（手写 / 半截文件）、单条不合格。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_NOTES_FILE, readCurrentNotes, saveCurrentNotes } from "./current-notes.ts";

const NOTES = [
  { icon: "download", text: "Windows 自动更新：后台检查，确认后才下载。" },
  { icon: null, text: "修了几个窄窗口下的对齐问题。" },
] as const;

/** 每个用例一个临时 userData：写进去的东西互不干扰，也不碰真实 userData */
async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "orbita-update-notes-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("本版更新内容 —— 写与读", () => {
  test("写进去的形状是 { version, releaseNotes }，原子写到目标文件", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, CURRENT_NOTES_FILE);
      await saveCurrentNotes(file, "0.1.16", NOTES);
      const written: unknown = JSON.parse(await readFile(file, "utf8"));
      assert.deepEqual(written, { version: "0.1.16", releaseNotes: NOTES });
      // 临时文件不留在盘上（临时文件 + rename 的收尾）
      assert.deepEqual(await readdir(dir), [CURRENT_NOTES_FILE]);
    });
  });

  test("版本号对得上：读回同一份说明", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, CURRENT_NOTES_FILE);
      await saveCurrentNotes(file, "0.1.16", NOTES);
      assert.deepEqual(await readCurrentNotes(file, "0.1.16"), NOTES);
    });
  });

  test("版本号对不上（盘上存的是别的版本）：返回 null，不显示", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, CURRENT_NOTES_FILE);
      // 已下载 0.1.16、此刻还跑在 0.1.15 上：那是「下一个版本」的说明，不是本版的
      await saveCurrentNotes(file, "0.1.16", NOTES);
      assert.equal(await readCurrentNotes(file, "0.1.15"), null);
    });
  });

  test("存的是「这一版没有说明」（releaseNotes 为 null）：读回 null", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, CURRENT_NOTES_FILE);
      await saveCurrentNotes(file, "0.1.16", null);
      assert.equal(await readCurrentNotes(file, "0.1.16"), null);
    });
  });

  test("文件不存在（没更新过的机器）：返回 null，不抛错", async () => {
    await withTempDir(async (dir) => {
      assert.equal(await readCurrentNotes(join(dir, "never-written.json"), "0.1.15"), null);
    });
  });

  test("JSON 坏了（半截文件）：返回 null，不崩", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, CURRENT_NOTES_FILE);
      await writeFile(file, '{"version":"0.1.15","releaseNotes":[{"icon":"down', "utf8");
      assert.equal(await readCurrentNotes(file, "0.1.15"), null);
    });
  });

  test("形状不对：不是对象 / 版本号不是字符串 / releaseNotes 不是数组，都当没有", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, CURRENT_NOTES_FILE);
      for (const body of ["[1,2,3]", '"0.1.15"', "null", '{"releaseNotes":"一条"}', '{"version":15,"releaseNotes":[]}']) {
        await writeFile(file, body, "utf8");
        assert.equal(await readCurrentNotes(file, "0.1.15"), null, body);
      }
    });
  });

  test("数组里混了坏条目：坏的那条丢掉，好的照旧显示", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, CURRENT_NOTES_FILE);
      const body = JSON.stringify({
        version: "0.1.15",
        releaseNotes: [
          { icon: "download", text: "一条好的" },
          { icon: 7, text: "图标不是字符串" },
          { text: "" },
          "不是对象",
          { icon: null, text: "另一条好的" },
        ],
      });
      await writeFile(file, body, "utf8");
      assert.deepEqual(await readCurrentNotes(file, "0.1.15"), [
        { icon: "download", text: "一条好的" },
        { icon: null, text: "另一条好的" },
      ]);
    });
  });
});
