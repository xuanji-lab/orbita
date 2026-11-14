/**
 * 交还提示的协议与「这一行还活着吗」的判定。
 *
 * 一条协议两种读者（模型读竖线后的散文、renderer 解析竖线前的键值），所以生产与
 * 解析的格式必须同源；而 `detachedNoticeIsLive` 是界面**唯一**用来区分
 * 「同一进程里正常在跑」与「上个进程留下的」的判定——判错就是界面撒谎。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  bashResultNotice,
  detachedNoticeHeader,
  detachedNoticeIsLive,
  parseDetachedNotice,
  type BashSessionsSnapshot,
  type DetachedNotice,
} from "./bash-session.ts";

const snapshot = (runId: string, running: string[]): BashSessionsSnapshot => ({ runId, running });

describe("交还提示：run= 跟着一起来", () => {
  test("给进程标识就写 run=，不给就不写（旧格式仍然合法）", () => {
    assert.equal(
      detachedNoticeHeader("b1", 302, 14_400, "abc12345"),
      "[orbita] kind=detached session=b1 elapsed=302s lifetime=14400s run=abc12345",
    );
    assert.equal(
      detachedNoticeHeader("b1", 302, 14_400),
      "[orbita] kind=detached session=b1 elapsed=302s lifetime=14400s",
    );
    assert.equal(detachedNoticeHeader("b2", 0, 0, ""), "[orbita] kind=detached session=b2 elapsed=0s");
  });

  test("解析出 run=；旧记录（没有 run）按没有处理", () => {
    assert.deepEqual(parseDetachedNotice(detachedNoticeHeader("b7", 302, 1800, "abc12345")), {
      sessionId: "b7",
      elapsedSeconds: 302,
      lifetimeSeconds: 1800,
      runId: "abc12345",
    });
    assert.deepEqual(parseDetachedNotice("[orbita] kind=detached session=b3 elapsed=302s lifetime=7200s | …"), {
      sessionId: "b3",
      elapsedSeconds: 302,
      lifetimeSeconds: 7200,
    });
    // 只有交还提示那一行能认出来，别的文本一律 null
    assert.equal(parseDetachedNotice("bash session b1 finished · exit 0 · 5m40s"), null);
  });
});

describe("这一行还活着吗 —— 快照 × 提示", () => {
  const current: DetachedNotice = { sessionId: "b1", elapsedSeconds: 302, lifetimeSeconds: 1800, runId: "abc12345" };
  const legacy: DetachedNotice = { sessionId: "b1", elapsedSeconds: 302 };

  test("同一个进程、会话在跑 → 活着", () => {
    assert.equal(detachedNoticeIsLive(current, snapshot("abc12345", ["b1", "b2"])), true);
  });

  test("进程换了（应用重启 / 内核重启）→ 失联：会话 id 撞上也救不了", () => {
    // 新进程从 b1 重新发号：单看 id 会误判成在跑，靠 run 才认得出来
    assert.equal(detachedNoticeIsLive(current, snapshot("ffff0000", ["b1"])), false);
    assert.equal(detachedNoticeIsLive(current, snapshot("", ["b1"])), false);
  });

  test("同一个进程但会话表里没有它（已结束 / 已收掉）→ 失联", () => {
    assert.equal(detachedNoticeIsLive(current, snapshot("abc12345", [])), false);
    assert.equal(detachedNoticeIsLive(current, snapshot("abc12345", ["b2"])), false);
  });

  test("旧记录没有 run=：只能按 id 判（尽力而为，不编造）", () => {
    assert.equal(detachedNoticeIsLive(legacy, snapshot("abc12345", ["b1"])), true);
    assert.equal(detachedNoticeIsLive(legacy, snapshot("abc12345", ["b2"])), false);
  });
});

describe("落定提示不受影响", () => {
  test("落定行仍然是那一句（这次改动只往交还提示里加了 run=）", () => {
    assert.equal(
      bashResultNotice({ sessionId: "b1", status: "finished", exitCode: 0, elapsedSeconds: 340, command: "sleep 340" }),
      "[orbita] bash session b1 finished · exit 0 · 5m40s",
    );
  });
});
