// 过程行动词表覆盖每一个内置工具：内建四件与 createTurnTools 装出的每个工具（根会话全开 + 主智能体 + 子会话）
// 在过程行里都要有中文动词，不落「用工具」+ 英文原名。以后新加工具漏了补词，这里就红。
// 放在 scripts/ 而不是 src/ 下：它同时读 agent（node 工程）与 renderer（web 工程）两边的模块，两份 tsconfig 都不收跨工程的文件。
import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestBroker } from "../src/agent/request-broker.ts";
import { createTurnTools, turnToolFlags } from "../src/agent/turn-tools.ts";
import { eventVerb } from "../src/renderer/src/features/chat/turn-events.ts";
import { toolWord } from "../src/renderer/src/features/chat/builtin-commands.ts";
import { zh } from "../src/renderer/src/messages-zh.ts";

test("每个内置工具在过程行里都有中文动词", () => {
  const base = { type: "submit", sessionId: "s", text: "", cwd: "/tmp", workspaceId: null, provider: {}, modelId: "m", thinkingLevel: "off", piSessionDir: "/tmp", attachmentsDir: "/tmp", protectedPaths: [], protectedFiles: [], skillsDirs: [], mcpServers: {} };
  const root = { ...base, sessionMemory: true, automationTools: true, pluginTools: true, mainAgent: true, pdfCitations: true };
  const child = { ...base, directories: { workbench: "/tmp/w", attached: [], related: [{ sessionId: "p", relation: "parent", label: "p", path: "/tmp/p" }] } };
  const names = new Set(["bash", "read", "write", "edit"]);
  for (const command of [root, child]) {
    const tools = createTurnTools({ command, flags: turnToolFlags(command), broker: new RequestBroker(() => undefined), mcpTools: [], planOptions: { branch: () => [], state: { stopping: false } }, branch: () => [], attachedImages: () => [], memoryTurn: () => 1 });
    for (const tool of tools) names.add(tool.name);
  }
  assert.ok(names.size > 50, `工具名单不该这么短：${names.size}`);
  // 不进「工具」那一行的：改计划 / 改目标 / 派活 / 回话各自是一行来往（processEvents 先接走）
  const ownRows = new Set(["update_plan", "update_goal", "delegate", "reply_subsession"]);
  const missing = [...names].filter((name) => !ownRows.has(name)).filter((name) => eventVerb(name, name, zh.chat.procVerb, toolWord(zh.chat.rollupTool, name)).raw !== null);
  assert.deepEqual(missing, [], `这些工具在过程行里没有中文动词（新加工具记得补 procVerb）：${missing.join(", ")}`);
});
