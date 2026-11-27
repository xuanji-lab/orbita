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
  computerUse: { enabled: true, platformSupported: true, allowNetwork: true },
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

  test("computerUse 整份透传：开关、平台支持与沙箱出网三个事实都在命令里（模型的提示词与工具注册靠它们分叉）", () => {
    const fields = turnFields(input, provider, "/pi", "/sessions/s1.attachments", [], {
      ...environment,
      computerUse: { enabled: true, platformSupported: true, allowNetwork: false },
    });
    assert.deepEqual(fields.computerUse, { enabled: true, platformSupported: true, allowNetwork: false });
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
  const settings = (value: { experimentalFeatures?: Record<string, boolean>; computerUse?: { allowNetwork: boolean } }): AppSettings =>
    ({ theme: "system", drawer: { width: 320, docked: [] }, ...value }) as AppSettings;

  test("开着且允许出网：enabled 与 allowNetwork 各自取自己的键，Windows 上平台支持为真", () => {
    assert.deepEqual(
      computerUseTurnContext(
        settings({ experimentalFeatures: { "computer-use": true }, computerUse: { allowNetwork: true } }),
        "win32",
      ),
      { enabled: true, platformSupported: true, allowNetwork: true },
    );
  });

  test("非 win32：platformSupported 为 false（开关开着也一样——工具组不注册）", () => {
    const on = settings({ experimentalFeatures: { "computer-use": true } });
    assert.deepEqual(computerUseTurnContext(on, "darwin"), {
      enabled: true,
      platformSupported: false,
      allowNetwork: true,
    });
    assert.equal(computerUseTurnContext(on, "linux").platformSupported, false);
    assert.equal(computerUseTurnContext(on, "freebsd").platformSupported, false);
  });

  test("开着但禁出网：这正是要告诉模型的那一对值", () => {
    assert.deepEqual(
      computerUseTurnContext(
        settings({ experimentalFeatures: { "computer-use": true }, computerUse: { allowNetwork: false } }),
        "win32",
      ),
      { enabled: true, platformSupported: true, allowNetwork: false },
    );
  });

  test("功能开关关着：enabled 为 false，allowNetwork 仍如实反映设置（工具不注册，但字段不留谎）", () => {
    assert.deepEqual(computerUseTurnContext(settings({ computerUse: { allowNetwork: false } }), "win32"), {
      enabled: false,
      platformSupported: true,
      allowNetwork: false,
    });
    // 其它实验开关开着不算「电脑使用开着」
    assert.deepEqual(computerUseTurnContext(settings({ experimentalFeatures: { "pdf-citations": true } }), "win32"), {
      enabled: false,
      platformSupported: true,
      allowNetwork: true,
    });
  });

  test("computerUse 字段缺席（老 settings.json）：enabled 关、allowNetwork 按缺省允许（#329 的 effectiveAllowNetwork）", () => {
    assert.deepEqual(computerUseTurnContext(settings({ experimentalFeatures: { "computer-use": true } }), "win32"), {
      enabled: true,
      platformSupported: true,
      allowNetwork: true,
    });
    assert.deepEqual(computerUseTurnContext(settings({}), "win32"), {
      enabled: false,
      platformSupported: true,
      allowNetwork: true,
    });
    // 整份设置都读不到（store 空 / 坏文件被兜成 undefined）也不能变成「禁出网」
    assert.deepEqual(computerUseTurnContext(undefined, "win32"), {
      enabled: false,
      platformSupported: true,
      allowNetwork: true,
    });
  });

  test("设置值一路进到命令：turnFields 拿到的就是这份现场，不二次解释", () => {
    const context = computerUseTurnContext(
      settings({ experimentalFeatures: { "computer-use": true }, computerUse: { allowNetwork: false } }),
      "win32",
    );
    const fields = turnFields(input, provider, "/pi", "/sessions/s1.attachments", [], {
      ...environment,
      computerUse: context,
    });
    assert.deepEqual(fields.computerUse, { enabled: true, platformSupported: true, allowNetwork: false });
  });
});

