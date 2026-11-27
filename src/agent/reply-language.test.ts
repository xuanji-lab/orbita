/**
 * 回复语言锚点的 agent 侧：从用户消息里剥掉 Orbita 的包装、取用户亲手打的字的语言，
 * 逐条（因果）算出每条用户消息发出时用户的语言，子会话用父会话写进信封的 lang。
 */
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, test } from "node:test";
import { composeChannelPrompt, type ChannelMessage } from "../shared/channel.ts";
import { composeInvocationPrompt } from "../shared/invocation.ts";
import { composePromptText } from "../shared/prompt-attachments.ts";
import { composeQuotedMessage } from "../shared/quote.ts";
import type { ContextMessage } from "./image-byte-budget.ts";
import { currentReplyLang, replyLangsOf, userTypedLang } from "./reply-language.ts";

function user(...texts: string[]): ContextMessage {
  return {
    role: "user",
    content: texts.map((text) => ({ type: "text", text })),
    timestamp: 1,
  } as unknown as ContextMessage;
}
const ASSISTANT = { role: "assistant", content: [], timestamp: 1 } as unknown as ContextMessage;
const TOOL_RESULT = {
  role: "toolResult",
  toolCallId: "t",
  content: [{ type: "text", text: "Sub-session started. It is now working; its messages will arrive later." }],
  isError: false,
  timestamp: 1,
} as unknown as ContextMessage;

function envelope(over: Partial<ChannelMessage>, text: string): string {
  return composeChannelPrompt(
    { id: "m1", from: "parent", author: "model", kind: "task", text, delivery: "followUp", createdAt: 1, ...over },
    { id: "p1", title: "父会话", workbench: "/wb/parent" },
  );
}

describe("userTypedLang：只看用户亲手打的字", () => {
  test("纯中文 / 纯英文 / 中英混排", () => {
    strictEqual(userTypedLang(["派个子会话去读一下 README，告诉我项目是干嘛的"]), "zh");
    strictEqual(userTypedLang(["Please read the README and tell me what the project does"]), "en");
    strictEqual(userTypedLang(["帮我 review 一下这个 PR"]), "zh");
  });

  test("用户情境 / 记忆块垫在前后：中文正文照样判 zh（这些块是英文机器话）", () => {
    strictEqual(
      userTypedLang([
        "<user_context>\nsent_at: 2026-11-22 23:05 Sun (Asia/Shanghai)\n</user_context>",
        "为什么子会话会写英文汇报？",
        "<orbita-memory>\nThe following entries were recalled for this message: the user prefers concise answers.\n</orbita-memory>",
      ]),
      "zh",
    );
    // 字符串正文里情境直接拼在前面
    strictEqual(
      userTypedLang(["<user_context>\nsent_at: 2026-11-22 23:05 Sun (Asia/Shanghai)\n</user_context>\n为什么这样？"]),
      "zh",
    );
  });

  test("点名指令块（含一大段英文说明）与 referenced_task 行不算用户的字", () => {
    const invoked = composeInvocationPrompt("看一下这个文档", [{ target: "docs", location: "/s/docs/SKILL.md" }], []);
    strictEqual(userTypedLang([invoked]), "zh");
    strictEqual(
      userTypedLang(['<referenced_task id="abc" title="Fix the build pipeline for release" />\n继续上次的活']),
      "zh",
    );
  });

  test("引用块里的英文不算：中文提问 + 英文引用 → zh；英文提问 + 中文引用 → en", () => {
    const quote = (text: string) => ({ text, messageId: "m", role: "assistant" as const });
    strictEqual(
      userTypedLang([
        composeQuotedMessage([quote("The quick brown fox jumps over the lazy dog every single day")], "这句是什么意思？"),
      ]),
      "zh",
    );
    strictEqual(
      userTypedLang([composeQuotedMessage([quote("这是一个很长的中文句子，用来测试引用块不参与判断")], "What does this sentence mean here?")]),
      "en",
    );
  });

  test("只有附件：正文判不出就退到粘贴文本的语言；文件清单与它的英文说明不算", () => {
    const pastedOnly = composePromptText("", ["这是我贴进来的一整段中文说明，请阅读"], []);
    strictEqual(userTypedLang(pastedOnly.split("\n\n")), "zh");
    const filesOnly = composePromptText("", [], [{ path: "/tmp/a.md", kind: "file" }]);
    strictEqual(userTypedLang(filesOnly.split("\n\n")), null);
    // 有打字时以打字为准，粘贴的英文日志不改变语言
    const mixed = composePromptText("看看这个报错", ["Error: ENOENT: no such file or directory, open '/tmp/a.txt' at process"], []);
    strictEqual(userTypedLang(mixed.split("\n\n")), "zh");
  });

  test("只有包装块 / 空消息 → null", () => {
    strictEqual(userTypedLang(["<user_context>\nsent_at: 2026-11-22 23:05 Sun (UTC)\n</user_context>"]), null);
    strictEqual(userTypedLang([""]), null);
    strictEqual(userTypedLang([]), null);
  });

  test("通道信封不是用户的字：即使正文是中文也返回 null（正文是父模型写的）", () => {
    strictEqual(userTypedLang([envelope({}, "请读一下 README 并汇报项目是做什么的")]), null);
  });
});

describe("replyLangsOf：逐条、因果", () => {
  test("用户语言沿用到后面所有消息；非用户消息为 null；英文机器消息（工具结果）不改变它", () => {
    const messages = [user("先帮我看看这个项目"), ASSISTANT, TOOL_RESULT, user("<user_context>\nx\n</user_context>", "ok")];
    deepStrictEqual(replyLangsOf(messages), ["zh", null, null, "zh"]);
  });

  test("用户中途换语言：从那一条起换，之前的不动（重放逐字节稳定）", () => {
    const messages = [user("你好，帮我看个东西"), ASSISTANT, user("Now please summarize it in English for me")];
    deepStrictEqual(replyLangsOf(messages), ["zh", null, "en"]);
    // 只给前缀，前缀里的结果与完整历史里的相同——后面的消息不影响前面的
    deepStrictEqual(replyLangsOf(messages.slice(0, 1)), ["zh"]);
  });

  test("还没有可判的字：null（调用方不附标记）；之后出现了再附", () => {
    deepStrictEqual(replyLangsOf([user("ok"), ASSISTANT, user("继续")]), [null, null, "zh"]);
  });

  test("主会话收到的子会话汇报（child 信封，英文正文）带着用户此前的语言", () => {
    const report = envelope({ from: "child", kind: "done" }, "Done. I read the README: Orbita is a local-first desktop agent.");
    deepStrictEqual(replyLangsOf([user("派个子会话读一下 README"), ASSISTANT, user(report)]), ["zh", null, "zh"]);
  });

  test("子会话：全是信封，语言取父会话写进信封的 lang；信封正文的语言不参与", () => {
    const task = envelope({ lang: "zh" }, "Read the README and report what the project does. Write in English please.");
    const reply = envelope({ kind: "reply", id: "m2", lang: "zh" }, "Also check package.json");
    deepStrictEqual(replyLangsOf([user(task), ASSISTANT, user(reply)]), ["zh", null, "zh"]);
  });

  test("子会话：旧信封没有 lang → null，不报错；之后带 lang 的信封再接上", () => {
    const legacy = envelope({}, "读一下 README");
    const later = envelope({ kind: "reply", id: "m2", lang: "zh" }, "再看 package.json");
    deepStrictEqual(replyLangsOf([user(legacy), ASSISTANT, user(later)]), [null, null, "zh"]);
  });

  test("子会话里用户亲手打的字与信封 lang 都算，取最近的一个", () => {
    const task = envelope({ lang: "zh" }, "task body");
    const messages = [user(task), ASSISTANT, user("Actually please answer in English from now on, thanks")];
    deepStrictEqual(replyLangsOf(messages), ["zh", null, "en"]);
  });

  test("字符串正文与形状不认识的消息不炸", () => {
    const weird = { role: "user", content: 42, timestamp: 1 } as unknown as ContextMessage;
    const str = { role: "user", content: "你好", timestamp: 1 } as unknown as ContextMessage;
    deepStrictEqual(replyLangsOf([weird, str]), [null, "zh"]);
  });
});

describe("currentReplyLang：派发 / 回信时写进通道消息的语言", () => {
  test("取最后一个算出来的语言；没有则 undefined", () => {
    strictEqual(currentReplyLang([user("你好"), ASSISTANT, TOOL_RESULT]), "zh");
    strictEqual(currentReplyLang([ASSISTANT, TOOL_RESULT]), undefined);
    strictEqual(currentReplyLang([]), undefined);
  });
});
