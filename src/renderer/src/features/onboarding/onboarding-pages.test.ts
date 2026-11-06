import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";
import { CHAPTER_IDS, GUIDE, MISSING_BOXES, SHOT_IDS, type Box, type GuidePage } from "./onboarding-pages.ts";

/**
 * 新手引导数据表的自洽：章与页对得上用户认可的章节稿（chapters-v3）、每页都有中英文案、
 * 编号点与配文条数一致、框与放大镜落在截图里、用到的截图浅色 / 玄两套都在且不过大。
 */

const HERE = dirname(fileURLToPath(import.meta.url));

describe("章与页：照章节稿第三版", () => {
  test("入门篇 7 章、进阶篇 6 章、附一章常见问题，顺序与 CHAPTER_IDS 一致", () => {
    assert.deepEqual(GUIDE.map((chapter) => chapter.id), [...CHAPTER_IDS]);
    assert.equal(GUIDE.filter((chapter) => chapter.part === "basics").length, 7);
    assert.equal(GUIDE.filter((chapter) => chapter.part === "tools").length, 6);
    assert.deepEqual(GUIDE.filter((chapter) => chapter.part === "appendix").map((chapter) => chapter.id), ["faq"]);
  });

  test("每章步骤页数照章节稿（第 13 章的虚线页先不做：3 页）；常见问题约 6 问", () => {
    const steps = Object.fromEntries(GUIDE.map((chapter) => [chapter.id, chapter.pages.filter((page) => page.kind !== "opener").length]));
    assert.deepEqual(steps, {
      start: 4, task: 4, progress: 3, files: 3, quote: 4, subsessions: 4, memory: 3,
      terminal: 2, browser: 2, plugins: 4, automation: 3, board: 2, focus: 3, faq: 6,
    });
  });

  test("除常见问题外每章以章首页开头，章首页只有一个；常见问题全是问答页", () => {
    for (const chapter of GUIDE) {
      const openers = chapter.pages.filter((page) => page.kind === "opener");
      if (chapter.id === "faq") {
        assert.equal(openers.length, 0);
        assert.ok(chapter.pages.every((page) => page.kind === "faq"));
      } else {
        assert.equal(openers.length, 1, chapter.id);
        assert.equal(chapter.pages[0]?.kind, "opener", chapter.id);
      }
    }
  });

  test("章内页 id 不重复", () => {
    for (const chapter of GUIDE) {
      const ids = chapter.pages.map((page) => page.id);
      assert.equal(new Set(ids).size, ids.length, chapter.id);
    }
  });
});

describe("文案：每页中英都有，编号与配文对得上", () => {
  for (const [lang, table] of [["zh", zh], ["en", en]] as const) {
    test(`${lang}：每章有名字，每个非章首页有页名、标题、正文；带 say 的页有样例句`, () => {
      for (const chapter of GUIDE) {
        const copy = table.onboarding.chapters[chapter.id];
        assert.ok(copy.name !== "", `${lang} ${chapter.id} 缺章名`);
        const pages = copy.pages as Record<string, { name: string; title: string; body: string; notes?: readonly string[]; say?: string } | undefined>;
        for (const page of chapter.pages) {
          if (page.kind === "opener") continue;
          const text = pages[page.id];
          assert.ok(text !== undefined, `${lang} ${chapter.id}.${page.id} 没有文案`);
          assert.ok(text.name !== "" && text.title !== "" && text.body !== "", `${lang} ${chapter.id}.${page.id} 有空字段`);
          if (page.kind === "step" && page.say === true) assert.ok((text.say ?? "") !== "", `${lang} ${chapter.id}.${page.id} 缺 say`);
          if (page.kind === "step" && page.pins !== undefined) {
            const numbers = new Set([...page.pins, ...(page.loupe?.pins ?? [])].map((pin) => pin.n));
            assert.equal(text.notes?.length ?? 0, numbers.size, `${lang} ${chapter.id}.${page.id}：编号 ${numbers.size} 个、配文 ${text.notes?.length ?? 0} 条`);
            assert.deepEqual([...numbers].sort(), Array.from({ length: numbers.size }, (_, i) => i + 1), `${chapter.id}.${page.id} 编号要从 1 连续`);
          }
        }
        // 表里没有的页不该有文案（删页时连文案一起删）
        const known = new Set(chapter.pages.map((page) => page.id));
        for (const id of Object.keys(pages)) assert.ok(known.has(id), `${lang} ${chapter.id}.${id} 是多出来的文案`);
      }
    });
  }
});

const inUnit = (box: Box): boolean => box.x >= 0 && box.y >= 0 && box.w > 0 && box.h > 0 && box.x + box.w <= 1.0001 && box.y + box.h <= 1.0001;

describe("几何：框、编号点、放大镜都落在截图里", () => {
  test("数据表引用的框都量到了（scripts/onboarding-shots/capture.mjs 写进 shot-boxes.ts）", () => {
    assert.deepEqual(MISSING_BOXES, [], `这些框没量到，重拍或改 scenes.mjs 的 measure：${MISSING_BOXES.join(", ")}`);
  });

  test("focus 与放大镜的来源块在 0–1 之内；编号点在截图框附近（放大镜可越出右下缘）", () => {
    for (const chapter of GUIDE) {
      for (const page of chapter.pages as readonly GuidePage[]) {
        if (page.kind !== "step") continue;
        const where = `${chapter.id}.${page.id}`;
        if (page.focus !== undefined) assert.ok(inUnit(page.focus), `${where} focus 越界`);
        for (const pin of page.pins ?? []) assert.ok(pin.x >= -0.05 && pin.x <= 1.05 && pin.y >= -0.05 && pin.y <= 1.05, `${where} 编号点越界`);
        if (page.loupe !== undefined) {
          assert.ok(inUnit(page.loupe.from), `${where} 放大镜来源越界`);
          assert.ok(page.loupe.scale >= 1, `${where} 放大镜倍数 < 1`);
          for (const pin of page.loupe.pins ?? []) assert.ok(pin.x >= 0 && pin.x <= 1 && pin.y >= 0 && pin.y <= 1, `${where} 放大镜上的编号点越界`);
        }
      }
    }
  });
});

describe("截图资源：用到的浅色 / 玄两套都在，单张不过大", () => {
  const used = new Set(GUIDE.flatMap((chapter) => chapter.pages.flatMap((page) => (page.kind === "faq" ? [] : [page.shot]))));
  test("数据表用到的截图 id 都在 SHOT_IDS 里，SHOT_IDS 里没有没人用的", () => {
    assert.deepEqual([...used].sort(), [...SHOT_IDS].sort());
  });

  for (const set of ["light", "dark"] as const) {
    test(`${set}：每张截图都在，单张 ≤ 220 KB`, () => {
      for (const id of used) {
        const path = join(HERE, "shots", set, `${id}.webp`);
        assert.ok(existsSync(path), `缺 shots/${set}/${id}.webp`);
        assert.ok(statSync(path).size <= 220 * 1024, `shots/${set}/${id}.webp 超过 220 KB`);
      }
    });
  }
});
