import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PluginProblem } from "../../shared/plugin.ts";
import { parseWorkflow, WORKFLOW_MAX_STEPS } from "./workflow.ts";

const SKILLS = [
  { slug: "lit-scan", name: "文献扫描" },
  { slug: "lit-weekly", name: "lit-weekly" },
];

function parse(orbita: unknown): { steps: ReturnType<typeof parseWorkflow>; problems: PluginProblem[] } {
  const problems: PluginProblem[] = [];
  return { steps: parseWorkflow({ orbita }, SKILLS, problems), problems };
}

describe("parseWorkflow", () => {
  test("约定里的样例：四步，技能按 slug 或 name 对上，产出与说明原样带出", () => {
    const { steps, problems } = parse({
      workflow: [
        { title: "按理念检索", skill: "lit-scan", detail: "Semantic Scholar 搜 8 条理念" },
        { title: "滚一轮引用", skill: "文献扫描" },
        { title: "写进当日记录", output: "data/2026-11-05.jsonl" },
        { title: "每周汇总", skill: "lit-weekly" },
      ],
    });
    assert.deepEqual(problems, []);
    assert.deepEqual(steps, [
      { title: "按理念检索", skill: "lit-scan", skillSlug: "lit-scan", detail: "Semantic Scholar 搜 8 条理念", output: null, wait: null },
      { title: "滚一轮引用", skill: "文献扫描", skillSlug: "lit-scan", detail: null, output: null, wait: null },
      { title: "写进当日记录", skill: null, skillSlug: null, detail: null, output: "data/2026-11-05.jsonl", wait: null },
      { title: "每周汇总", skill: "lit-weekly", skillSlug: "lit-weekly", detail: null, output: null, wait: null },
    ]);
  });

  test("技能对不上：照常显示，skill 留着、skillSlug 为 null（界面据此标「找不到这个技能」）；不记成问题", () => {
    const { steps, problems } = parse({ workflow: [{ title: "x", skill: "不存在" }] });
    assert.deepEqual(steps, [{ title: "x", skill: "不存在", skillSlug: null, detail: null, output: null, wait: null }]);
    assert.deepEqual(problems, []);
  });

  test("没写 orbita / 没写 workflow / orbita 不是对象：空数组，不报问题", () => {
    for (const orbita of [undefined, null, "x", [], {}, { panel: {} }]) {
      const { steps, problems } = parse(orbita);
      assert.deepEqual(steps, []);
      assert.deepEqual(problems, []);
    }
  });

  test("workflow 不是数组：整块忽略并记问题", () => {
    const { steps, problems } = parse({ workflow: { title: "x" } });
    assert.deepEqual(steps, []);
    assert.deepEqual(problems, [{ kind: "workflow-invalid", detail: "orbita.workflow: not an array" }]);
  });

  test("坏的一步跳过并记下是哪一步，好的照留：不是对象、没有 title、title 是空白 / 非字符串", () => {
    const { steps, problems } = parse({ workflow: ["x", { skill: "lit-scan" }, { title: "   " }, { title: 5 }, null, { title: "好" }] });
    assert.deepEqual(steps.map((step) => step.title), ["好"]);
    assert.deepEqual(problems.map((problem) => problem.detail), [
      "orbita.workflow[0]: not an object",
      "orbita.workflow[1]: title is required",
      "orbita.workflow[2]: title is required",
      "orbita.workflow[3]: title is required",
      "orbita.workflow[4]: not an object",
    ]);
  });

  test("可选字段类型不对：当没写并记问题；空串当没写、不记", () => {
    const { steps, problems } = parse({ workflow: [{ title: "a", skill: 3, detail: {}, output: "" }] });
    assert.deepEqual(steps, [{ title: "a", skill: null, skillSlug: null, detail: null, output: null, wait: null }]);
    assert.deepEqual(problems.map((problem) => problem.detail), ["orbita.workflow[0].skill: not a string", "orbita.workflow[0].detail: not a string"]);
  });

  test("步骤数超上限：多出来的忽略并记一条；字段超长截断（清单是不可信输入）", () => {
    const many = Array.from({ length: WORKFLOW_MAX_STEPS + 5 }, (_, index) => ({ title: `步骤 ${index}` }));
    const { steps, problems } = parse({ workflow: many });
    assert.equal(steps.length, WORKFLOW_MAX_STEPS);
    assert.equal(problems.length, 1);
    const long = parse({ workflow: [{ title: "t".repeat(500), detail: "d".repeat(2000) }] });
    assert.equal(long.steps[0]?.title.length, 120);
    assert.equal(long.steps[0]?.detail?.length, 400);
    assert.equal(long.steps[0]?.title.endsWith("…"), true);
  });

  test("字段首尾空白去掉", () => {
    const { steps } = parse({ workflow: [{ title: "  a  ", skill: " lit-scan ", detail: "  d " }] });
    assert.equal(steps[0]?.title, "a");
    assert.equal(steps[0]?.skillSlug, "lit-scan");
    assert.equal(steps[0]?.detail, "d");
  });
});
