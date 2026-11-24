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
  assist,
  atGate,
  blocked,
  canAssist,
  choose,
  effectiveStyle,
  gateOpen,
  hintStation,
  initialState,
  isTappable,
  linkedCount,
  nextLabel,
  openOriginal,
  pickReport,
  pressNext,
  pressPrev,
  progressOf,
  ringSynced,
  shotPage,
  stationState,
  stationStates,
  stepOf,
  tapStation,
  useDemoSignal,
  wingMoons,
  type StationId,
  type StepId,
  type StoryState,
} from "./story-script.ts";
import { DRIFT, layoutOf, ORBIT_RADIUS } from "./story-layouts.ts";

const WITH_MODEL = { hasProvider: true };
const NO_MODEL = { hasProvider: false };

function at(id: StepId): StoryState {
  return initialState(STEPS.findIndex((step) => step.id === id));
}

/** 玩家老老实实把每一步的动作做对，一路走到末步；返回每一步「做完动作之后」的状态 */
function play(): StoryState[] {
  const seen: StoryState[] = [];
  let state = initialState();
  for (let guard = 0; guard < 100; guard += 1) {
    const task = stepOf(state.index).task;
    if (task?.kind === "tap") for (let i = 0; i < task.times; i += 1) state = tapStation(state, task.station, WITH_MODEL);
    else if (task?.kind === "pick") state = tapStation(state, task.correct, WITH_MODEL);
    else if (task?.kind === "sequence") for (const station of task.order) state = tapStation(state, station, WITH_MODEL);
    else if (task?.kind === "choose") state = choose(state, 0);
    else if (task?.kind === "gate") state = pickReport(openOriginal(state), FAKE_REPORT);
    seen.push(state);
    const next = pressNext(state);
    if (next === "finish") return seen;
    state = next;
  }
  throw new Error("剧本走不完");
}

describe("剧本结构", () => {
  test("步骤表与步骤 id 一一对应，且 id 不重复", () => {
    assert.deepEqual(STEPS.map((step) => step.id), [...STEP_IDS]);
    assert.equal(new Set(STEP_IDS).size, STEP_IDS.length);
    assert.equal(STEP_COUNT, STEP_IDS.length);
  });

  test("玩家动手的关键时刻至少 5 个（动作，不是点下一步），回话选项至少 3 处", () => {
    const tasks = STEPS.filter((step) => step.task !== undefined);
    assert.ok(tasks.length >= 5, `只有 ${tasks.length} 个动作`);
    const kinds = new Set(tasks.map((step) => step.task?.kind));
    for (const kind of ["tap", "pick", "sequence", "choose", "gate"]) assert.ok(kinds.has(kind as never), `缺 ${kind} 动作`);
    assert.ok(STEPS.filter((step) => step.reply !== undefined || step.task?.kind === "choose").length >= 3);
  });

  test("第三幕有转折：某座已接通的站又失步，要动手才锁回", () => {
    const step = STEPS.find((each) => each.relapse !== undefined);
    assert.ok(step);
    assert.equal(step.act, 3);
    assert.ok(step.task);
  });
});

describe("玩家一路做对：走得通", () => {
  test("每个动作做完才放行，走到末步后是 finish，十座站全接通", () => {
    const seen = play();
    assert.equal(seen.length, STEP_COUNT);
    const end = seen[seen.length - 1];
    assert.ok(end);
    assert.equal(linkedCount(end), STATION_IDS.length);
    assert.equal(pressNext(end), "finish");
  });

  test("接通数随步数不减（转折那一步除外：那一步开头少一座，动作做完补回）", () => {
    let last = 0;
    for (const state of play()) {
      const count = linkedCount(state);
      assert.ok(count >= last, `第 ${state.index} 步接通数倒退`);
      last = count;
    }
  });
});

describe("下一步不放行没做完的动作", () => {
  test("有动作没做完：pressNext 原样返回同一个对象；做完才翻页", () => {
    for (const step of STEPS.filter((each) => each.task !== undefined && each.task.kind !== "gate")) {
      const state = at(step.id);
      assert.equal(blocked(state), true, `${step.id} 开头就该是 blocked`);
      assert.equal(pressNext(state), state, `${step.id} 没做完不该翻页`);
      assert.equal(nextLabel(state), "wait");
      const done = assist(state);
      assert.equal(blocked(done), false);
      const next = pressNext(done);
      assert.notEqual(next, "finish");
      if (next !== "finish") assert.equal(next.index, state.index + 1);
    }
  });

  test("纯对话与回话步：直接下一步；回话不选也能走", () => {
    for (const id of ["wake", "archive", "verified", "memory", "chart"] as const) {
      const state = at(id);
      assert.equal(blocked(state), false, id);
      const next = pressNext(state);
      assert.notEqual(next, "finish");
    }
  });

  test("上一步直接退页，做过的动作保留；第一页再退原地不动", () => {
    let state = at("browse");
    state = tapStation(state, "observatory", WITH_MODEL);
    const next = pressNext(state);
    if (next === "finish") throw new Error("不该结束");
    const back = pressPrev(next);
    assert.equal(back.index, state.index);
    assert.equal(progressOf(back).done, true);
    const first = initialState(0);
    assert.equal(pressPrev(first), first);
  });

  test("主按钮文案：没做完 wait，做完 next，末页 finish", () => {
    assert.equal(nextLabel(at("power")), "wait");
    assert.equal(nextLabel(assist(at("power"))), "next");
    assert.equal(nextLabel(at("wake")), "next");
    assert.equal(nextLabel(at("landing")), "finish");
  });
});

describe("通电（点领航站）", () => {
  test("有模型：点领航站直接通电；点别的站没反应", () => {
    const state = at("power");
    assert.equal(isTappable(state, "pilot"), true);
    assert.equal(isTappable(state, "archive"), false);
    assert.equal(tapStation(state, "archive", WITH_MODEL), state);
    const done = tapStation(state, "pilot", WITH_MODEL);
    assert.equal(progressOf(done).done, true);
    assert.equal(stationState("pilot", done), "linked");
    assert.equal(progressOf(done).demo, false);
  });

  test("没有模型：点领航站不通电，亮出出口；可以先用演示信号走完", () => {
    const state = tapStation(at("power"), "pilot", NO_MODEL);
    assert.equal(progressOf(state).done, false);
    assert.equal(progressOf(state).needsModel, true);
    assert.equal(stationState("pilot", state), "lost");
    const demo = useDemoSignal(state);
    assert.equal(progressOf(demo).done, true);
    assert.equal(progressOf(demo).demo, true);
    assert.equal(useDemoSignal(at("browse")).index, at("browse").index);
  });

  test("回到有模型之后再点一次，真通电（demo 仍是 false）", () => {
    let state = tapStation(at("power"), "pilot", NO_MODEL);
    state = tapStation(state, "pilot", WITH_MODEL);
    assert.equal(progressOf(state).done, true);
    assert.equal(progressOf(state).demo, false);
  });

  test("通电之后点领航站不再累加", () => {
    const done = tapStation(at("power"), "pilot", WITH_MODEL);
    assert.equal(tapStation(done, "pilot", WITH_MODEL), done);
  });
});

describe("该派谁出门（在星图上点选）", () => {
  test("选对：观测站出发并接通；选错：记一次、记下是哪座、能重选", () => {
    let state = at("browse");
    assert.equal(stationState("archive", state), "linked", "档案读完了，到这一步已接通");
    assert.equal(stationState("observatory", state), "lost");
    for (const wrong of ["pilot", "archive", "verify", "wing", "route", "log", "hq", "protocol", "patrol"] as const) {
      assert.equal(isTappable(state, wrong), true);
      state = tapStation(state, wrong, WITH_MODEL);
      assert.equal(progressOf(state).done, false);
      assert.equal(progressOf(state).wrongStation, wrong);
    }
    assert.equal(progressOf(state).wrong, 9);
    state = tapStation(state, "observatory", WITH_MODEL);
    assert.equal(progressOf(state).done, true);
    assert.equal(stationState("observatory", state), "linked");
    assert.equal(tapStation(state, "verify", WITH_MODEL), state, "做完之后不再接受点选");
  });
});

describe("放出两架僚机（点僚机站两次）", () => {
  test("点一次是 1 架，两次才算做完；点别的站没反应；僚机数随点击涨", () => {
    let state = at("fires");
    assert.equal(wingMoons(state), 0);
    assert.equal(hintStation(state), "wing");
    assert.equal(tapStation(state, "route", WITH_MODEL), state);
    state = tapStation(state, "wing", WITH_MODEL);
    assert.equal(progressOf(state).done, false);
    assert.equal(wingMoons(state), 1);
    assert.equal(stationState("wing", state), "lost");
    state = tapStation(state, "wing", WITH_MODEL);
    assert.equal(progressOf(state).done, true);
    assert.equal(wingMoons(state), 2);
    assert.equal(stationState("wing", state), "linked");
    assert.equal(hintStation(state), undefined);
    assert.equal(tapStation(state, "wing", WITH_MODEL), state, "第三下不再加");
    const next = pressNext(state);
    if (next === "finish") throw new Error("不该结束");
    assert.equal(wingMoons(next), 2, "放出去的僚机留到故事结束");
  });
});

describe("按这次的顺序点三座站（存成协议）", () => {
  test("转折：观测站又失步、环不转；顺序对了才锁回并接通协议", () => {
    let state = at("protocol");
    assert.equal(stationState("observatory", state), "lost", "转折：已接通的观测站又失步了");
    assert.equal(ringSynced(1, state), false);
    assert.equal(stationState("protocol", state), "lost");
    state = tapStation(state, "archive", WITH_MODEL);
    state = tapStation(state, "observatory", WITH_MODEL);
    assert.deepEqual(progressOf(state).picks, ["archive", "observatory"]);
    assert.equal(progressOf(state).done, false);
    state = tapStation(state, "verify", WITH_MODEL);
    assert.equal(progressOf(state).done, true);
    assert.equal(stationState("observatory", state), "linked");
    assert.equal(stationState("protocol", state), "linked");
    assert.equal(ringSynced(1, state), true);
  });

  test("点错：从头来，并记下点错的是哪座；点错之后提示下一座该点谁", () => {
    let state = at("protocol");
    state = tapStation(state, "archive", WITH_MODEL);
    state = tapStation(state, "verify", WITH_MODEL);
    assert.deepEqual(progressOf(state).picks, []);
    assert.equal(progressOf(state).wrong, 1);
    assert.equal(progressOf(state).wrongStation, "verify");
    assert.equal(hintStation(state), "archive");
    state = tapStation(state, "hq", WITH_MODEL);
    assert.equal(progressOf(state).wrong, 2);
  });
});

describe("选项", () => {
  test("choose 动作：选完算做完、记下选了哪个；越界 / 重选无效", () => {
    let state = at("patrol");
    assert.equal(choose(state, 3), state);
    assert.equal(choose(state, -1), state);
    state = choose(state, 2);
    assert.equal(progressOf(state).choice, 2);
    assert.equal(progressOf(state).done, true);
    assert.equal(stationState("patrol", state), "linked");
    assert.equal(choose(state, 0), state, "做完之后不能改");
  });

  test("reply（非必答）：能选、不选也能往下走；选了不算动作", () => {
    let state = at("wake");
    state = choose(state, 1);
    assert.equal(progressOf(state).choice, 1);
    assert.equal(blocked(state), false);
    state = choose(state, 0);
    assert.equal(progressOf(state).choice, 0, "回话可以改主意");
    assert.equal(choose(at("verified"), 0).index, at("verified").index);
  });

  test("route / report 的选项不同，但殊途同归：都接通同一座站", () => {
    for (const id of ["route", "report"] as const) {
      const options = (stepOf(at(id).index).task as { options: number }).options;
      const outcomes = new Set<string>();
      for (let option = 0; option < options; option += 1) {
        const state = choose(at(id), option);
        outcomes.add(JSON.stringify(stationStates(state)));
      }
      assert.equal(outcomes.size, 1, `${id} 的各选项站点结果应一致`);
    }
  });
});

describe("辨伪环节", () => {
  test("没点开原文不能选；→ 只会替你翻开原文，不会替你选", () => {
    const start = at("reports");
    assert.equal(atGate(start), true);
    assert.equal(gateOpen(start), true);
    assert.equal(pickReport(start, FAKE_REPORT), start);
    const opened = pressNext(start);
    assert.notEqual(opened, "finish");
    if (opened === "finish") return;
    assert.equal(progressOf(opened).opened, true);
    assert.equal(progressOf(opened).done, false);
    assert.equal(pressNext(opened), opened, "原文开了也不替你选");
    assert.equal(progressOf(opened).picked, null);
  });

  test("选错记一次、能重选；选对过关、核验站接通；选对后不能再改", () => {
    let state = openOriginal(at("reports"));
    assert.equal(stationState("verify", state), "lost");
    state = pickReport(state, "a");
    assert.equal(progressOf(state).done, false);
    assert.equal(progressOf(state).wrong, 1);
    assert.equal(progressOf(state).picked, "a");
    state = pickReport(state, "a");
    assert.equal(progressOf(state).wrong, 2);
    state = pickReport(state, FAKE_REPORT);
    assert.equal(progressOf(state).done, true);
    assert.equal(progressOf(state).byPilot, false);
    assert.equal(stationState("verify", state), "linked");
    assert.equal(pickReport(state, "a"), state);
  });

  test("辨伪不给代劳（assist / canAssist 都不行）", () => {
    const state = openOriginal(at("reports"));
    assert.equal(canAssist(state), false);
    assert.equal(assist(state), state);
  });

  test("两条报告都说「四个数据集」，只差一个名字；乙的引文在原文里找不到，甲的逐字在", () => {
    assert.equal(REPORTS.a.datasets.length, 4);
    assert.equal(REPORTS.b.datasets.length, 4);
    const diff = REPORTS.b.datasets.filter((name) => !REPORTS.a.datasets.includes(name));
    assert.deepEqual(diff, ["CHI-bike"]);
    assert.ok(GATE_SOURCE.text.includes(REPORTS.a.quote), "甲的引文应是原文片段");
    assert.ok(!GATE_SOURCE.text.includes(REPORTS.b.quote), "乙的引文不该在原文里");
    assert.ok(GATE_SOURCE.text.includes(GATE_SOURCE.mark));
    assert.ok(!GATE_SOURCE.text.includes("CHI-bike"));
    assert.equal(FAKE_REPORT, "b");
  });
});

describe("代劳", () => {
  test("每种动作都能代劳完成（辨伪除外），并标记 byPilot；没动作 / 已做完原样返回", () => {
    for (const step of STEPS) {
      const state = at(step.id);
      if (step.task === undefined || step.task.kind === "gate") {
        assert.equal(assist(state), state, `${step.id} 没有可代劳的动作`);
        continue;
      }
      const done = assist(state);
      assert.equal(progressOf(done).done, true, step.id);
      assert.equal(progressOf(done).byPilot, true, step.id);
      assert.equal(assist(done), done);
    }
  });
});

describe("站点状态", () => {
  test("开场十座站全部失步，一座都没接通；领航站不偏、其余九座都有偏离量", () => {
    const state = initialState(0);
    for (const id of STATION_IDS) assert.equal(stationState(id, state), "lost");
    assert.equal(linkedCount(state), 0);
    assert.equal(Object.keys(DRIFT).length, STATION_IDS.length);
    for (const id of STATION_IDS.filter((each) => each !== "pilot")) {
      assert.ok(Math.hypot(DRIFT[id].x, DRIFT[id].y) >= 14, `${id} 偏得太少，看不出失步`);
    }
  });

  test("每座站最终都被某一步接通", () => {
    for (const id of STATION_IDS) {
      const linked = STEPS.some((step) => step.arrive?.includes(id) === true || step.link?.includes(id) === true);
      assert.ok(linked, `${id} 没有被任何一步接通`);
    }
  });

  test("一圈轨道：这圈的站全接通才算同步（才转起来）", () => {
    const states = play();
    const before = states[STEPS.findIndex((step) => step.id === "browse")];
    const after = states[STEPS.findIndex((step) => step.id === "protocol")];
    assert.ok(before && after);
    assert.equal(ringSynced(1, before), true, "档案站与观测站都接通，第一圈转");
    assert.equal(ringSynced(3, before), false);
    assert.equal(ringSynced(3, after), false, "巡航还没接，第三圈不转");
    assert.equal(ringSynced(3, states[states.length - 1] as StoryState), true);
    assert.equal(Object.keys(stationStates(initialState(0))).length, STATIONS.length);
  });
});

describe("剧本里的功能各登场，且是真截图", () => {
  test("每个带截图的步骤，都能从手册的数据表里取到取景", () => {
    for (const step of STEPS) {
      if (step.shot === undefined) continue;
      assert.ok(shotPage(step.shot), `${step.id} 的截图取景不存在：${step.shot.chapter}/${step.shot.page}`);
    }
  });

  test("接模型 / 文件夹 / 读 PDF / 浏览器 / 引用 / 子会话 / 计划 / 记忆 / Word·PPT / 插件 / 自动化 / 看板：各章都有登场点", () => {
    const chapters = STEPS.map((step) => step.shot?.chapter);
    for (const needed of ["start", "files", "browser", "quote", "subsessions", "progress", "memory", "docs", "plugins", "automation", "board"]) {
      assert.ok(chapters.includes(needed as never), `缺 ${needed}`);
    }
    assert.equal(STEPS.some((step) => step.task?.kind === "gate"), true);
  });
});

describe("文案：每一步在中英两张表里都有台词与对应的玩家文案", () => {
  for (const [name, table] of [["en", en], ["zh", zh]] as const) {
    test(`${name}：每步有领航员台词；有动作的步有任务提示、做完的回应；有选项的步选项数对得上；有截图的步有「解决了什么」`, () => {
      const steps = table.onboarding.story.steps as Record<
        string,
        { said: readonly string[]; task?: string; did?: string; after?: readonly string[]; options?: readonly { label: string; after: readonly string[] }[]; solve?: string }
      >;
      for (const step of STEPS) {
        const copy = steps[step.id];
        assert.ok(copy, `${name} 缺 ${step.id}`);
        assert.ok(copy.said.length >= 1 && copy.said.every((line) => line.trim() !== ""), `${name}.${step.id} 台词为空`);
        const task = step.task;
        if (task !== undefined) {
          assert.ok(copy.task && copy.task.trim() !== "", `${name}.${step.id} 缺任务提示`);
          if (task.kind === "choose") assert.equal(copy.options?.length, task.options, `${name}.${step.id} 选项数不对`);
          else assert.ok(copy.did && (copy.after?.length ?? 0) > 0, `${name}.${step.id} 缺做完后的回应`);
        }
        if (step.reply !== undefined) assert.equal(copy.options?.length, step.reply, `${name}.${step.id} 回话选项数不对`);
        for (const option of copy.options ?? []) assert.ok(option.label.trim() !== "" && option.after.length > 0);
        if (step.shot !== undefined && step.id !== "landing") assert.ok(copy.solve, `${name}.${step.id} 缺 solve`);
      }
    });
    test(`${name}：每座站有名字与功能说明；选错有解释（browse 每座站一条）`, () => {
      for (const id of STATION_IDS) {
        const station = table.onboarding.story.stations[id];
        assert.ok(station.name !== "" && station.feature !== "");
        const wrong = (table.onboarding.story.steps.browse as { pickWrong: Record<StationId, string> }).pickWrong;
        if (id !== "observatory") assert.ok(wrong[id] !== "", `${name} 缺 ${id} 的选错解释`);
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
        // 失步的偏离量加上去也不出图
        assert.ok(node.x + DRIFT[id].x >= 0 && node.x + DRIFT[id].x <= 600 && node.y + DRIFT[id].y >= 0 && node.y + DRIFT[id].y <= 600, `${style}.${id} 失步时出图`);
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
        assert.ok(!(Math.abs(a.x - b.x) < 128 && Math.abs(a.y - b.y) < 50), `卡片 ${i} 与 ${j} 重叠`);
      }
    }
  });
});
