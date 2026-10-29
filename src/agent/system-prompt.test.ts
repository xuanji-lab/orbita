/**
 * 系统提示词段装配的账——本 PR 的核心断言：**派出 / 删除子会话前后，父会话的
 * 整份系统提示词逐字节不变**（对方工作台改由 delegate 回执与通道信封告知）。
 * 反向也钉住：attached 仍留在提示词里（挂目录会变，是既有行为），证明上面的
 * 逐字节断言不是「怎么变都相等」的空测试。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { joinSystemPrompt, orbitaSystemSegments, type SystemPromptInput } from "./system-prompt.ts";
import type { TurnDirectories } from "../shared/agent-ipc.ts";

const dirs = (patch: Partial<TurnDirectories> = {}): TurnDirectories => ({
  attached: [],
  workbench: "/Users/u/Library/Application Support/orbita/workbenches/s1",
  ...patch,
});

const input = (patch: Partial<SystemPromptInput> = {}): SystemPromptInput => ({
  piBase: "pi base prompt (adapted)",
  mode: "skip",
  extraToolNames: ["create_skill", "delegate"],
  role: "root",
  workspace: { name: "orbita" },
  cwd: "/repo/orbita",
  directories: dirs(),
  gitAttribution: true,
  attributionLanguage: "en",
  intentGuideline: false,
  ...patch,
});

describe("orbitaSystemSegments —— 派出 / 删除子会话不改系统提示词", () => {
  test("父会话：related 从无到有两个子、再删回空，整份提示词逐字节相同", () => {
    const before = joinSystemPrompt(orbitaSystemSegments(input()));
    const withChildren = joinSystemPrompt(
      orbitaSystemSegments(
        input({
          directories: dirs({
            related: [
              { sessionId: "c1", relation: "child", label: "调研", path: "/wb/c1" },
              { sessionId: "c2", relation: "child", label: "实现", path: "/wb/c2" },
            ],
          }),
        }),
      ),
    );
    const after = joinSystemPrompt(orbitaSystemSegments(input()));
    assert.equal(withChildren, before);
    assert.equal(after, before);
    // 对方工作台路径确实不在任何一段里
    assert.ok(!withChildren.includes("/wb/c1"));
    assert.ok(!withChildren.includes("Sub-session"));
  });

  test("子会话：related 有没有父那一项，提示词同样逐字节相同", () => {
    const base = input({ role: "child" });
    const withoutParent = joinSystemPrompt(orbitaSystemSegments(base));
    const withParent = joinSystemPrompt(
      orbitaSystemSegments(
        input({
          role: "child",
          directories: dirs({
            related: [{ sessionId: "p1", relation: "parent", label: "母任务", path: "/wb/p1" }],
          }),
        }),
      ),
    );
    assert.equal(withParent, withoutParent);
    assert.ok(!withParent.includes("Parent session"));
  });

  test("反向对照：挂上附加目录提示词就变——逐字节断言有区分度，attached 留在这里是既有行为", () => {
    const before = joinSystemPrompt(orbitaSystemSegments(input()));
    const after = joinSystemPrompt(
      orbitaSystemSegments(input({ directories: dirs({ attached: ["/vault/notes"] }) })),
    );
    assert.notEqual(after, before);
    assert.ok(after.includes("- /vault/notes"));
  });
});

describe("orbitaSystemSegments —— 段序与空段", () => {
  test("段序锁死：pi-base 在最前、reply-language 在最末", () => {
    const names = orbitaSystemSegments(input()).map((segment) => segment.name);
    assert.equal(names[0], "pi-base");
    assert.equal(names.at(-1), "reply-language");
    // 线上实际顺序（与 runtime 抽出前的内联拼接一致），防无意识重排打断缓存
    assert.deepEqual(names, [
      "pi-base",
      "permission",
      "directories",
      "channel-role",
      "store-tools",
      "tool-guidelines",
      "expected-seconds",
      "quote",
      "git-attribution",
      "reply-language",
    ]);
  });

  test("intentGuideline 开时多一段 intent，关时没有", () => {
    const off = orbitaSystemSegments(input()).map((segment) => segment.name);
    const on = orbitaSystemSegments(input({ intentGuideline: true })).map((segment) => segment.name);
    assert.ok(!off.includes("intent"));
    assert.deepEqual(on, [
      "pi-base",
      "permission",
      "directories",
      "channel-role",
      "store-tools",
      "tool-guidelines",
      "expected-seconds",
      "intent",
      "quote",
      "git-attribution",
      "reply-language",
    ]);
  });

  test("空段滤掉（Git 标识关 = 空串），join 后无多余空行", () => {
    const segments = orbitaSystemSegments(input({ gitAttribution: false }));
    assert.ok(segments.some((segment) => segment.name === "git-attribution" && segment.text === ""));
    const joined = joinSystemPrompt(segments);
    assert.ok(!joined.endsWith("\n\n"));
    assert.ok(!joined.includes("\n\n\n"));
  });

  test("directories 缺席（旧夹具）= 空段，其余照拼", () => {
    const segments = orbitaSystemSegments(input({ directories: undefined }));
    assert.ok(segments.some((segment) => segment.name === "directories" && segment.text === ""));
    assert.ok(joinSystemPrompt(segments).includes("pi base prompt (adapted)"));
  });
});
