import { test } from "node:test";
import assert from "node:assert/strict";
import { initialCallState, reduceCall, type CallEffect, type CallEvent, type CallState } from "./call-machine.ts";
import { AnswerReader, answerTextAfter, findAskedIndex, proseOf, speakable, takeSentences } from "./speech-text.ts";
import { encodeWav } from "./wav.ts";

/** 逐拍喂事件，收集每一拍的 effects 类型 */
function run(events: readonly CallEvent[], start: CallState = initialCallState()): { state: CallState; effects: CallEffect[][] } {
  let state = start;
  const effects: CallEffect[][] = [];
  for (const event of events) {
    const step = reduceCall(state, event);
    state = step.state;
    effects.push(step.effects);
  }
  return { state, effects };
}

const types = (effects: readonly CallEffect[]): string[] => effects.map((effect) => effect.type);

test("一来一回：接通 → 听 → 停顿收尾 → 发出 → 按句念 → 答完念完回到听", () => {
  const { state, effects } = run([
    { type: "connected" },
    { type: "transcript", text: "今天" },
    { type: "transcript", text: "今天天气怎么样" },
    { type: "silence" },
    { type: "final", text: "今天天气怎么样？" },
    { type: "speech", count: 2 },
    { type: "spoken" },
    { type: "turnDone" },
    { type: "spoken" },
  ]);
  assert.deepEqual(types(effects[0] ?? []), ["openDictation"]);
  assert.deepEqual(types(effects[2] ?? []), ["armSilence"]);
  assert.deepEqual(types(effects[3] ?? []), ["finishDictation"]);
  assert.deepEqual(effects[4], [{ type: "send", text: "今天天气怎么样？" }]);
  assert.deepEqual(types(effects[7] ?? []), []);
  assert.deepEqual(types(effects[8] ?? []), ["openDictation"]);
  assert.equal(state.phase, "listening");
  assert.equal(state.heard, "");
});

test("还在说（有人声）就重计停顿；没听到字时停顿不收尾", () => {
  const listening = run([{ type: "connected" }]).state;
  assert.deepEqual(reduceCall(listening, { type: "silence" }).effects, []);
  assert.deepEqual(reduceCall(listening, { type: "voice" }).effects, []);
  const heard = reduceCall(listening, { type: "transcript", text: "嗯" }).state;
  assert.deepEqual(types(reduceCall(heard, { type: "voice" }).effects), ["armSilence"]);
});

test("最终文字是空的：用停顿前听到的；两样都空就当没说、接着听", () => {
  const thinking = run([{ type: "connected" }, { type: "transcript", text: "你好" }, { type: "silence" }]).state;
  assert.deepEqual(reduceCall(thinking, { type: "final", text: "" }).effects, [{ type: "send", text: "你好" }]);
  const blank = { ...thinking, asked: "" };
  const back = reduceCall(blank, { type: "final", text: "  " });
  assert.equal(back.state.phase, "listening");
  assert.deepEqual(types(back.effects), ["openDictation"]);
});

test("同一句不发两次：迟到的 final 不再发", () => {
  const sent = run([{ type: "connected" }, { type: "transcript", text: "你好" }, { type: "silence" }, { type: "final", text: "你好" }]).state;
  assert.deepEqual(reduceCall(sent, { type: "final", text: "你好" }).effects, []);
});

test("回答文字比播放先出完：播完最后一段才回到听；中途播空了回到在想", () => {
  const sent = run([{ type: "connected" }, { type: "transcript", text: "a" }, { type: "silence" }, { type: "final", text: "a" }]).state;
  const one = run([{ type: "speech", count: 1 }, { type: "spoken" }], sent).state;
  assert.equal(one.phase, "thinking");
  const done = run([{ type: "speech", count: 1 }, { type: "turnDone" }], one);
  assert.equal(done.state.phase, "speaking");
  const last = reduceCall(done.state, { type: "spoken" });
  assert.equal(last.state.phase, "listening");
});

test("一句也没念（回答只有工具调用）：轮完直接回到听", () => {
  const sent = run([{ type: "connected" }, { type: "transcript", text: "a" }, { type: "silence" }, { type: "final", text: "a" }]).state;
  const done = reduceCall(sent, { type: "turnDone" });
  assert.equal(done.state.phase, "listening");
  assert.deepEqual(types(done.effects), ["openDictation"]);
});

test("打断：在说时开口 → 停播、回到听；之后旧一轮的 speech / turnDone 都不理", () => {
  const speaking = run([
    { type: "connected" },
    { type: "transcript", text: "a" },
    { type: "silence" },
    { type: "final", text: "a" },
    { type: "speech", count: 3 },
  ]).state;
  const cut = reduceCall(speaking, { type: "bargeIn" });
  assert.equal(cut.state.phase, "listening");
  assert.deepEqual(types(cut.effects), ["stopSpeech", "openDictation"]);
  assert.equal(reduceCall(cut.state, { type: "speech", count: 1 }).state.phase, "listening");
  assert.equal(reduceCall(cut.state, { type: "turnDone" }).state.phase, "listening");
  // 不在说时的打断不算
  assert.deepEqual(reduceCall(cut.state, { type: "bargeIn" }).effects, []);
});

test("挂断：任何阶段都释放，之后什么事件都不再动", () => {
  const speaking = run([{ type: "connected" }, { type: "transcript", text: "a" }, { type: "silence" }]).state;
  const ended = reduceCall(speaking, { type: "hangUp" });
  assert.equal(ended.state.phase, "ended");
  assert.deepEqual(types(ended.effects), ["stopSpeech", "release"]);
  assert.deepEqual(reduceCall(ended.state, { type: "connected" }), { state: ended.state, effects: [] });
  assert.deepEqual(reduceCall(ended.state, { type: "hangUp" }).effects, []);
});

test("按句切：中英文句末、换行；太短的并到下一句；没出完的尾巴留着", () => {
  assert.deepEqual(takeSentences("好的。我先看一下文件，然后告诉你结果。剩下", false), {
    sentences: ["好的。我先看一下文件，然后告诉你结果。"],
    consumed: "好的。我先看一下文件，然后告诉你结果。".length,
  });
  assert.deepEqual(takeSentences("Version 3.5 is out. Next line\n第二段", false).sentences, ["Version 3.5 is out.", "Next line"]);
  assert.deepEqual(takeSentences("尾巴没句号", true), { sentences: ["尾巴没句号"], consumed: 5 });
  assert.deepEqual(takeSentences("", true), { sentences: [], consumed: 0 });
});

test("念之前清掉 Markdown、链接地址与代码块", () => {
  assert.equal(speakable("## 结论\n- **第一**：看 [文档](https://x.y/z) 和 `bun run test`"), "结论 第一：看 文档 和 bun run test");
  assert.equal(speakable("```ts\nconst a = 1;\n```"), "");
  assert.equal(speakable("地址是 https://example.com/a?b=1 。"), "地址是 。");
});

test("流式读回答：只念新长出来的完整句子；没合上的代码块先不念；答完把尾巴也念了", () => {
  const reader = new AnswerReader();
  assert.deepEqual(reader.next("我来看看。", false), []);
  assert.deepEqual(reader.next("我来看看这个仓库。然后", false), ["我来看看这个仓库。"]);
  assert.deepEqual(reader.next("我来看看这个仓库。然后跑测试：\n```bash\nbun run", false), ["然后跑测试："]);
  assert.deepEqual(reader.next("我来看看这个仓库。然后跑测试：\n```bash\nbun run test\n```\n全部通过", true), ["全部通过"]);
  assert.equal(proseOf("a```b"), "a");
});

test("锚点：从后往前找这句用户消息，只拼它之后 assistant 的正文", () => {
  const items = [
    { role: "user", content: [{ type: "text", text: "你好" }] },
    { role: "assistant", content: [{ type: "text", text: "旧回答" }] },
    { role: "user", content: [{ type: "text", text: "<user_context>sent_at: x</user_context>" }, { type: "text", text: "你好" }] },
    { role: "assistant", content: [{ type: "thinking" }, { type: "text", text: "第一段" }, { type: "toolCall" }] },
    { role: "tool", content: [{ type: "text", text: "工具输出不念" }] },
    { role: "assistant", content: [{ type: "text", text: "第二段" }] },
  ];
  const anchor = findAskedIndex(items, " 你好 ");
  assert.equal(anchor, 2);
  assert.equal(answerTextAfter(items, anchor), "第一段\n第二段");
  assert.equal(findAskedIndex(items, "没发过"), -1);
  const withIds = items.map((item, index) => ({ ...item, id: `i${index}` }));
  // 发出时最后一条是 i5：新的回显还没到，旧的同一句不算
  assert.equal(findAskedIndex(withIds, "你好", "i5"), -1);
  assert.equal(findAskedIndex(withIds, "你好", "i1"), 2);
  assert.equal(answerTextAfter(items, -1), "");
});

test("录音 wav：44 字节头 + PCM，采样率与长度写对", () => {
  const pcm = new Int16Array([0, 1000, -1000, 32767]);
  const wav = encodeWav([pcm], 16000);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(wav.byteLength, 44 + 8);
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), "RIFF");
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(40, true), 8);
  assert.equal(view.getInt16(46, true), 1000);
});
