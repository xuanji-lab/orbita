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
});
