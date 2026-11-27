import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { deliverChannelSubmission } from "./channel-delivery.ts";

describe("通道投递：成功才销账，失败先恢复", () => {
  for (const path of ["普通合并投递", "QueueStrip 立即发送"] as const) {
    it(`${path}：submit  pending 时不清账，resolve 之后才清`, async () => {
      const events: string[] = [];
      let accept!: () => void;
      const delivery = deliverChannelSubmission({
        submit: () => new Promise<void>((resolve) => (accept = resolve)),
        onAccepted: () => events.push("untrack"),
        onFailure: () => events.push("restore"),
      });
      await Promise.resolve();
      deepStrictEqual(events, [], "IPC 尚未接受，pending 必须还在");
      accept();
      await delivery;
      deepStrictEqual(events, ["untrack"]);
    });

    it(`${path}：reject 时恢复原来的可见状态，不销账，错误继续上抛`, async () => {
      const events: string[] = [];
      await rejects(
        deliverChannelSubmission({
          submit: () => Promise.reject(new Error("模拟 IPC 失败")),
          onAccepted: () => events.push("untrack"),
          onFailure: () => events.push(path === "普通合并投递" ? "re-hold" : "requeue"),
        }),
        /模拟 IPC 失败/,
      );
      deepStrictEqual(events, [path === "普通合并投递" ? "re-hold" : "requeue"]);
    });
  }

  it("恢复动作本身发生在错误回到原 catch 之前，调用方随后只负责错误展示与乐观轮归位", async () => {
    const events: string[] = [];
    const promise = deliverChannelSubmission({
      submit: () => Promise.reject(new Error("x")),
      onAccepted: () => events.push("untrack"),
      onFailure: () => events.push("restore"),
    });
    await promise.catch(() => events.push("show-error"));
    strictEqual(events.join(","), "restore,show-error");
  });
});
