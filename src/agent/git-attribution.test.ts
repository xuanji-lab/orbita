import { describe, it } from "node:test";
import { equal, match, ok } from "node:assert/strict";
import { gitAttributionGuideline } from "./git-attribution.ts";

describe("gitAttributionGuideline", () => {
  it("开：讲清 trailer 长什么样，以及 PR 描述里的链接", () => {
    const text = gitAttributionGuideline(true);
    match(text, /Made-with: Orbita/);
    match(text, /\[Orbita\]\(https:\/\/github\.com\/XIAOZF99\/orbita\)/);
  });

  it("开：明说不要 Co-Authored-By、不要改 author——那会污染贡献统计", () => {
    const text = gitAttributionGuideline(true);
    match(text, /Co-Authored-By/);
    match(text, /do not change the author/i);
  });

  it("开：强调唯一性，且用户当次拒绝优先", () => {
    const text = gitAttributionGuideline(true);
    match(text, /already carries the line/i);
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

  it("中文界面：PR 那一行写中文；commit trailer 仍是 git 认得的英文键", () => {
    const text = gitAttributionGuideline(true, "zh");
    match(text, /append a single `使用 \[Orbita\]\(https:\/\/github\.com\/XIAOZF99\/orbita\) 制作` line/);
    match(text, /`Made-with: Orbita` trailer/);
    match(text, /git only parses ASCII trailer keys/);
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
