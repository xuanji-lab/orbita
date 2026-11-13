import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { enRevealLabel, enTrashName, fileManagerKind, zhRevealLabel, zhTrashName } from "./file-manager.ts";
import { en } from "./messages-en.ts";
import { zh } from "./messages-zh.ts";

describe("文件管理器 / 垃圾桶的平台叫法", () => {
  test("process.platform 归成三类", () => {
    assert.equal(fileManagerKind("darwin"), "finder");
    assert.equal(fileManagerKind("win32"), "explorer");
    assert.equal(fileManagerKind("linux"), "files");
    assert.equal(fileManagerKind("freebsd"), "files");
  });

  test("macOS：访达 / 废纸篓（改动前的口径不变）", () => {
    assert.equal(zhRevealLabel("finder"), "在访达中显示");
    assert.equal(enRevealLabel("finder"), "Show in Finder");
    assert.equal(zhTrashName("finder"), "废纸篓");
    assert.equal(enTrashName("finder"), "Trash");
    assert.equal(zh.plugins.skillTrashHint("finder"), "移到废纸篓，可以从废纸篓找回；所有工作区都不再加载它。");
    assert.equal(en.plugins.skillTrashHint("finder"), "Moved to the Trash, where you can get it back; no workspace loads it any more.");
  });

  test("Windows：资源管理器 / 回收站", () => {
    assert.equal(zh.plugins.revealInManager("explorer"), "在资源管理器中显示");
    assert.equal(en.plugins.revealInManager("explorer"), "Show in Explorer");
    assert.match(zh.plugins.skillTrashHint("explorer"), /^移到回收站，可以从回收站找回/);
    assert.match(en.plugins.skillTrashHint("explorer"), /^Moved to the Recycle Bin/);
    assert.match(zh.plugins.legacySkillNote("/x", "explorer"), /「在资源管理器中显示」/);
    assert.match(en.plugins.legacySkillNote("/x", "explorer"), /"Show in Explorer"/);
  });

  test("Linux：文件管理器 / 回收站（Trash）", () => {
    assert.equal(zh.plugins.revealInManager("files"), "在文件管理器中显示");
    assert.equal(en.plugins.revealInManager("files"), "Show in File Manager");
    assert.match(zh.plugins.skillTrashHint("files"), /回收站/);
    assert.match(en.plugins.skillTrashHint("files"), /the Trash/);
  });

  test("非 macOS 的任何文案里不出现访达 / 废纸篓 / Finder", () => {
    for (const kind of ["explorer", "files"] as const) {
      const texts = [
        zh.plugins.revealInManager(kind),
        zh.plugins.skillTrashHint(kind),
        zh.plugins.legacySkillNote("/x", kind),
        en.plugins.revealInManager(kind),
        en.plugins.skillTrashHint(kind),
        en.plugins.legacySkillNote("/x", kind),
      ];
      for (const text of texts) assert.doesNotMatch(text, /访达|废纸篓|Finder/);
    }
  });
});
