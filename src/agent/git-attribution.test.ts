import { describe, it } from "node:test";
import { doesNotMatch, equal, match, ok } from "node:assert/strict";
import { gitAttributionGuideline } from "./git-attribution.ts";
import { COMMIT_TRAILER, LEGACY_COMMIT_TRAILER } from "../shared/attribution.ts";

const BOT_ADDRESS = "356826154+xuanji-orbita[bot]@users.noreply.github.com";

describe("gitAttributionGuideline", () => {
  it("开：讲清 trailer 全文（Co-authored-by + bot 地址）与 PR 描述里的链接", () => {
    const text = gitAttributionGuideline(true);
    equal(COMMIT_TRAILER, `Co-authored-by: Orbita <${BOT_ADDRESS}>`);
    ok(text.includes(COMMIT_TRAILER));
    match(text, /\[Orbita\]\(https:\/\/github\.com\/XIAOZF99\/orbita\)/);
  });

  it("开：只加一行共作者、不改 author/committer；不再把 Co-Authored-By 当禁区", () => {
    const text = gitAttributionGuideline(true);
    match(text, /second co-author line/i);
    match(text, /do not change the author or committer/i);
    doesNotMatch(text, /do not use `Co-Authored-By`/i);
  });

  it("开：强调唯一性，老写法也算已署名，且用户当次拒绝优先", () => {
    const text = gitAttributionGuideline(true);
    match(text, /already carries the line/i);
    ok(text.includes(LEGACY_COMMIT_TRAILER));
    match(text, /counts as already signed/i);
    match(text, /if the user says not to add it/i);
  });

  it("关：空串——调用方按空串跳过，不在提示词里留一段空标签", () => {
    equal(gitAttributionGuideline(false), "");
  });

  it("开时是一段带标签的块，与其他注入段同形", () => {
    const text = gitAttributionGuideline(true);
    ok(text.startsWith("<orbita-git-attribution>"));
    ok(text.endsWith("</orbita-git-attribution>"));
  });

  it("中文界面：PR 那一行写中文；commit trailer 仍是一字不改的英文", () => {
    const text = gitAttributionGuideline(true, "zh");
    match(text, /append a single `使用 \[Orbita\]\(https:\/\/github\.com\/XIAOZF99\/orbita\) 制作` line/);
    ok(text.includes(`\`${COMMIT_TRAILER}\` trailer`));
    match(text, /read by GitHub, not by humans/);
  });

  it("去重认两种写法：中英切换过的仓库里不会一英一中各一行", () => {
    for (const language of ["en", "zh"] as const) {
      const text = gitAttributionGuideline(true, language);
      match(text, /either `Made with \[Orbita\]/);
      match(text, /`使用 \[Orbita\]/);
    }
  });

  it("不传语言就是英文（语言设置之前的行为）", () => {
    equal(gitAttributionGuideline(true), gitAttributionGuideline(true, "en"));
  });
});
