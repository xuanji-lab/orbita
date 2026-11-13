/**
 * 找 Zotero 数据目录的账：prefs.js 设了数据目录 / 没设走 ~/Zotero / 都没有；ORBITA_ZOTERO_DATA_DIR 打包版不认；
 * 各平台的 profile 根目录（Windows 只验路径拼法，未在 Windows 实测）。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { dataDirOverride, defaultProfilePath, findZoteroDataDir, profileRoot, readPref } from "./data-dir.ts";
import { writeTestProfile } from "./test-library.ts";

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "orbita-zotero-dir-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function fakeDataDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "zotero.sqlite"), "");
  return dir;
}

describe("找 Zotero 数据目录", () => {
  test("prefs.js 里 useDataDir=true + dataDir：用它；baseAttachmentPath 一并读出（中文与空格路径照常）", async () => {
    const home = join(root, "h1");
    const custom = fakeDataDir(join(root, "云盘 个人", "zotero"));
    writeTestProfile(join(home, "Library", "Application Support", "Zotero"), {
      "extensions.zotero.dataDir": custom,
      "extensions.zotero.useDataDir": true,
      "extensions.zotero.baseAttachmentPath": "/Users/x/论文",
    });
    const { found } = await findZoteroDataDir({ home, platform: "darwin", packaged: true });
    assert.deepEqual(found, { dir: custom, database: join(custom, "zotero.sqlite"), baseAttachmentPath: "/Users/x/论文", source: "prefs" });
  });

  test("设了 dataDir 但 useDataDir 不是 true：照 Zotero 的规则不用它，走默认 ~/Zotero", async () => {
    const home = join(root, "h2");
    fakeDataDir(join(root, "elsewhere"));
    fakeDataDir(join(home, "Zotero"));
    writeTestProfile(join(home, "Library", "Application Support", "Zotero"), { "extensions.zotero.dataDir": join(root, "elsewhere") });
    const { found } = await findZoteroDataDir({ home, platform: "darwin", packaged: true });
    assert.equal(found?.dir, join(home, "Zotero"));
    assert.equal(found?.source, "default");
  });

  test("都没有：found 为 null，tried 列出找过的位置", async () => {
    const home = join(root, "h3");
    const result = await findZoteroDataDir({ home, platform: "darwin", packaged: true });
    assert.equal(result.found, null);
    assert.deepEqual(result.tried, [join(home, "Zotero")]);
  });

  test("ORBITA_ZOTERO_DATA_DIR：开发版用它；打包版不认（照 devDataDirs 的 packaged 判定）", async () => {
    const home = join(root, "h4");
    const dev = fakeDataDir(join(root, "dev-zotero"));
    fakeDataDir(join(home, "Zotero"));
    assert.equal((await findZoteroDataDir({ home, platform: "darwin", packaged: false, override: dev })).found?.source, "override");
    const packaged = await findZoteroDataDir({ home, platform: "darwin", packaged: true, override: dev });
    assert.equal(packaged.found?.dir, join(home, "Zotero"));
    assert.equal(packaged.found?.source, "default");
    assert.equal(dataDirOverride({ packaged: true, override: dev }), null);
    assert.equal(dataDirOverride({ packaged: false, override: "  " }), null);
  });

  test("profile 根目录：macOS / Windows（%APPDATA%\\Zotero\\Zotero，未实测）/ Linux", () => {
    assert.equal(profileRoot({ home: "/Users/a", platform: "darwin", packaged: true }), join("/Users/a", "Library", "Application Support", "Zotero"));
    assert.equal(profileRoot({ home: "C:\\Users\\a", platform: "win32", appData: "C:\\Users\\a\\AppData\\Roaming", packaged: true }), join("C:\\Users\\a\\AppData\\Roaming", "Zotero", "Zotero"));
    assert.equal(profileRoot({ home: "C:\\Users\\a", platform: "win32", packaged: true }), null);
    assert.equal(profileRoot({ home: "/home/a", platform: "linux", packaged: true }), join("/home/a", ".zotero", "zotero"));
  });

  test("profiles.ini 取 Default=1 那节（没有就第一节）；prefs.js 的字符串转义与布尔", () => {
    const ini = "[General]\nStartWithLastProfile=1\n\n[Profile1]\nName=b\nIsRelative=1\nPath=Profiles/b.other\n\n[Profile0]\nName=a\nIsRelative=1\nPath=Profiles/a.default\nDefault=1\n";
    assert.equal(defaultProfilePath(ini, "/r"), join("/r", "Profiles", "a.default"));
    assert.equal(defaultProfilePath("[Profile0]\nIsRelative=0\nPath=/abs/p\n", "/r"), "/abs/p");
    const prefs = 'user_pref("extensions.zotero.dataDir", "C:\\\\Users\\\\a\\\\Zotero \\"x\\"");\nuser_pref("extensions.zotero.useDataDir", true);\n';
    assert.equal(readPref(prefs, "extensions.zotero.dataDir"), 'C:\\Users\\a\\Zotero "x"');
    assert.equal(readPref(prefs, "extensions.zotero.useDataDir"), true);
    assert.equal(readPref(prefs, "extensions.zotero.missing"), null);
  });
});
