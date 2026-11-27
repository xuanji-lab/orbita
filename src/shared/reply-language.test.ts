import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { detectReplyLang, isReplyLang, replyLanguageNote } from "./reply-language.ts";

describe("detectReplyLang", () => {
  it("纯中文 → zh；纯英文 → en", () => {
    strictEqual(detectReplyLang("派个子会话去读一下 README"), "zh");
    strictEqual(detectReplyLang("为什么你跟子会话沟通多了以后就会变成英文了？"), "zh");
    strictEqual(detectReplyLang("Please read the README and tell me what this project does"), "en");
  });

  it("中英混排：汉字数 ≥ 拉丁单词数 → zh，否则 en（阈值 0.5）", () => {
    strictEqual(detectReplyLang("帮我 review 一下这个 PR"), "zh");
    strictEqual(detectReplyLang("Check why 子会话 is English"), "en");
    strictEqual(detectReplyLang("Fix 这个 bug please"), "en");
    // 恰好相等：汉字 2 = 单词 2 → zh
    strictEqual(detectReplyLang("好的 ok yes"), "zh");
    strictEqual(detectReplyLang("ok 谢谢"), "zh");
  });

  it("代码块、行内代码、URL 与路径不算英文：中文句子里夹一大段命令仍是 zh", () => {
    strictEqual(
      detectReplyLang("跑一下这个 ```bun run typecheck && bun run test --watch --coverage``` 看看结果"),
      "zh",
    );
    strictEqual(detectReplyLang("看看 `git rebase --onto origin/main HEAD~3` 这一步为什么失败"), "zh");
    strictEqual(detectReplyLang("打开 https://github.com/xuanji-lab/orbita/pull/512 并总结"), "zh");
    strictEqual(detectReplyLang("读 src/agent/runtime.ts 然后告诉我它做什么"), "zh");
    // 英文句子里夹路径、点名记号仍是 en
    strictEqual(detectReplyLang("/skill:browser please open the docs page"), "en");
  });

  it("没有可判的字 → null：空串、纯数字符号、emoji、单个字母", () => {
    strictEqual(detectReplyLang(""), null);
    strictEqual(detectReplyLang("   "), null);
    strictEqual(detectReplyLang("123 + 456 = ?"), null);
    strictEqual(detectReplyLang("👍"), null);
    strictEqual(detectReplyLang("a"), null);
  });

  it("英文至少 3 个词才判 en：ok / yes / 「好 ok yes」这类过短的不改变语言", () => {
    strictEqual(detectReplyLang("ok"), null);
    strictEqual(detectReplyLang("yes please"), null);
    strictEqual(detectReplyLang("好 ok yes"), null);
    strictEqual(detectReplyLang("yes please do it"), "en");
  });

  it("含日文假名 / 韩文 → null（不把日语用户钉成英语）", () => {
    strictEqual(detectReplyLang("これを読んでください"), null);
    strictEqual(detectReplyLang("이 파일을 읽어 주세요"), null);
  });
});

describe("replyLanguageNote / isReplyLang", () => {
  it("标记一行、措辞固定（前缀缓存逐字节稳定）", () => {
    strictEqual(
      replyLanguageNote("zh"),
      '<reply_language lang="zh">Write all user-visible text in Chinese (the language the user writes in).</reply_language>',
    );
    strictEqual(
      replyLanguageNote("en"),
      '<reply_language lang="en">Write all user-visible text in English (the language the user writes in).</reply_language>',
    );
    strictEqual(replyLanguageNote("zh").includes("\n"), false);
  });

  it("isReplyLang 只认 zh / en", () => {
    strictEqual(isReplyLang("zh"), true);
    strictEqual(isReplyLang("en"), true);
    strictEqual(isReplyLang("fr"), false);
    strictEqual(isReplyLang(undefined), false);
  });
});
