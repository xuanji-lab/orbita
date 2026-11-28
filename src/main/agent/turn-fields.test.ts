/**
 * turnFields 的账（从 ipc.ts 抽出来的纯函数，2026-10-11）：renderer 载荷 →
 * 开轮命令的公共字段。workspaceName 的透传是 scope 指引（store-tools）的
 * 主进程侧接线——缺席时彻底不进命令对象（「翻不出名字」与「无工作区」两态
 * 靠 workspaceId 区分，不能靠键在不在猜）。
 *
 * computerUse 从 boolean 长成「开关 + 沙箱出网」的现场（2026-10-25）：模型需要知道
 * 沙箱这次有没有网，才能不把「网页打不开」当成网站的错去反复重试。
 * 2026-11-27 又长了一格 platformSupported：电脑使用只在 Windows 上存在，非 Windows
 * 上 runtime 据此不注册 computer_* / sandbox_*（见 shared/computer-use-platform.ts）。
 *
 * 设置 → 命令那段映射（`computerUseTurnContext`）同样在这里钉：真正的读取点
 * `readComputerUse()` 在 ipc.ts（要 electron，起不来），所以「哪个开关管注册、
 * 平台怎么归、老 settings.json 缺字段兑什么缺省」只能在这层测。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computerUseTurnContext, turnFields } from "./turn-fields.ts";
import { computerUseTurnPlan } from "../../agent/computer-tools.ts";
import { createSandboxBrowserTools } from "../../agent/sandbox-tools.ts";
import { RequestBroker } from "../../agent/request-broker.ts";
import { computerUseNetworkGuideline } from "../../agent/computer-network.ts";
import type { AppSettings, CompactionSetting } from "../../shared/settings.ts";

const input = {
  sessionId: "s1",
  cwd: "/tmp/x",
  workspaceId: "ws-1",
  providerId: "p",
  modelId: "m",
  thinkingLevel: "medium",
  resume: null,
} as const;

const provider = { id: "p", label: "P", models: {}, apiKey: "k" } as never;

const environment = {
  skillsDirs: [],
  directories: { attached: [], workbench: "/tmp/wb" },
  mcpServers: {},
  compaction: { enabled: true } as CompactionSetting,
  gitAttribution: true,
  attributionLanguage: "en" as const,
  computerUse: { enabled: true, platformSupported: true, allowNetwork: true, networkControlled: true },
  planFirst: false,
  pluginTools: false,
};

describe("turnFields", () => {
  test("workspaceName 有值：透传进命令", () => {
    const fields = turnFields(input, provider, "/pi", "/sessions/s1.attachments", [], { ...environment, workspaceName: "论文 3" });
    assert.equal(fields.workspaceName, "论文 3");
    assert.equal(fields.workspaceId, "ws-1");
    assert.equal(fields.sessionId, "s1");
  });

  test("workspaceName 缺席（旧夹具 / 工作区已删）：键彻底不出现，不是 undefined 挂着", () => {
    const fields = turnFields(input, provider, "/pi", "/sessions/s1.attachments", [], environment);
    assert.equal("workspaceName" in fields, false);
    assert.equal(fields.workspaceId, "ws-1");
  });

  test("无工作区（workspaceId null）：照常，name 自然缺席", () => {
    const fields = turnFields({ ...input, workspaceId: null }, provider, "/pi", "/sessions/s1.attachments", [], environment);
    assert.equal(fields.workspaceId, null);
    assert.equal("workspaceName" in fields, false);
  });

  test("pluginTools 原样进命令：开 = true，关 = false", () => {
    assert.equal(turnFields(input, provider, "/pi", "/a", [], { ...environment, pluginTools: true }).pluginTools, true);
    assert.equal(turnFields(input, provider, "/pi", "/a", [], environment).pluginTools, false);
  });

  // 续会话的唯一通路：renderer 的 resume → 命令的 piSessionFile → runtime 的 SessionManager.open。
  // 抽 turn-fields.ts 时漏过这一行（2026-10-11），每轮都新建 pi 本子：模型看不到前文，
  // created 事件又把 meta 改指到新本子上，回退随之对不上账
  test("resume 有值：piSessionFile 透传进命令（续跑旧本子）", () => {
    const fields = turnFields(
      { ...input, resume: { piSessionFile: "/pi/2026-10-09_book.jsonl" } },
      provider,
      "/pi",
      "/sessions/s1.attachments",
      [],
      environment,
    );
    assert.equal(fields.piSessionFile, "/pi/2026-10-09_book.jsonl");
  });

  test("权限档不进开轮命令（旧输入即使多带了，也不会被转发）", () => {
    const fields = turnFields({ ...input, mode: "plan" } as never, provider, "/pi", "/a", [], environment);
    assert.equal("mode" in fields, false);
  });

  test("「先给我看计划」偏好随命令发给 agent（runtime 据此决定第一张新计划后停不停）", () => {
    assert.equal(turnFields(input, provider, "/pi", "/a", [], { ...environment, planFirst: true }).planFirst, true);
    assert.equal(turnFields(input, provider, "/pi", "/a", [], environment).planFirst, false);
  });

  test("resume 为 null（新会话）：piSessionFile 键彻底不出现——runtime 据此新建、主进程据此等 created", () => {
    const fields = turnFields(input, provider, "/pi", "/sessions/s1.attachments", [], environment);
    assert.equal("piSessionFile" in fields, false);
  });

  test("computerUse 整份透传：开关、平台支持、沙箱出网与「后端能不能真断」四个事实都在命令里（提示词与工具注册靠它们分叉）", () => {
    const fields = turnFields(input, provider, "/pi", "/sessions/s1.attachments", [], {
      ...environment,
      // L2b 的那一对：用户关了出网，但这个后端断不了——两个事实必须各自到达 agent
      computerUse: { enabled: true, platformSupported: true, allowNetwork: false, networkControlled: false },
    });
    assert.deepEqual(fields.computerUse, {
      enabled: true,
      platformSupported: true,
      allowNetwork: false,
      networkControlled: false,
    });
  });
});

/**
 * 设置 → 开轮命令这段映射。ipc.ts 里那一行就是
 * `computerUseTurnContext(await settings.read())`，所以钉住这个纯函数 = 钉住
 * `readComputerUse()` 的行为；submit / interrupt / compact 三条命令都由 turnFields
 * 的产物铺底（`{ ...turnFields(...) }`），字段形状由 AgentCommand 的类型约束
 * （三处都是 ComputerUseTurnContext，typecheck 把关）。
 */
describe("computerUseTurnContext（设置 → 命令）", () => {
  /** 设置夹具：只给与电脑使用有关的键，其余取默认（theme / drawer 是 AppSettings 的必填项） */
  const settings = (value: {
    experimentalFeatures?: Record<string, boolean>;
    computerUse?: { allowNetwork?: boolean; backend?: "wsb" | "isolation-session" | "qemu" };
  }): AppSettings => ({ theme: "system", drawer: { width: 320, docked: [] }, ...value }) as AppSettings;

  test("开着且允许出网：enabled 与 allowNetwork 各自取自己的键，Windows 上平台支持为真，缺省后端 wsb 能断网", () => {
    assert.deepEqual(
      computerUseTurnContext(
        settings({ experimentalFeatures: { "computer-use": true }, computerUse: { allowNetwork: true } }),
        "win32",
      ),
      { enabled: true, platformSupported: true, allowNetwork: true, networkControlled: true },
    );
  });

  test("非 win32：platformSupported 为 false（开关开着也一样——工具组不注册）", () => {
    const on = settings({ experimentalFeatures: { "computer-use": true } });
    assert.deepEqual(computerUseTurnContext(on, "darwin"), {
      enabled: true,
      platformSupported: false,
      allowNetwork: true,
      networkControlled: true,
    });
    assert.equal(computerUseTurnContext(on, "linux").platformSupported, false);
    assert.equal(computerUseTurnContext(on, "freebsd").platformSupported, false);
  });

  test("开着但禁出网（wsb / qemu）：这正是要告诉模型的那一对值——关着且做得到", () => {
    for (const backend of ["wsb", "qemu"] as const) {
      assert.deepEqual(
        computerUseTurnContext(
          settings({ experimentalFeatures: { "computer-use": true }, computerUse: { allowNetwork: false, backend } }),
          "win32",
        ),
        { enabled: true, platformSupported: true, allowNetwork: false, networkControlled: true },
        backend,
      );
    }
  });

  test("L2b 上禁出网：开关是关的，但这个后端断不了——networkControlled 必须为 false（提示词据此改口）", () => {
    assert.deepEqual(
      computerUseTurnContext(
        settings({
          experimentalFeatures: { "computer-use": true },
          computerUse: { allowNetwork: false, backend: "isolation-session" },
        }),
        "win32",
      ),
      { enabled: true, platformSupported: true, allowNetwork: false, networkControlled: false },
    );
    // 开着的时候它当然也「能出网」——两格各自如实，跟 allowNetwork 不合并
    assert.equal(
      computerUseTurnContext(
        settings({ computerUse: { allowNetwork: true, backend: "isolation-session" } }),
        "win32",
      ).networkControlled,
      false,
    );
  });

  test("功能开关关着：enabled 为 false，allowNetwork 仍如实反映设置（工具不注册，但字段不留谎）", () => {
    assert.deepEqual(computerUseTurnContext(settings({ computerUse: { allowNetwork: false } }), "win32"), {
      enabled: false,
      platformSupported: true,
      allowNetwork: false,
      networkControlled: true,
    });
    // 其它实验开关开着不算「电脑使用开着」
    assert.deepEqual(computerUseTurnContext(settings({ experimentalFeatures: { "pdf-citations": true } }), "win32"), {
      enabled: false,
      platformSupported: true,
      allowNetwork: true,
      networkControlled: true,
    });
  });

  test("computerUse 字段缺席（老 settings.json）：enabled 关、allowNetwork 按缺省允许（#329 的 effectiveAllowNetwork）", () => {
    assert.deepEqual(computerUseTurnContext(settings({ experimentalFeatures: { "computer-use": true } }), "win32"), {
      enabled: true,
      platformSupported: true,
      allowNetwork: true,
      networkControlled: true,
    });
    assert.deepEqual(computerUseTurnContext(settings({}), "win32"), {
      enabled: false,
      platformSupported: true,
      allowNetwork: true,
      networkControlled: true,
    });
    // 整份设置都读不到（store 空 / 坏文件被兜成 undefined）也不能变成「禁出网」
    assert.deepEqual(computerUseTurnContext(undefined, "win32"), {
      enabled: false,
      platformSupported: true,
      allowNetwork: true,
      networkControlled: true,
    });
  });

  test("设置值一路进到命令：turnFields 拿到的就是这份现场，不二次解释", () => {
    const context = computerUseTurnContext(
      settings({
        experimentalFeatures: { "computer-use": true },
        computerUse: { allowNetwork: false, backend: "isolation-session" },
      }),
      "win32",
    );
    const fields = turnFields(input, provider, "/pi", "/sessions/s1.attachments", [], {
      ...environment,
      computerUse: context,
    });
    assert.deepEqual(fields.computerUse, {
      enabled: true,
      platformSupported: true,
      allowNetwork: false,
      networkControlled: false,
    });
  });
});

/**
 * 「设置选 wsb、实际跑着 L2b」——**必改 2 的守护测试**。
 *
 * 后端与出网开关都是下次启动才生效（backendPatch 明写不自动重启），所以拿设置算出来的
 * `enforced` 可能在说一只并不在跑的沙箱。这条测试把两边拆开：设置里是 wsb + 关，运行
 * 事实注入成 L2b + 关。期望：networkControlled 为 false（不宣称能断网），而且同一轮里
 * 提示词与工具描述说的是同一件事——描述里不出现「no outbound network」。
 *
 * 同时钉住「两个消费者不能互相打脸」：ctx 里缺 networkControlled 这一格时（老夹具 /
 * 旧命令），提示词按「做不到」说、工具描述也不能按 true 去说「没有出网」。
 */
describe("出网：运行中的后端与设置不一致时，模型听到的是运行中那只", () => {
  const settings = (value: { backend?: "wsb" | "isolation-session" | "qemu"; allowNetwork?: boolean }): AppSettings =>
    ({
      theme: "system",
      drawer: { width: 320, docked: [] },
      experimentalFeatures: { "computer-use": true },
      computerUse: value,
    }) as AppSettings;

  /** 拿一份 ctx 走完整条链：开轮装配 → 工具描述 + 提示词 */
  const chain = (computerUse: ReturnType<typeof computerUseTurnContext>) => {
    const plan = computerUseTurnPlan(computerUse);
    const tools = createSandboxBrowserTools(new RequestBroker(() => undefined), "s1", {
      allowNetwork: plan.allowNetwork,
      networkControlled: plan.networkControlled,
    });
    return { plan, tools, guideline: computerUseNetworkGuideline(computerUse) };
  };

  test("设置 wsb / 跑着 L2b：networkControlled 为 false，描述里不出现「no outbound network」", () => {
    const ctx = computerUseTurnContext(
      settings({ backend: "wsb", allowNetwork: false }),
      "win32",
      { backend: "isolation-session", allowNetwork: false },
    );
    assert.equal(ctx.networkControlled, false);
    assert.equal(ctx.allowNetwork, false, "开关取启动时那份（这里与设置同值）");

    const { plan, tools, guideline } = chain(ctx);
    assert.equal(plan.networkControlled, false);
    for (const tool of tools) {
      assert.doesNotMatch(tool.description, /no outbound network/, tool.name);
      assert.match(tool.description, /cannot block its network/, tool.name);
    }
    assert.match(guideline, /cannot block its network/);
    assert.doesNotMatch(guideline, /no outbound network/);
  });

  test("设置 wsb / 跑着 qemu：仍然按运行中的 qemu 算（能断），开关取启动时那份", () => {
    const ctx = computerUseTurnContext(
      settings({ backend: "wsb", allowNetwork: true }),
      "win32",
      { backend: "qemu", allowNetwork: false },
    );
    assert.equal(ctx.networkControlled, true);
    // 运行中把设置改成「允许」，这只 VM 仍按启动时的「关」
    assert.equal(ctx.allowNetwork, false);
    const { tools } = chain(ctx);
    for (const tool of tools) assert.match(tool.description, /no outbound network/, tool.name);
  });

  test("没在跑（running = null）：退回设置值——那是「下一局会怎么样」", () => {
    const ctx = computerUseTurnContext(settings({ backend: "isolation-session", allowNetwork: false }), "win32", null);
    assert.equal(ctx.networkControlled, false);
    assert.equal(ctx.allowNetwork, false);
  });

  test("ctx 缺 networkControlled 一格：两个消费者说同一句话（都不宣称没网）", () => {
    // 旧命令 / 老夹具的形状：这一格还没有。验收实测过：提示词按「缺格 = 做不到」说
    // 「断不了网」，而工具描述按 `?? true` 说「This sandbox has no outbound network」
    // ——同一轮两句相反。两边的缺席语义必须都落在「不宣称」。
    const legacy = { enabled: true, platformSupported: true, allowNetwork: false } as never;

    const guideline = computerUseNetworkGuideline(legacy);
    assert.match(guideline, /cannot block its network/);
    assert.doesNotMatch(guideline, /no outbound network/);

    const plan = computerUseTurnPlan(legacy);
    assert.deepEqual(plan, { tools: true, allowNetwork: false, networkControlled: false });
    const tools = createSandboxBrowserTools(new RequestBroker(() => undefined), "s1", {
      allowNetwork: plan.allowNetwork,
      networkControlled: plan.networkControlled,
    });
    for (const tool of tools) {
      assert.doesNotMatch(tool.description, /no outbound network/, tool.name);
      assert.match(tool.description, /cannot block its network/, tool.name);
    }
  });
});
