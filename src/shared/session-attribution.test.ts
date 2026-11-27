import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ATTRIBUTION_CAPTURE_SHARE, attributionOf, parseAttribution, parseSessionMeta } from "./session.ts";

describe("会话归属：指名 / 推断两种来源，同一个读取函数", () => {
  test("parseAttribution：assigned 不带比例；inferred 必须带 0–1 的比例；坏形状整份丢", () => {
    assert.deepEqual(parseAttribution({ subAgentId: "agent-1", source: "assigned", share: 0.3 }), { subAgentId: "agent-1", source: "assigned" });
    assert.deepEqual(parseAttribution({ subAgentId: "agent-1", source: "inferred", share: 0.7 }), { subAgentId: "agent-1", source: "inferred", share: 0.7 });
    assert.equal(parseAttribution({ subAgentId: "agent-1", source: "inferred" }), null);
    assert.equal(parseAttribution({ subAgentId: "agent-1", source: "inferred", share: 1.5 }), null);
    assert.equal(parseAttribution({ subAgentId: "../x", source: "assigned" }), null);
    assert.equal(parseAttribution({ subAgentId: "agent-1", source: "guessed" }), null);
    assert.equal(parseAttribution("agent-1"), null);
  });

  test("attributionOf：指名的一律算；推断的比例够高才算被「引力捕获」", () => {
    assert.equal(attributionOf({}), null);
    assert.equal(attributionOf({ attribution: { subAgentId: "a", source: "assigned" } })?.subAgentId, "a");
    assert.equal(attributionOf({ attribution: { subAgentId: "a", source: "inferred", share: ATTRIBUTION_CAPTURE_SHARE } })?.subAgentId, "a");
    assert.equal(attributionOf({ attribution: { subAgentId: "a", source: "inferred", share: ATTRIBUTION_CAPTURE_SHARE - 0.01 } }), null);
  });

  test("meta 读写回环：attribution 进得去、读得回；坏值不连累整条会话", () => {
    const base = { id: "s", cwd: "/w", providerId: "p", modelId: "m", createdAt: 1 };
    assert.deepEqual(parseSessionMeta({ ...base, attribution: { subAgentId: "agent-1", source: "assigned" } })?.attribution, { subAgentId: "agent-1", source: "assigned" });
    const broken = parseSessionMeta({ ...base, attribution: { subAgentId: 3 } });
    assert.notEqual(broken, null);
    assert.equal(broken?.attribution, undefined);
  });
});
