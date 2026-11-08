import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { en } from "../../../messages-en.ts";
import { zh } from "../../../messages-zh.ts";
import {
  FAKE_REPORT,
  GATE_SOURCE,
  REPORTS,
  STATIONS,
  STATION_IDS,
  STEPS,
  STEP_COUNT,
  STEP_IDS,
  atGate,
  effectiveStyle,
  gateOpen,
  initialState,
  linkedCount,
  nextLabel,
  openOriginal,
  pickReport,
  pressNext,
  pressPrev,
  ringSynced,
  shotPage,
  stationState,
  stationStates,
  type StoryState,
} from "./story-script.ts";
import { layoutOf, ORBIT_RADIUS } from "./story-layouts.ts";

/** 一路按 → 走到头，返回每一步到站时的状态（辨伪环节由「领航员代选」走过） */
function walk(): StoryState[] {
  const seen: StoryState[] = [];
  let state = initialState();
  for (let guard = 0; guard < 200; guard += 1) {
    seen.push(state);
    const next = pressNext(state);
    if (next === "finish") return seen;
    state = next;
  }
  throw new Error("剧本走不完");
}

describe("剧本推进", () => {
  test("步骤表与步骤 id 一一对应，且 id 不重复", () => {
    assert.deepEqual(STEPS.map((step) => step.id), [...STEP_IDS]);
    assert.equal(new Set(STEP_IDS).size, STEP_IDS.length);
    assert.equal(STEP_COUNT, STEP_IDS.length);
  });

  test("只按「下一步」能走到结局：辨伪环节按两下（翻开原文 → 领航员指出），之后是 finish", () => {
    const seen = walk();
    // 15 步 + 辨伪多按两下停在同一步
    assert.equal(seen.length, STEP_COUNT + 2);
    assert.equal(seen[seen.length - 1]?.index, STEP_COUNT - 1);
  });

  test("辨伪环节没解开时 → 不翻页；先翻开原文，再由领航员指出", () => {
    let state = initialState(STEPS.findIndex((step) => step.gate === true));
    assert.equal(atGate(state), true);
    assert.equal(gateOpen(state), true);
    const opened = pressNext(state);
    assert.notEqual(opened, "finish");
    if (opened === "finish") return;
    assert.equal(opened.index, state.index);
    assert.equal(opened.gate.opened, true);
    assert.equal(gateOpen(opened), true);
    const solved = pressNext(opened);
    if (solved === "finish") throw new Error("不该结束");
    assert.equal(solved.index, state.index);
    assert.equal(solved.gate.solved, true);
    assert.equal(solved.gate.byPilot, true);
    state = solved;
    const after = pressNext(state);
    if (after === "finish") throw new Error("不该结束");
    assert.equal(after.index, state.index + 1);
  });

  test("没点开原文不能选；选错记一次、能重选；选对过关（不是领航员代选）", () => {
    const start = initialState(STEPS.findIndex((step) => step.gate === true));
    assert.equal(pickReport(start, FAKE_REPORT), start, "没开原文就选，状态不变");
    let state = openOriginal(start);
    state = pickReport(state, "a");
    assert.equal(state.gate.solved, false);
    assert.equal(state.gate.wrong, 1);
    assert.equal(state.gate.picked, "a");
    state = pickReport(state, "a");
    assert.equal(state.gate.wrong, 2);
    state = pickReport(state, FAKE_REPORT);
    assert.equal(state.gate.solved, true);
    assert.equal(state.gate.byPilot, false);
    assert.equal(gateOpen(state), false);
  });

  test("上一步直接退页，辨伪进度保留；第一页再退原地不动", () => {
    const gateIndex = STEPS.findIndex((step) => step.gate === true);
    let state = initialState(gateIndex);
    state = pickReport(openOriginal(state), FAKE_REPORT);
    const back = pressPrev(state);
    assert.equal(back.index, gateIndex - 1);
    assert.equal(back.gate.solved, true);
    const first = initialState(0);
    assert.equal(pressPrev(first), first);
  });

  test("主按钮文案：辨伪按进度换，剧情步用动作，最后一页是收尾", () => {
    const gateIndex = STEPS.findIndex((step) => step.gate === true);
    const fresh = initialState(gateIndex);
    assert.equal(nextLabel(fresh), "gateOpen");
    assert.equal(nextLabel(openOriginal(fresh)), "gatePilot");
    assert.equal(nextLabel(pickReport(openOriginal(fresh), FAKE_REPORT)), "next");
    assert.equal(nextLabel(initialState(STEP_COUNT - 1)), "finish");
    assert.equal(nextLabel(initialState(0)), "cue");
  });
});

describe("站点接通状态", () => {
  test("开场：领航站出场（失步），其余还是未知信号；一座都没接通", () => {
    const state = initialState(0);
    assert.equal(stationState("pilot", state), "lost");
    for (const id of STATION_IDS.filter((each) => each !== "pilot")) assert.equal(stationState(id, state), "dim");
    assert.equal(linkedCount(state), 0);
  });

  test("接通数只增不减地随步数走（辨伪过关之后），结局全部接通", () => {
    const seen = walk();
    let last = 0;
    for (const state of seen) {
      const count = linkedCount(state);
      assert.ok(count >= last, `第 ${state.index} 步接通数倒退`);
      last = count;
    }
    const end = seen[seen.length - 1];
    assert.ok(end);
    assert.equal(linkedCount(end), STATION_IDS.length);
    assert.equal(ringSynced(0, end), true);
    for (const ring of [1, 2, 3] as const) assert.equal(ringSynced(ring, end), true);
  });

  test("每座站先出场（lost）后接通（linked），登场在接通之前", () => {
    for (const id of STATION_IDS) {
      const wake = STEPS.findIndex((step) => step.wake?.includes(id) === true);
      const link = STEPS.findIndex((step) => step.link?.includes(id) === true || step.gateLink?.includes(id) === true);
      assert.ok(wake !== -1 && link !== -1, `${id} 缺出场或接通`);
      assert.ok(wake <= link, `${id} 接通在出场之前`);
    }
  });

  test("核验站：辨伪那一步过关前是失步，过关立刻接通；不过关翻不过去", () => {
    const gateIndex = STEPS.findIndex((step) => step.gate === true);
    const fresh = initialState(gateIndex);
    assert.equal(stationState("verify", fresh), "lost");
    assert.equal(stationState("observatory", fresh), "linked", "观测站带着报告回来，不依赖辨伪");
    const solved = pickReport(openOriginal(fresh), FAKE_REPORT);
    assert.equal(stationState("verify", solved), "linked");
  });

  test("一圈轨道：这圈的站全接通才算同步（才转起来）", () => {
    const gateIndex = STEPS.findIndex((step) => step.gate === true);
    const beforeObservatory = initialState(gateIndex - 1);
    assert.equal(ringSynced(1, beforeObservatory), false, "观测站没回来，第一圈不转");
    assert.equal(ringSynced(1, initialState(gateIndex)), true);
    assert.equal(ringSynced(3, initialState(STEP_COUNT - 3)), false);
    assert.equal(ringSynced(3, initialState(STEP_COUNT - 2)), true);
    assert.equal(Object.keys(stationStates(initialState(0))).length, STATIONS.length);
  });

  test("每座站先在前一步出场（台词里先说麻烦），功能截图在出场步之后才登场", () => {
    // 站的功能登场（它所属的截图步）不早于出场；出场那一步的台词承载麻烦（见 messages 的 steps.<id>.said）
    for (const id of STATION_IDS) {
      if (id === "pilot") continue;
      const wake = STEPS.findIndex((step) => step.wake?.includes(id) === true);
      const about = STEPS.findIndex((step) => step.about === id && step.shot !== undefined);
      if (about === -1) continue;
      assert.ok(about > wake, `${id}：功能截图步（${about}）应在出场步（${wake}）之后`);
    }
  });
});

describe("剧本里的功能各登场，且是真截图", () => {
  const featureShots: Record<string, StoryState["index"][]> = {};
  for (const [index, step] of STEPS.entries()) {
    if (step.shot === undefined) continue;
    (featureShots[`${step.shot.chapter}/${step.shot.page}`] ??= []).push(index);
  }

  test("每个带截图的步骤，都能从手册的数据表里取到取景（不是空占位）", () => {
    for (const step of STEPS) {
      if (step.shot === undefined) continue;
      const page = shotPage(step.shot);
      assert.ok(page, `${step.id} 的截图取景不存在：${step.shot.chapter}/${step.shot.page}`);
    }
  });

  test("接模型 / 文件夹 / 读 PDF / 浏览器 / 引用 / 子会话 / 计划 / 记忆 / Word·PPT / 插件 / 自动化 / 看板：各章都有登场点", () => {
    const chapters = STEPS.map((step) => step.shot?.chapter);
    for (const needed of ["start", "files", "task", "browser", "quote", "subsessions", "progress", "memory", "docs", "plugins", "automation", "board"]) {
      assert.ok(chapters.includes(needed as never), `缺 ${needed}`);
    }
    // 辨伪环节本身就是「引用核对」登场（用论文原文，不用截图）
    assert.equal(STEPS.some((step) => step.gate === true), true);
  });
});

describe("辨伪环节的原文", () => {
  test("甲的引文逐字出自原文；乙的引文在原文里找不到（编的）", () => {
    assert.ok(GATE_SOURCE.text.includes(REPORTS.a.quote), "甲的引文应是原文片段");
    assert.ok(!GATE_SOURCE.text.includes(REPORTS.b.quote), "乙的引文不该在原文里");
    assert.ok(GATE_SOURCE.text.includes(GATE_SOURCE.mark));
    assert.equal(FAKE_REPORT, "b");
  });

  test("原文列出的数据集数，与甲一致、比乙少一个", () => {
    const listed = GATE_SOURCE.text.match(/NYC-taxi, NYC-bike, NYC-crime, and CHI-taxi/);
    assert.ok(listed);
    assert.equal(REPORTS.a.datasets.length, 4);
    assert.equal(REPORTS.b.datasets.length, 5);
    assert.ok(!GATE_SOURCE.text.includes("CHI-bike"));
  });
});

describe("文案：每一步在中英两张表里都有台词", () => {
  for (const [name, table] of [["en", en], ["zh", zh]] as const) {
    test(`${name}：每步至少一句领航员台词；有 cue 的步骤有主按钮文字；有截图的步骤有「它替你解决了什么」`, () => {
      const steps = table.onboarding.story.steps as Record<string, { said: readonly string[]; cue?: string; solve?: string }>;
      for (const step of STEPS) {
        const copy = steps[step.id];
        assert.ok(copy, `${name} 缺 ${step.id}`);
        assert.ok(copy.said.length >= 1 && copy.said.every((line) => line.trim() !== ""), `${name}.${step.id} 台词为空`);
        if (step.cue === true) assert.ok(copy.cue, `${name}.${step.id} 缺 cue`);
        if (step.shot !== undefined && step.id !== "landing") assert.ok(copy.solve, `${name}.${step.id} 缺 solve`);
      }
    });
    test(`${name}：每座站都有名字与功能说明`, () => {
      for (const id of STATION_IDS) {
        const station = table.onboarding.story.stations[id];
        assert.ok(station.name !== "" && station.feature !== "");
      }
    });
  }

  test("台词里没有套话", () => {
    const banned = /赋能|一站式|强大的|全新体验|powerful|seamless|revolutionary/i;
    const all = JSON.stringify([en.onboarding.story.steps, zh.onboarding.story.steps]);
    assert.doesNotMatch(all, banned);
  });
});

describe("画风解析与布局", () => {
  test("纸面两档主题一律回落观测记录；其余按选择，缺席是观测记录", () => {
    assert.equal(effectiveStyle("lines", "copybook"), "observe");
    assert.equal(effectiveStyle("journal", "typescript"), "observe");
    assert.equal(effectiveStyle("lines", "light"), "lines");
    assert.equal(effectiveStyle("journal", "black"), "journal");
    assert.equal(effectiveStyle(undefined, "graphite"), "observe");
  });

  test("三种布局：站都在 600 × 600 里，每座非领航站都有连线，线路图的线只走 0 / 45 / 90 度", () => {
    for (const style of ["observe", "lines", "journal"] as const) {
      const layout = layoutOf(style);
      for (const id of STATION_IDS) {
        const node = layout.nodes[id];
        assert.ok(node.x >= 0 && node.x <= 600 && node.y >= 0 && node.y <= 600, `${style}.${id} 越界`);
        assert.equal(layout.links[id].length > 0, id !== "pilot", `${style}.${id} 连线数不对`);
      }
    }
    for (const segments of Object.values(layoutOf("lines").links)) {
      for (const seg of segments) {
        const dx = Math.abs(seg.x2 - seg.x1);
        const dy = Math.abs(seg.y2 - seg.y1);
        assert.ok(dx === 0 || dy === 0 || dx === dy, `线路图出现了非 0/45/90 度的线段 ${JSON.stringify(seg)}`);
      }
    }
  });

  test("观测记录：同一圈上的站离中心一样远；越外的圈越大", () => {
    const layout = layoutOf("observe");
    for (const station of STATIONS) {
      if (station.ring === 0) continue;
      const node = layout.nodes[station.id];
      const r = Math.hypot(node.x - 300, node.y - 300);
      assert.ok(Math.abs(r - ORBIT_RADIUS[station.ring]) < 0.5, `${station.id} 不在它的轨道上`);
    }
    assert.ok(ORBIT_RADIUS[1] < ORBIT_RADIUS[2] && ORBIT_RADIUS[2] < ORBIT_RADIUS[3]);
  });

  test("日志布局：卡片两两不重叠（宽 124 高 46）", () => {
    const nodes = Object.values(layoutOf("journal").nodes);
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        if (a === undefined || b === undefined) continue;
        const overlapX = Math.abs(a.x - b.x) < 128;
        const overlapY = Math.abs(a.y - b.y) < 50;
        assert.ok(!(overlapX && overlapY), `卡片 ${i} 与 ${j} 重叠`);
      }
    }
  });
});
