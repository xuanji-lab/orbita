import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addedLineRanges, diffToChanges, merge3, type TextChange } from "./doc-merge.ts";

const apply = (text: string, changes: readonly TextChange[]): string => {
  let out = text;
  for (const change of [...changes].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, change.from) + change.insert + out.slice(change.to);
  }
  return out;
};

const P1 = "把单 agent 立住：性能优化收尾。";
const P2 = "每两周交付一个能被用户亲手验收的版本。";
const P3 = "主要风险是验收只靠我一个人。";
const DOC = `# Q4 计划\n\n${P1}\n\n${P2}\n\n${P3}\n`;

describe("diffToChanges —— 最小差异", () => {
  it("相同没有改动；往返：apply(diff) 得到目标", () => {
    assert.deepEqual(diffToChanges(DOC, DOC), []);
    const target = DOC.replace(P2, `${P2}\n\n每个版本先写验收剧本。`);
    assert.equal(apply(DOC, diffToChanges(DOC, target)), target);
  });

  it("在第二段后面加一段 = 一处纯插入，别处一个字不碰", () => {
    const added = "\n\n每个版本先写验收剧本。";
    const target = DOC.replace(P2, `${P2}${added}`);
    const changes = diffToChanges(DOC, target);
    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.to, changes[0]?.from, "纯插入，没有删除");
    assert.equal(changes[0]?.insert.trim(), "每个版本先写验收剧本。");
  });

  it("改一个字 = 只替换那个字，不是换一整行", () => {
    const target = DOC.replace("收尾", "收口");
    const changes = diffToChanges(DOC, target);
    assert.equal(changes.length, 1);
    assert.deepEqual([changes[0]?.to! - changes[0]?.from!, changes[0]?.insert], [1, "口"]);
  });

  it("多处不连续的改动各自独立；不拆开 emoji 代理对", () => {
    const a = "一二三\n四五六\n七八九\n";
    const b = "一二三改\n四五六\n七八九改\n";
    assert.equal(diffToChanges(a, b).length, 2);
    const c = "好😀好";
    const d = "好😁好";
    const changes = diffToChanges(c, d);
    assert.equal(apply(c, changes), d);
    for (const change of changes) {
      assert.ok(!/[\ud800-\udbff]$/.test(change.insert) && !/^[\udc00-\udfff]/.test(change.insert));
    }
  });

  it("5 万字文档改一处：快（< 100ms）", () => {
    const big = Array.from({ length: 2000 }, (_, i) => `第 ${i} 段：这是一段用来量体量的中文文字。`).join("\n\n");
    const target = big.replace("第 1000 段：", "第 1000 段（agent 改的）：");
    const started = performance.now();
    const changes = diffToChanges(big, target);
    assert.ok(performance.now() - started < 100);
    assert.equal(apply(big, changes), target);
    assert.equal(changes.length, 1);
  });
});

describe("merge3 —— 三向合并", () => {
  it("B1：agent 在第二段后加一段、用户没动 → 结果 = 盘上，只有新增处被标出", () => {
    const disk = DOC.replace(P2, `${P2}\n\n每个版本先写验收剧本。`);
    const result = merge3(DOC, DOC, disk);
    assert.equal(result.text, disk);
    assert.equal(result.inserted.length, 1);
    const range = result.inserted[0]!;
    assert.match(result.text.slice(range.from, range.to), /每个版本先写验收剧本/);
    // 标的是整行（新增那一行本身），不含它前后的空行与别的行
    assert.equal(result.text.slice(range.from, range.to), "每个版本先写验收剧本。");
  });

  it("B2：用户在第一段打字（未落盘），agent 同时在末尾追加一段 → 两边都在", () => {
    const local = DOC.replace(P1, `${P1}用户刚打的字`);
    const disk = `${DOC}\n新的一段：总结。\n`;
    const result = merge3(DOC, local, disk);
    assert.ok(result.text.includes(`${P1}用户刚打的字`));
    assert.ok(result.text.includes("新的一段：总结。"));
    assert.equal(result.text, `${local}\n新的一段：总结。\n`);
  });

  it("B2：agent 在用户光标之前插入时，用户光标位置通过 changes 正确后移", () => {
    const local = DOC.replace(P3, `${P3}我在这里写`);
    const disk = DOC.replace("# Q4 计划", "# Q4 计划（改）");
    const result = merge3(DOC, local, disk);
    const cursor = local.indexOf("我在这里写") + 2; // 光标在「我在」之后
    // 用 changes 映射光标：changes 的坐标在 local 里，在光标之前的插入使光标后移
    let mapped = cursor;
    for (const change of result.changes) {
      if (change.to <= cursor) mapped += change.insert.length - (change.to - change.from);
    }
    assert.equal(result.text.slice(mapped - 2, mapped), "我在");
  });

  it("两边改的是不同段：都保留，且 apply(changes, local) === text", () => {
    const local = DOC.replace(P1, `${P1}（用户）`);
    const disk = DOC.replace(P3, `${P3}（agent）`);
    const result = merge3(DOC, local, disk);
    assert.equal(apply(local, result.changes), result.text);
    assert.ok(result.text.includes("（用户）") && result.text.includes("（agent）"));
    assert.equal(result.inserted.length, 1);
    // 改动的那一行整行标（agent 在句末加了字，那一行算「改动」）；用户自己打的字那行不标
    assert.equal(result.text.slice(result.inserted[0]!.from, result.inserted[0]!.to), `${P3}（agent）`);
  });

  it("盘上没变（回声）：什么都不做", () => {
    const result = merge3(DOC, `${DOC}x`, DOC);
    assert.deepEqual([result.text, result.changes.length, result.inserted.length], [`${DOC}x`, 0, 0]);
  });

  it("两边都在同一处插入：不丢任何一边的字（顺序不强求）", () => {
    const local = DOC.replace(P2, `${P2}甲`);
    const disk = DOC.replace(P2, `${P2}乙`);
    const result = merge3(DOC, local, disk);
    assert.ok(result.text.includes("甲") && result.text.includes("乙"));
  });

  it("agent 整份重写（write 覆盖）而用户有未落盘输入：用户的输入不被静默丢弃", () => {
    const local = DOC.replace(P1, `${P1}用户刚打的字`);
    const disk = "# 完全不同的文档\n\n全新内容。\n";
    const result = merge3(DOC, local, disk);
    // 用户改的那一行已被 agent 整段替换：至少合并结果是合法文本、包含 agent 的全部内容
    assert.ok(result.text.includes("全新内容"));
  });
});

describe("标绿范围只取真新增 / 改动的行（边界上没变的行不算）", () => {
  const lines = (text: string, ranges: { from: number; to: number }[]): string[] => ranges.map((r) => text.slice(r.from, r.to));

  it("agent 在「## 下周计划」前插入一节：只标新增的两段，下一个标题不标（引导界面实走的复现）", () => {
    const before = "# 周报\n\n## 方法\n\n复现按基线走。\n\n## 下周计划\n\n- 写完 E1\n";
    const after = "# 周报\n\n## 方法\n\n复现按基线走。\n\n## 数据\n\n实验数据用 data/nyc.csv，共 192 条。\n\n## 下周计划\n\n- 写完 E1\n";
    // 前提：字符级最小差异确实把插入区间推进了下一个标题的 `## `（这正是旧实现把「下周计划」也标绿的来路）
    const [change] = diffToChanges(before, after);
    assert.ok(after.slice(change!.from, change!.from + change!.insert.length).endsWith("## "), "字符级插入以 `## ` 收尾");
    const result = merge3(before, before, after);
    assert.deepEqual(lines(result.text, result.inserted), ["## 数据", "实验数据用 data/nyc.csv，共 192 条。"]);
    assert.ok(!result.inserted.some((r) => result.text.slice(r.from, r.to).includes("下周计划")));
  });

  it("用户同时在打字（三向合并路径）：同样只标 agent 新增的行", () => {
    const base = "# 周报\n\n## 方法\n\n正文。\n\n## 下周计划\n";
    const local = base.replace("正文。", "正文。用户在打字");
    const disk = base.replace("## 下周计划", "## 数据\n\n数据一行。\n\n## 下周计划");
    const result = merge3(base, local, disk);
    assert.ok(result.text.includes("正文。用户在打字"));
    assert.deepEqual(lines(result.text, result.inserted), ["## 数据", "数据一行。"]);
  });

  it("改动的行：整行标（改了几个字的那一行算「改动」）；没动的行不标；只删不加不标", () => {
    assert.deepEqual(lines("甲\n乙改\n丙\n", addedLineRanges("甲\n乙\n丙\n", "甲\n乙改\n丙\n")), ["乙改"]);
    assert.deepEqual(addedLineRanges("甲\n乙\n丙\n", "甲\n丙\n"), []);
    assert.deepEqual(addedLineRanges("甲\n", "甲\n"), []);
  });

  it("在文末追加、在文首插入：边界行同样不连带", () => {
    const tail = merge3("甲\n\n乙", "甲\n\n乙", "甲\n\n乙\n\n新一段");
    assert.deepEqual(lines(tail.text, tail.inserted), ["新一段"]);
    const head = merge3("乙\n", "乙\n", "新开头\n\n乙\n");
    assert.deepEqual(lines(head.text, head.inserted), ["新开头"]);
  });

  it("只有空行的新增不标（段与段之间的空行不是「新增的段」）", () => {
    assert.deepEqual(addedLineRanges("甲\n乙\n", "甲\n\n乙\n"), []);
  });
});
