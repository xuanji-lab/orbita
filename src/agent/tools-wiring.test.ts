/**
 * 内建工具集接线 —— 走真会话的集成测试，**唯一能抓住 `tools` 白名单那个坑的测试**。
 *
 * 为什么必须有它：pi 有两条看起来都能「让 grep / find / ls 生效」的路——
 *
 *   (a) `createAgentSessionFromServices({ tools: [...] })`  ← 看着更直白；
 *   (b) `settingsManager.applyOverrides({ defaultTools: [...] })`  ← 实际用的。
 *
 * 两者在 pi 里语义不同：`tools` 是**全局白名单**，`_refreshToolRegistry` 里的
 * `isAllowedTool` **连自定义工具一起过滤**。2026-10-04 实测走 (a) 的后果——MCP、
 * read_pdf、read_docx、show_image、store / task / browser / channel 工具，以及 pi 自己的
 * ask_question / todo **全部静默消失，且不报错**。纯逻辑的单元测试看不见这件事
 * （名单、分桶、提示词全对），只有真把会话建起来才看得见。
 *
 * 另一条断言是这次改动的**因果**：pi 在「有 bash、而 grep/find/ls 一个都不在」时会给模型下
 * 一句 "Use bash for file operations like ls, rg, find"——搜索于是全走 shell。补上这三个，
 * 那句的触发条件不再成立。**要两个对照组**：只测「改后没有这句」在规则本来就不出现的
 * 情况下也会通过，那是空转的测试。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { ENABLED_BUILTIN_TOOLS } from "./permission.ts";

/** 要它消失的就是这句（pi: `system-prompt.ts`，条件写死） */
const BASH_FOR_FILE_OPS_RULE = "Use bash for file operations";

/** 改动前的 pi 默认集 */
const PI_DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

/** 假的自定义工具：MCP / read_pdf / browser_* 那一类，走 customTools 通道注册 */
const PROBE_CUSTOM_TOOL: ToolDefinition = {
  name: "orbita_probe_tool",
  label: "orbita_probe_tool",
  description: "接线探针用，不会被执行",
  parameters: { type: "object", properties: {} } as never,
  async execute() {
    return { content: [{ type: "text", text: "probe" }], details: undefined };
  },
};

/**
 * 真建一次会话。**defaultTools 一律显式给**，不吃用户全局 `~/.pi/agent/settings.json`
 * 里可能已有的值——否则这个测试会随开发机的配置飘。
 */
async function buildSession(options: { defaultTools?: string[]; tools?: string[] }) {
  const cwd = await mkdtemp(join(tmpdir(), "orbita-tools-wiring-"));
  try {
    const services = await createAgentSessionServices({
      cwd,
      resourceLoaderOptions: { noSkills: true, extensionFactories: [] },
    });
    if (options.defaultTools !== undefined) {
      services.settingsManager.applyOverrides({ defaultTools: options.defaultTools });
    }
    const sessionManager = SessionManager.create(cwd, join(cwd, "sessions"));
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
      customTools: [PROBE_CUSTOM_TOOL],
    });
    return { names: session.getActiveToolNames(), prompt: session.systemPrompt };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("内建工具集接线", () => {
  test("七个内建全在位，且自定义工具没被挤掉", async () => {
    const { names } = await buildSession({ defaultTools: [...ENABLED_BUILTIN_TOOLS] });

    for (const tool of ENABLED_BUILTIN_TOOLS) {
      assert.ok(names.includes(tool), `${tool} 该被启用`);
    }
    // 这条就是那个坑：改用 `tools` 白名单会让它（以及 MCP、read_pdf、browser…）消失
    assert.ok(
      names.includes(PROBE_CUSTOM_TOOL.name),
      "自定义工具被挤掉了——多半是有人把 defaultTools 改回了 tools 白名单",
    );
  });

  test("那句把模型推向 bash 的规则：改后消失，对照组里确实在", async () => {
    const withSearchTools = await buildSession({ defaultTools: [...ENABLED_BUILTIN_TOOLS] });
    assert.ok(
      !withSearchTools.prompt.includes(BASH_FOR_FILE_OPS_RULE),
      "有 grep / find / ls 就不该再给模型下「用 bash 干搜索」这句",
    );

    // 对照组：pi 默认四件套。不测这一组的话，上面那条断言在规则永不出现时也会通过
    const defaultTools = await buildSession({ defaultTools: PI_DEFAULT_TOOLS });
    assert.ok(
      defaultTools.prompt.includes(BASH_FOR_FILE_OPS_RULE),
      "对照组里那句规则本该在——没有它，这个测试什么都没证明",
    );
    assert.ok(!defaultTools.names.includes("grep"), "对照组不该有 grep");
  });

  /**
   * 反证：把「为什么不用 `tools`」钉成**可执行的事实**，而不是注释里的传说。
   *
   * 这条断言的是**pi 的缺陷**，所以它失败是好消息：说明哪天 pi 不再拿 `tools` 当全局
   * 白名单，`defaultTools` 这条弯路就可以撤，改回更直白的 `tools: [...]`。
   * 失败时读上面那句断言消息就知道该干什么。
   */
  test("反证：tools 白名单会挤掉自定义工具（这就是不用它的原因）", async () => {
    const { names } = await buildSession({ tools: [...ENABLED_BUILTIN_TOOLS] });
    assert.ok(
      !names.includes(PROBE_CUSTOM_TOOL.name),
      "pi 不再把 tools 当全局白名单了？那 defaultTools 这条弯路可以撤、改回 tools: [...]",
    );
  });
});
