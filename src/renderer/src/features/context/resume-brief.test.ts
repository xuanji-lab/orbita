import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { en } from "../../messages-en.ts";
import { buildPreviewFixture, yesterdayEvening } from "../../preview/scenes.ts";
import { planTimeline } from "./plan-timeline.ts";
import { resumeAnswer, resumeBrief } from "./resume-brief.ts";

const NOW = new Date(2026, 10, 21, 9, 30).getTime();

/** 用 typical 的跨天场景（主智能体昨天 18:40 离开）喂一遍：五项都从结构化记录里来 */
function typicalBrief() {
  const fixture = buildPreviewFixture({ scene: "typical", theme: "light", language: "en", now: NOW });
  const main = "boss-research";
  const jobs = fixture.sessions
    .filter((item) => item.parentId === main)
    .map((item) => ({
      title: item.title,
      messages: fixture.channels.filter((message) => message.id.startsWith(`${main}:${item.id}:`)),
      plan: planTimeline(fixture.transcripts.get(item.id) ?? [])?.current.items ?? null,
    }));
  return resumeBrief({ records: fixture.transcripts.get(main) ?? [], jobs }, en.taskPanel.brief);
}

describe("resumeBrief：跨天回来的恢复回答", () => {
  test("为什么做、上次到哪、已定的决定、在等你、下一步都有出处", () => {
    const brief = typicalBrief();
    assert.equal(brief.leftAt, yesterdayEvening(NOW));
    assert.equal(brief.why, "Bring the session-navigation research into one place and decide how a child session opens");
    assert.deepEqual(brief.reached, ["Collect interface evidence"]);
    // 用户在通道里替主智能体回的那句 = 已定
    assert.deepEqual(brief.decisions, ["Yes, cover light and Onyx, both empty and full."]);
    assert.deepEqual(brief.waiting.map((item) => item.title), ["Compare session navigation", "Decide how a child session opens"]);
    assert.equal(brief.next, "Write the navigation recommendation");
  });

  test("回答五行，取不到的写「没有记录」，不编", () => {
    const text = resumeAnswer(
      { leftAt: null, why: null, reached: [], decisions: [], waiting: [], next: null },
      "yesterday at 18:40",
      en.taskPanel.resume,
    );
    assert.equal(text.split("\n").filter((line) => line.endsWith("nothing recorded")).length, 5);
  });

  test("空会话：没有离开时刻，各项为空", () => {
    const brief = resumeBrief({ records: [], jobs: [] }, en.taskPanel.brief);
    assert.deepEqual(brief, { leftAt: null, why: null, reached: [], decisions: [], waiting: [], next: null });
  });
});
