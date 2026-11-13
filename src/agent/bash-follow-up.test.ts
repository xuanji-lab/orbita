/**
 * 自动起一轮的三条触发条件（用户 2026-11-13 裁决）。
 *
 * 判定是纯函数（`bash-follow-up.ts`）：runtime 被 parentPort 守卫钉死在 utility
 * 进程里、加载即退出，所以把「起不起」与文案抽出来直测，而不是拉起整个 agent。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { BashSessionEnd } from "./bash-sessions.ts";
import { bashFollowUpPrompt, shouldStartBashFollowUp } from "./bash-follow-up.ts";

const natural = (overrides: Partial<BashSessionEnd> = {}): BashSessionEnd => ({
  id: "b1",
  command: "npm run build",
  status: "finished",
  exitCode: 0,
  elapsedMs: 400_000,
  output: "done",
  cancelled: false,
  ...overrides,
});

const base = { busy: false, alreadyStartedFor: undefined, hasTemplate: true } as const;

describe("自动起一轮 —— 三条触发条件", () => {
  test("自然结束 + 空闲 + 有模板 + 没起过 → 起", () => {
    assert.equal(shouldStartBashFollowUp({ ...base, result: natural() }), true);
  });

  test("① 会话忙（有正在跑的回合）→ 不起", () => {
    assert.equal(shouldStartBashFollowUp({ ...base, busy: true, result: natural() }), false);
  });

  test("② 用户 stop / 寿命杀 → 不起（人已经知道）", () => {
    assert.equal(
      shouldStartBashFollowUp({ ...base, result: natural({ status: "killed", endReason: "stop", cancelled: true }) }),
      false,
    );
    assert.equal(
      shouldStartBashFollowUp({ ...base, result: natural({ status: "killed", endReason: "lifetime", cancelled: true }) }),
      false,
    );
  });

  test("③ 同一条会话的同一个结束只起一次", () => {
    assert.equal(shouldStartBashFollowUp({ ...base, alreadyStartedFor: "b1", result: natural() }), false);
    // 另一个后台会话结束：可以再起一轮
    assert.equal(shouldStartBashFollowUp({ ...base, alreadyStartedFor: "b1", result: natural({ id: "b2" }) }), true);
  });

  test("还没有可重放的开轮装配（首轮都没跑过）→ 不起", () => {
    assert.equal(shouldStartBashFollowUp({ ...base, hasTemplate: false, result: natural() }), false);
  });
});

describe("自动起一轮的提示词", () => {
  test("一句话：命令 id、退出码、耗时，并说明结果在上面", () => {
    const prompt = bashFollowUpPrompt(natural());
    assert.match(prompt, /Background command b1 finished \(exit 0, 6m40s\)/);
    assert.match(prompt, /Its result is above/);
  });

  test("退出码未知时说 unknown，不编造 0", () => {
    assert.match(bashFollowUpPrompt(natural({ exitCode: null })), /exit unknown/);
  });
});
