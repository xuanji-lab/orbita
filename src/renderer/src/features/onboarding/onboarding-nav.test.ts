import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GUIDE } from "./onboarding-pages.ts";
import {
  boldRuns,
  chapterNumber,
  chapterProgress,
  chapterStart,
  flattenGuide,
  guideParts,
  isLastPage,
  shotTheme,
  shouldAutoOpenOnboarding,
  startIndexOfChapter,
  stepGuide,
} from "./onboarding-nav.ts";

/** 新手引导的翻页、跳章、进度段与「第一次才弹」 */

describe("flattenGuide / stepGuide：跨章连续翻页，越界夹回首尾", () => {
  const flat = flattenGuide(GUIDE);
  test("摊平后的页数 = 各章页数之和，顺序先章后页", () => {
    assert.equal(flat.length, GUIDE.reduce((sum, chapter) => sum + chapter.pages.length, 0));
    assert.deepEqual(flat[0], { chapter: 0, page: 0 });
    const lastChapter = GUIDE.length - 1;
    assert.deepEqual(flat.at(-1), { chapter: lastChapter, page: (GUIDE[lastChapter]?.pages.length ?? 0) - 1 });
  });

  test("下一页跨章：一章最后一页的下一页是下一章的章首页", () => {
    const firstLen = GUIDE[0]?.pages.length ?? 0;
    assert.deepEqual(flat[stepGuide(firstLen - 1, 1, flat.length)], { chapter: 1, page: 0 });
  });

  test("第一页没有上一页、最后一页没有下一页（夹住不动）", () => {
    assert.equal(stepGuide(0, -1, flat.length), 0);
    assert.equal(stepGuide(flat.length - 1, 1, flat.length), flat.length - 1);
    assert.equal(stepGuide(5, 0, 0), 0);
  });

  test("isLastPage 只在最后一页为真", () => {
    assert.equal(isLastPage(flat.length - 1, flat.length), true);
    assert.equal(isLastPage(flat.length - 2, flat.length), false);
  });
});

describe("chapterStart：目录点章名跳到那章第一页", () => {
  const flat = flattenGuide(GUIDE);
  test("跳到第 11 章（自动化）的章首页", () => {
    const automation = GUIDE.findIndex((chapter) => chapter.id === "automation");
    const index = chapterStart(flat, automation, 0);
    assert.deepEqual(flat[index], { chapter: automation, page: 0 });
    assert.equal(GUIDE[automation]?.pages[0]?.kind, "opener");
  });

  test("不存在的章：原地不动", () => {
    assert.equal(chapterStart(flat, 99, 7), 7);
  });
});

describe("chapterProgress：章首页不占进度段", () => {
  const automation = GUIDE.findIndex((chapter) => chapter.id === "automation");
  test("自动化一章 3 个步骤页 = 3 段；章首页时没有正在看的段，第 3 页亮第 3 段", () => {
    assert.deepEqual(chapterProgress(GUIDE, { chapter: automation, page: 0 }), { segments: 3, current: -1 });
    assert.deepEqual(chapterProgress(GUIDE, { chapter: automation, page: 3 }), { segments: 3, current: 2 });
  });

  test("没有章首页的常见问题：第一问就是第 1 段", () => {
    const faq = GUIDE.findIndex((chapter) => chapter.id === "faq");
    assert.deepEqual(chapterProgress(GUIDE, { chapter: faq, page: 0 }), { segments: 6, current: 0 });
  });
});

describe("shouldAutoOpenOnboarding：只在第一次打开时自动弹", () => {
  test("设置读回、没看过：弹", () => {
    assert.equal(shouldAutoOpenOnboarding(true, {}), true);
    assert.equal(shouldAutoOpenOnboarding(true, { onboardingSeen: false }), true);
  });

  test("看过 / 跳过过：不弹", () => {
    assert.equal(shouldAutoOpenOnboarding(true, { onboardingSeen: true }), false);
  });

  test("设置还没读回（手里是默认值）：不弹，免得看过的人也被当成第一次", () => {
    assert.equal(shouldAutoOpenOnboarding(false, {}), false);
  });
});

describe("shotTheme：截图跟主题走", () => {
  test("两档暗色用玄那套，浅色与纸面两档用浅色那套", () => {
    assert.equal(shotTheme("black"), "dark");
    assert.equal(shotTheme("graphite"), "dark");
    assert.equal(shotTheme("light"), "light");
    assert.equal(shotTheme("copybook"), "light");
    assert.equal(shotTheme("typescript"), "light");
  });
});

describe("boldRuns：正文里的 **粗体**", () => {
  test("切成普通 / 粗体交替的段，空段丢掉", () => {
    assert.deepEqual(boldRuns("跑过的**那天**一根柱"), [
      { text: "跑过的", bold: false },
      { text: "那天", bold: true },
      { text: "一根柱", bold: false },
    ]);
    assert.deepEqual(boldRuns("**全粗**"), [{ text: "全粗", bold: true }]);
  });
});

describe("设置 › 新手引导页签：点某章 → 全屏打开到那章首页", () => {
  const flat = flattenGuide(GUIDE);

  test("startIndexOfChapter：每一章都落在它自己的章首页（第 10 章 = 插件）", () => {
    for (const [ci, chapter] of GUIDE.entries()) {
      const index = startIndexOfChapter(GUIDE, chapter.id);
      assert.deepEqual(flat[index], { chapter: ci, page: 0 }, chapter.id);
    }
    const plugins = startIndexOfChapter(GUIDE, "plugins");
    assert.equal(GUIDE[flat[plugins]?.chapter ?? -1]?.id, "plugins");
    assert.equal(chapterNumber(GUIDE, flat[plugins]?.chapter ?? 0), "10");
  });

  test("从某章进入后 ← 仍能翻到上一章（落在上一章最后一页）；从头看是第 0 页", () => {
    const task = startIndexOfChapter(GUIDE, "task");
    const back = flat[stepGuide(task, -1, flat.length)];
    assert.equal(back?.chapter, 0);
    assert.equal(back?.page, (GUIDE[0]?.pages.length ?? 0) - 1);
    assert.equal(startIndexOfChapter(GUIDE, "start"), 0);
  });

  test("章 id 不认识时从头开始，不崩", () => {
    assert.equal(startIndexOfChapter(GUIDE, "nope" as never), 0);
    assert.equal(startIndexOfChapter([], "start"), 0);
  });

  test("guideParts：入门篇 7 / 进阶篇 6 / 附录 1，每章恰好出现一次，章号与引导目录同一套", () => {
    const parts = guideParts(GUIDE);
    assert.deepEqual(parts.map((group) => [group.part, group.chapters.length]), [["basics", 7], ["tools", 6], ["appendix", 1]]);
    assert.deepEqual(parts.flatMap((group) => group.chapters.map((chapter) => chapter.id)), GUIDE.map((chapter) => chapter.id));
    assert.equal(parts[0]?.chapters[0]?.no, "01");
    assert.equal(parts[1]?.chapters[0]?.no, "08");
    assert.equal(parts[2]?.chapters[0]?.no, "··");
  });
});
