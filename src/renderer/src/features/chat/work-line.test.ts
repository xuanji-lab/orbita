import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptItem } from "@shared/transcript";
import { activityOfTool, currentPlanStep, isQuiet, latestSentence, sanitizeWorkLine, workFacts, workLine, type WorkLineWords } from "./work-line.ts";

/** 可测的规则：洗出来的句子里不得有这些 */
function assertClean(out: string): void {
  assert.doesNotMatch(out, /(?:^|\s)[/~\\]/, `路径分隔符开头的片段：${out}`);
  assert.doesNotMatch(out, /[A-Za-z]:\\|\w\/\w/, `路径：${out}`);
  assert.doesNotMatch(out, /https?:|www\./i, `网址：${out}`);
  assert.doesNotMatch(out, /`/, `反引号：${out}`);
  assert.doesNotMatch(out, /--?[a-z]/, `命令行开关：${out}`);
  assert.doesNotMatch(out, /\b[A-Za-z]+\d|\d+[A-Za-z]|#\d+|\b[a-z]+[A-Z]|\b\w+[-_.]\w+/, `英文代号：${out}`);
}

// 真实样本：来自子会话的回报、进度笔记与 #488 验收时用户截图里露出来的那类句子
const SAMPLES: [string, string | null][] = [
  ["`bun run test` 跑完了，7389 条里只红已知的 4 个", "跑完了，7389 条里只红已知的 4 个"],
  ["打开 https://github.com/xuanji-lab/orbita/pull/488 看评论", "打开看评论"],
  ["在改 src/main/channel/requests.ts 里的 applyChannelSend", null],
  ["HEAD = 3da955ce，worktree 干净，未 push。", null],
  ["第 6 组前半：自写基底提示 + 其余符号", "第 组前半：自写基底提示 + 其余符号"],
  ["读 /Users/guanhongli/Library/Application Support/orbita/workbenches/x/progress.md 末尾几节", "读 Support 末尾几节"],
  ["正在跑 kernel-e6 的对照台，等 39 个场景跑完", "正在跑的对照台，等 39 个场景跑完"],
  ["rm -rf node_modules && bun install", null],
  ["用 ~/Documents/repo/pi 里的上游源码对照 runTurn", "用里的上游源码对照"],
  ["在 C:\\code\\orbita 起 Windows 实例验收 " + "#" + "488", "在起 Windows 实例验收"],
  ["**换工具**：四件换成 pi-durable/tools", "换工具：四件换成"],
  ["```bash\nnode --test src/agent/kernel.test.ts\n```", null],
  ["Reading the session store to see how marks are written.", "Reading the session store to see how marks are written."],
];

describe("sanitizeWorkLine：永远不露出命令、网址、路径、英文代号", () => {
  for (const [input, expected] of SAMPLES) {
    it(input.slice(0, 30), () => {
      const out = sanitizeWorkLine(input);
      if (expected === null) assert.equal(out, "", `应当整句作废：${out}`);
      else assertClean(out);
      if (expected !== null) assert.ok(out.length > 0);
    });
  }
  it("超长截断加省略号", () => {
    const out = sanitizeWorkLine("这是一句很长很长的话".repeat(10));
    assert.ok(out.length <= 40 && out.endsWith("…"));
  });
});

describe("latestSentence：最后一段的第一句", () => {
  it("取最后一段、第一句", () => {
    assert.equal(latestSentence("先看了一圈。\n\n接下来改投递逻辑。然后补测试。"), "接下来改投递逻辑。");
    assert.equal(latestSentence("I checked it. Next I will fix the queue. Then tests."), "I checked it.");
  });
});

const words: WorkLineWords = {
  activity: { command: "正在跑命令", read: "正在读文件", edit: "正在改文件", web: "正在查网页", delegate: "正在派活", think: "正在想", work: "正在干活" },
  waiting: (step, who) => `${step} · ${who}`,
};

describe("workLine：来源顺序 刚说的话 → 计划在做的步 → 书记员 → 不带参数的动作", () => {
  it("刚说的话洗得出来就用它", () => {
    assert.deepEqual(workLine({ said: "我先把队列的合并逻辑改掉", planStep: { text: "改投递", status: "in_progress" }, clerk: null, activity: "command" }, words), { text: "我先把队列的合并逻辑改掉", source: "said" });
  });
  it("刚说的话只剩命令（洗空）：退到计划在做的那步；在等的步带上在等谁", () => {
    assert.deepEqual(workLine({ said: "`bun run test`", planStep: { text: "跑全量测试", status: "in_progress" }, clerk: null, activity: "command" }, words), { text: "跑全量测试", source: "plan" });
    assert.deepEqual(workLine({ said: null, planStep: { text: "合并前验收", status: "waiting", waitingFor: "等你点头" }, clerk: null, activity: null }, words), { text: "合并前验收 · 等你点头", source: "plan" });
  });
  it("都没有：书记员（接口）→ 不带参数的动作；全无 = null", () => {
    assert.deepEqual(workLine({ said: null, planStep: null, clerk: "在对照两版的请求", activity: "command" }, words), { text: "在对照两版的请求", source: "clerk" });
    assert.deepEqual(workLine({ said: "https://example.com", planStep: { text: "src/a.ts", status: "in_progress" }, clerk: null, activity: "command" }, words), { text: "正在跑命令", source: "activity" });
    assert.equal(workLine({ said: null, planStep: null, clerk: null, activity: null }, words), null);
  });
});

describe("workFacts / currentPlanStep / activityOfTool", () => {
  const assistant = (text: string): TranscriptItem => ({ id: `a${text}`, role: "assistant", content: [{ type: "text", text }], timestamp: 1, status: "complete", model: { provider: "p", id: "m" } }) as unknown as TranscriptItem;
  const tool = (name: string, status: "running" | "complete"): TranscriptItem => ({ id: `t${name}`, role: "tool", toolCallId: `c${name}`, toolName: name, input: {}, content: [], status, timestamp: 2 }) as unknown as TranscriptItem;
  it("在跑的命令 → command；刚说的话取最近一条回答；用户消息之前的不算", () => {
    const items = [assistant("旧的话。"), { id: "u", role: "user", content: [], timestamp: 0 } as unknown as TranscriptItem, assistant("我先跑一遍测试。"), tool("bash", "running")];
    assert.deepEqual(workFacts(items, true), { said: "我先跑一遍测试。", activity: "command" });
    assert.deepEqual(workFacts(items.slice(0, 2), true), { said: null, activity: "work" });
    assert.deepEqual(workFacts(items, false), { said: "我先跑一遍测试。", activity: null });
  });
  it("计划：in_progress 优先，其次 waiting", () => {
    assert.equal(currentPlanStep([{ text: "a", status: "done" }, { text: "b", status: "waiting" }, { text: "c", status: "in_progress" }])?.text, "c");
    assert.equal(currentPlanStep([{ text: "b", status: "waiting" }])?.text, "b");
    assert.equal(currentPlanStep(null), null);
  });
  it("工具名映射", () => {
    assert.equal(activityOfTool("bash"), "command");
    assert.equal(activityOfTool("read_pdf"), "read");
    assert.equal(activityOfTool("browser_navigate"), "web");
    assert.equal(activityOfTool("whatever"), "work");
  });
});

describe("isQuiet：没有新动作且命令没有新输出（都算 progress）超过阈值才算", () => {
  it("在跑 + 超过阈值 = 没动静；没在跑 / 不知道时间 / 没到阈值 = 不算", () => {
    assert.equal(isQuiet(10 * 60_000, true, 0), true);
    assert.equal(isQuiet(10 * 60_000, false, 0), false);
    assert.equal(isQuiet(10 * 60_000, true, null), false);
    assert.equal(isQuiet(10 * 60_000, true, 9 * 60_000), false);
  });
});
