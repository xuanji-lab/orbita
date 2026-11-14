import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import type { ContextMessage } from "./image-byte-budget.ts";
import { collapseSystem, liftMessages, messageSignature, TurnWire, WireDoc } from "./kernel-wire.ts";
import { attachMemoryBlocks } from "./memory-inject.ts";
import { injectUserContext } from "./user-context.ts";

async function conversation() {
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  return { harness, conversation: await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT) };
}

/** 旧内核 context 事件里的一段历史（pi 的 AgentMessage 形状） */
const OLD: ContextMessage[] = [
  { role: "compactionSummary", summary: "earlier work", tokensBefore: 10, timestamp: 1000 } as unknown as ContextMessage,
  { role: "custom", customType: "orbita.undo", content: "the last turn was undone", display: true, timestamp: 1500 } as unknown as ContextMessage,
  { role: "user", content: [{ type: "text", text: "first" }], timestamp: 2000 } as ContextMessage,
  { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2100 } as unknown as ContextMessage,
  { role: "user", content: [{ type: "text", text: "second" }], timestamp: 3000 } as ContextMessage,
];

describe("kernel-wire：新内核的逐请求注入与旧内核同一条变换链", () => {
  it("durable 形状的消息还原成旧内核的形状，过同一串函数后与旧内核的结果逐字节相同", async () => {
    const tz = "Asia/Singapore";
    // 旧内核：记忆附件 → 用户情境 → convertToLlm（这一段没有图、没有目标账）
    const block = "<orbita-memory>\nm\n</orbita-memory>";
    const oldMemory = { attached: new Map<number, string>(), pending: block as string | null };
    const oldAttached = attachMemoryBlocks(OLD, oldMemory).messages ?? OLD;
    const expected = convertToLlm(injectUserContext(oldAttached, tz)?.messages ?? oldAttached);

    // 新内核：durable 里存的是 convertToLlm 之后的消息；扩展消息靠指纹认回来
    const durableMessages = convertToLlm(OLD);
    const customs = new Set([messageSignature(durableMessages[1] as Message)]);
    const lifted = liftMessages(durableMessages, customs);
    assert.deepEqual(
      lifted.map((message) => (message as { role: string }).role),
      ["compactionSummary", "custom", "user", "assistant", "user"],
    );
    const newMemory = { attached: new Map<number, string>(), pending: block as string | null };
    const newAttached = attachMemoryBlocks(lifted, newMemory).messages ?? lifted;
    const actual = convertToLlm(injectUserContext(newAttached, tz)?.messages ?? newAttached);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected));
    // 用户情境只加在真正的用户消息上：压缩摘要与扩展消息没有
    assert.doesNotMatch(JSON.stringify(actual[0]), /user_context/);
    assert.doesNotMatch(JSON.stringify(actual[1]), /user_context/);
    assert.match(JSON.stringify(actual[2]), /user_context/);
  });

  it("记忆块首次认领时定格进 orbita.wire，下一轮从库里读回来逐字节重放", async () => {
    const { harness, conversation: target } = await conversation();
    const wire = await TurnWire.open(target, "/att", BACKGROUND_CONTEXT);
    wire.memory.pending = "<orbita-memory>\nremember this\n</orbita-memory>";
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 42 }];
    const first = await wire.transform(messages, () => [], BACKGROUND_CONTEXT);
    assert.match(JSON.stringify(first), /remember this/);
    const state = await harness.snapshot(WireDoc, target.id, BACKGROUND_CONTEXT);
    assert.deepEqual(state?.memory, [[42, "<orbita-memory>\nremember this\n</orbita-memory>"]]);
    const next = await TurnWire.open(target, "/att", BACKGROUND_CONTEXT);
    const replay = await next.transform(messages, () => [], BACKGROUND_CONTEXT);
    assert.equal(JSON.stringify(replay), JSON.stringify(first));
    await harness.close(BACKGROUND_CONTEXT);
  });

  it("系统消息折成打头的一条：段的变化不作为对话中途的系统消息发出", () => {
    const messages: Message[] = [
      { role: "system", content: "", sections: { a: "A" }, timestamp: 1 },
      { role: "user", content: "u", timestamp: 2 },
      { role: "system", content: "", sections: { a: "A2", b: "B" }, timestamp: 3 },
    ];
    const collapsed = collapseSystem(messages);
    assert.equal(collapsed.length, 2);
    assert.equal(collapsed[0]?.role, "system");
    assert.deepEqual((collapsed[0] as { sections?: unknown }).sections, { a: "A2", b: "B" });
    assert.equal(collapsed[1]?.role, "user");
  });
});
