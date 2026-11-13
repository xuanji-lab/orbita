/**
 * 技能 / MCP 导入的「先勾来源、点扫描之前什么都不读」：数读取次数。
 *
 * 用 node:test 的模块 mock 把 node:fs/promises 换成数次数的包装（readFile / readdir / open 记下
 * 路径，stat 照常放行——探测只许 stat）。mock 必须先于被测模块加载，所以被测模块在 mock 之后
 * 动态 import（仓库里 quote-track.test.ts 同款先例）。
 */
import { after, before, describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import * as realFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const reads: string[] = [];
const counted =
  <A extends unknown[], R>(fn: (...args: A) => R) =>
  (...args: A): R => {
    reads.push(String(args[0]));
    return fn(...args);
  };

mock.module("node:fs/promises", {
  namedExports: {
    ...realFs,
    readFile: counted(realFs.readFile),
    readdir: counted(realFs.readdir),
    open: counted(realFs.open),
  },
});

const { probeConfig, scanConfig } = await import("./config-import.ts");

let root = "";

before(async () => {
  root = await realFs.mkdtemp(join(tmpdir(), "orbita-config-reads-"));
  await realFs.mkdir(join(root, ".claude", "skills", "tdd"), { recursive: true });
  await realFs.writeFile(join(root, ".claude", "skills", "tdd", "SKILL.md"), "---\nname: tdd\n---\n");
  await realFs.writeFile(join(root, ".claude.json"), JSON.stringify({ mcpServers: { miyo: { command: "miyo", args: [] } } }));
  await realFs.mkdir(join(root, ".agents", "skills"), { recursive: true });
});
after(async () => {
  await realFs.rm(root, { recursive: true, force: true });
});

const deps = () => ({
  promaRoots: [],
  claudeCode: [{ skillsDir: join(root, ".claude", "skills"), claudeJson: join(root, ".claude.json") }],
  kimiCode: [],
  opencode: [],
  agentSkillsDir: join(root, ".agents", "skills"),
  existingSkills: [],
  existingMcp: [],
});

describe("没勾来源、没点扫描时，对技能 / MCP 的配置文件零读取", () => {
  test("打开页面的探测只 stat：列出会读的路径，一个文件都不读、一个目录都不列", async () => {
    reads.length = 0;
    const probes = await probeConfig(deps(), {
      proma: join(root, ".proma"),
      claudeCode: deps().claudeCode[0]!,
      kimiCode: join(root, ".kimi-code", "mcp.json"),
      opencode: join(root, ".config", "opencode", "opencode.json"),
    });
    assert.equal(reads.length, 0, reads.join(", "));
    const claude = probes.find((probe) => probe.id === "claude-code");
    assert.deepEqual(claude?.paths, [join(root, ".claude", "skills"), join(root, ".claude.json")]);
    assert.equal(claude?.found, true);
    assert.equal(probes.find((probe) => probe.id === "kimi-code")?.found, false);
  });

  test("一个来源都没勾就扫描：零读取；勾了 Claude Code 才读它的技能目录与 ~/.claude.json", async () => {
    reads.length = 0;
    const empty = await scanConfig(deps(), []);
    assert.equal(reads.length, 0, reads.join(", "));
    assert.deepEqual(empty.report, { skills: [], mcp: [] });

    reads.length = 0;
    const scanned = await scanConfig(deps(), ["claude-code"]);
    assert.ok(reads.includes(join(root, ".claude.json")));
    assert.ok(reads.some((path) => path.startsWith(join(root, ".claude", "skills"))));
    // 没勾的共用技能目录不读
    assert.ok(!reads.some((path) => path.startsWith(join(root, ".agents"))));
    assert.deepEqual(scanned.report.mcp.map((item) => item.name), ["miyo"]);
  });
});
