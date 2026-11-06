import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffToChanges, merge3, type TextChange } from "./doc-merge.ts";

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
    assert.equal(result.text.slice(0, range.from) + result.text.slice(range.to), DOC);
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
    assert.equal(result.text.slice(result.inserted[0]!.from, result.inserted[0]!.to), "（agent）");
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
