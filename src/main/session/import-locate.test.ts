/**
 * import-locate 的测试：baseDir 的三平台惯例 + findDataRoots 的名字放宽与 validate 挡误判。
 * 全部在临时目录搭 home（连同 Library/Application Support、.local/share 等基础目录结构），
 * 误判样本用的是本机真实踩过的目录名（.codexbar 是别的工具、.kimi-cu 是 Kimi 的别的产品）。
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseDir, DATA_ROOT_SPECS, findDataRoots, type LocateContext } from "./import-locate.ts";

let home = "";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "import-locate-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** 默认 darwin（与开发机一致）；home 用临时目录，env 各用例自己给 */
const ctx = (env: Record<string, string | undefined> = {}, platform: NodeJS.Platform = "darwin"): LocateContext => ({
  platform,
  home,
  env,
});

// ---------------------------------------------------------------------------
// baseDir：三平台惯例（纯函数，不碰盘）
// ---------------------------------------------------------------------------

describe("baseDir", () => {
  const ctxOf = (platform: NodeJS.Platform, env: Record<string, string | undefined>): LocateContext => ({
    platform,
    home: "/h",
    env,
  });

  test("home 基础目录就是 home 本身，不看平台不看 env", () => {
    assert.equal(baseDir("home", ctxOf("win32", { APPDATA: "C:\\roaming" })), "/h");
    assert.equal(baseDir("home", ctxOf("linux", {})), "/h");
  });

  test("appData：win32 认 APPDATA、缺了退 home/AppData/Roaming；darwin 固定 Library；linux 认 XDG_CONFIG_HOME、缺了退 ~/.config", () => {
    assert.equal(baseDir("appData", ctxOf("win32", { APPDATA: "C:\\Users\\u\\AppData\\Roaming" })), "C:\\Users\\u\\AppData\\Roaming");
    assert.equal(baseDir("appData", ctxOf("win32", {})), join("/h", "AppData", "Roaming"));
    assert.equal(baseDir("appData", ctxOf("darwin", {})), join("/h", "Library", "Application Support"));
    assert.equal(baseDir("appData", ctxOf("linux", { XDG_CONFIG_HOME: "/xdg" })), "/xdg");
    assert.equal(baseDir("appData", ctxOf("linux", {})), join("/h", ".config"));
  });

  test("xdgData：所有平台同一个——XDG_DATA_HOME，缺了退 ~/.local/share（macOS 也不进 Library）", () => {
    assert.equal(baseDir("xdgData", ctxOf("darwin", {})), join("/h", ".local", "share"));
    assert.equal(baseDir("xdgData", ctxOf("linux", { XDG_DATA_HOME: "/xdg-data" })), "/xdg-data");
    assert.equal(baseDir("xdgData", ctxOf("linux", {})), join("/h", ".local", "share"));
    assert.equal(baseDir("xdgData", ctxOf("win32", { XDG_DATA_HOME: "C:\\xdg-data" })), "C:\\xdg-data");
  });

  test("环境变量空串同缺席：退兜底，不塌成 join(\"\") 那样相对进程 cwd 的路径", () => {
    assert.equal(baseDir("appData", ctxOf("win32", { APPDATA: "" })), join("/h", "AppData", "Roaming"));
    assert.equal(baseDir("appData", ctxOf("linux", { XDG_CONFIG_HOME: "" })), join("/h", ".config"));
    assert.equal(baseDir("xdgData", ctxOf("linux", { XDG_DATA_HOME: "" })), join("/h", ".local", "share"));
  });
});

// ---------------------------------------------------------------------------
// findDataRoots：名字放宽 + validate 挡误判（zcode 是变体最多的一类）
// ---------------------------------------------------------------------------

/** 造一个 zcode 变体（有会话库的完整形态） */
async function makeZcodeRoot(name: string): Promise<void> {
  await mkdir(join(home, name, "cli", "db"), { recursive: true });
  await writeFile(join(home, name, "cli", "db", "db.sqlite"), "");
}

describe("findDataRoots（zcode：home 第一层找名字含 zcode 的目录）", () => {
  beforeEach(async () => {
    await makeZcodeRoot(".zcode"); // canonical
    await makeZcodeRoot(".zcode-wt");
    await makeZcodeRoot(".zcode1");
    await makeZcodeRoot(".test-zcode");
    // 误判与不看的：没有会话库的变体、名字不含 token 的目录、名为变体的文件
    await mkdir(join(home, ".zcode-empty"), { recursive: true });
    await mkdir(join(home, ".vscode", "cli", "db"), { recursive: true });
    await writeFile(join(home, ".vscode", "cli", "db", "db.sqlite"), "");
    await writeFile(join(home, ".zcode-notdir"), "");
  });

  test("canonical 排最前，其余按名字排；没会话数据的、名字不含 token 的、是文件的都不收", async () => {
    assert.deepEqual(await findDataRoots(DATA_ROOT_SPECS["zcode"], ctx()), [
      join(home, ".zcode"),
      join(home, ".test-zcode"),
      join(home, ".zcode-wt"),
      join(home, ".zcode1"),
    ]);
  });

  test("名字含 token 不分大小写（.ZCode-Backup 也是变体），排序也按小写比较", async () => {
    await makeZcodeRoot(".ZCode-Backup");
    assert.deepEqual(await findDataRoots(DATA_ROOT_SPECS["zcode"], ctx()), [
      join(home, ".zcode"),
      join(home, ".test-zcode"),
      join(home, ".ZCode-Backup"),
      join(home, ".zcode-wt"),
      join(home, ".zcode1"),
    ]);
  });

  test("大小写变体也可以当 canonical（小写后等于 canonical 的排最前）", async () => {
    // 盘上只有 .ZCODE（没有小写的 .zcode）时它就是 canonical
    await rm(join(home, ".zcode"), { recursive: true });
    await makeZcodeRoot(".ZCODE");
    assert.deepEqual(await findDataRoots(DATA_ROOT_SPECS["zcode"], ctx()), [
      join(home, ".ZCODE"),
      join(home, ".test-zcode"),
      join(home, ".zcode-wt"),
      join(home, ".zcode1"),
    ]);
  });
});

// ---------------------------------------------------------------------------
// findDataRoots：env 指定（codex 有 CODEX_HOME，且 base 之外的目录也收）
// ---------------------------------------------------------------------------

describe("findDataRoots（codex：CODEX_HOME 优先）", () => {
  let outside = "";

  beforeEach(async () => {
    await mkdir(join(home, ".codex", "sessions"), { recursive: true });
    await mkdir(join(home, ".codex-bak", "sessions"), { recursive: true });
    outside = await mkdtemp(join(tmpdir(), "import-locate-out-"));
    await mkdir(join(outside, "sessions"), { recursive: true }); // 名字不含 codex，也不在 home 下
  });

  afterEach(async () => {
    await rm(outside, { recursive: true, force: true });
  });

  test("env 指向 base 之外的目录也收且排最前（名字可以不含 token）", async () => {
    assert.deepEqual(await findDataRoots(DATA_ROOT_SPECS["codex"], ctx({ CODEX_HOME: outside })), [
      outside,
      join(home, ".codex"),
      join(home, ".codex-bak"),
    ]);
  });

  test("env 空串当缺席：行为与没有 CODEX_HOME 一样", async () => {
    assert.deepEqual(await findDataRoots(DATA_ROOT_SPECS["codex"], ctx({ CODEX_HOME: "" })), [
      join(home, ".codex"),
      join(home, ".codex-bak"),
    ]);
  });

  test("env 指向的目录不过 validate 就不收（只剩扫描到的）", async () => {
    const noSessions = join(home, ".codex-empty");
    await mkdir(noSessions, { recursive: true });
    assert.deepEqual(await findDataRoots(DATA_ROOT_SPECS["codex"], ctx({ CODEX_HOME: noSessions })), [
      join(home, ".codex"),
      join(home, ".codex-bak"),
    ]);
  });

  test("env 与 canonical 是同一个目录只出现一次（尾斜杠等写法按 resolve 去重）", async () => {
    assert.deepEqual(await findDataRoots(DATA_ROOT_SPECS["codex"], ctx({ CODEX_HOME: join(home, ".codex") + "/" })), [
      join(home, ".codex"),
      join(home, ".codex-bak"),
    ]);
  });
});

// ---------------------------------------------------------------------------
// findDataRoots：各来源的 validate 依据与误判样本
// ---------------------------------------------------------------------------

describe("findDataRoots（proma：只认 canonical，名字变体不进自动扫描）", () => {
  // 变体匹配収窄只针对 proma；其它来源的变体照常命中、env 指定仍然优先，由下面 zcode / codex
  // 两组用例背书——它们与本组同文件同跑，收窄误伤会在那里红
  test("canonical 命中：agent-sessions.json 在就算；-dev / -worktree 变体有同款数据也不收", async () => {
    await mkdir(join(home, ".proma"), { recursive: true });
    await writeFile(join(home, ".proma", "agent-sessions.json"), "{}");
    await mkdir(join(home, ".proma-dev"), { recursive: true });
    await writeFile(join(home, ".proma-dev", "agent-sessions.json"), "{}");
    await mkdir(join(home, ".proma-worktree"), { recursive: true });
    await writeFile(join(home, ".proma-worktree", "agent-sessions.json"), "{}");
    assert.deepEqual(await findDataRoots(DATA_ROOT_SPECS["proma"], ctx()), [join(home, ".proma")]);
  });

  test("canonical 只剩 sdk-config/sessions（pi 真源）也算——索引里的源文件会指过去", async () => {
    await mkdir(join(home, ".proma", "sdk-config", "sessions"), { recursive: true });
    assert.deepEqual(await findDataRoots(DATA_ROOT_SPECS["proma"], ctx()), [join(home, ".proma")]);
  });

  test("canonical 大小写不同也算（与变体匹配同款的小写比较）", async () => {
    await mkdir(join(home, ".PROMA"), { recursive: true });
    await writeFile(join(home, ".PROMA", "agent-sessions.json"), "{}");
    assert.deepEqual(await findDataRoots(DATA_ROOT_SPECS["proma"], ctx()), [join(home, ".PROMA")]);
  });

  test("盘上只有变体、没有 canonical 时 proma 判为没找到（变体不顶替 canonical）", async () => {
    await mkdir(join(home, ".proma-dev"), { recursive: true });
    await writeFile(join(home, ".proma-dev", "agent-sessions.json"), "{}");
    assert.deepEqual(await findDataRoots(DATA_ROOT_SPECS["proma"], ctx()), []);
  });
});

describe("findDataRoots（claude-code：CLAUDE_CONFIG_DIR + projects/ 目录）", () => {
  test("有 projects/ 的算，env 压过默认位置", async () => {
    await mkdir(join(home, ".claude", "projects"), { recursive: true });
    const elsewhere = join(home, "claude-elsewhere");
    await mkdir(join(elsewhere, "projects"), { recursive: true });
    assert.deepEqual(await findDataRoots(DATA_ROOT_SPECS["claude-code"], ctx({ CLAUDE_CONFIG_DIR: elsewhere })), [
      elsewhere,
      join(home, ".claude"),
    ]);
  });
});

describe("findDataRoots（kimi-code：本机真实误判样本 .kimi-cu 没有 sessions/）", () => {
  test("名字撞上但没有 sessions/ 的目录不收，本体照收", async () => {
    await mkdir(join(home, ".kimi-code", "sessions"), { recursive: true });
    await mkdir(join(home, ".kimi-cu"), { recursive: true });
    await writeFile(join(home, ".kimi-cu", "config.json"), "{}");
    assert.deepEqual(await findDataRoots(DATA_ROOT_SPECS["kimi-code"], ctx()), [join(home, ".kimi-code")]);
  });
});

describe("findDataRoots（codex 误判样本 .codexbar 是别的工具）", () => {
  test("只有 config.json、没有 sessions/ 的目录不收", async () => {
    await mkdir(join(home, ".codexbar"), { recursive: true });
    await writeFile(join(home, ".codexbar", "config.json"), "{}");
    assert.deepEqual(await findDataRoots(DATA_ROOT_SPECS["codex"], ctx()), []);
  });
});

describe("findDataRoots（opencode：xdgData 基础目录，macOS 上也在 ~/.local/share）", () => {
  test("按 XDG data 惯例找 opencode.db", async () => {
    await mkdir(join(home, ".local", "share", "opencode"), { recursive: true });
    await writeFile(join(home, ".local", "share", "opencode", "opencode.db"), "");
    assert.deepEqual(await findDataRoots(DATA_ROOT_SPECS["opencode"], ctx()), [
      join(home, ".local", "share", "opencode"),
    ]);
  });

  test("XDG_DATA_HOME 指哪去哪", async () => {
    const xdg = await mkdtemp(join(tmpdir(), "import-locate-xdg-"));
    try {
      await mkdir(join(xdg, "opencode-dev"), { recursive: true });
      await writeFile(join(xdg, "opencode-dev", "opencode.db"), "");
      assert.deepEqual(await findDataRoots(DATA_ROOT_SPECS["opencode"], ctx({ XDG_DATA_HOME: xdg })), [
        join(xdg, "opencode-dev"),
      ]);
    } finally {
      await rm(xdg, { recursive: true, force: true });
    }
  });
});

describe("findDataRoots（reasonix：appData 基础目录按平台各归各位）", () => {
  test("darwin 在 ~/Library/Application Support 下找，canonical 排最前", async () => {
    const appData = join(home, "Library", "Application Support");
    await mkdir(join(appData, "reasonix", "projects"), { recursive: true });
    await mkdir(join(appData, "reasonix-dev", "projects"), { recursive: true });
    assert.deepEqual(await findDataRoots(DATA_ROOT_SPECS["reasonix"], ctx()), [
      join(appData, "reasonix"),
      join(appData, "reasonix-dev"),
    ]);
  });

  test("win32 认 %APPDATA%", async () => {
    const roaming = join(home, "AppData", "Roaming");
    await mkdir(join(roaming, "reasonix", "projects"), { recursive: true });
    assert.deepEqual(
      await findDataRoots(DATA_ROOT_SPECS["reasonix"], ctx({ APPDATA: roaming }, "win32")),
      [join(roaming, "reasonix")],
    );
  });

  test("基础目录不存在返回 []", async () => {
    // 临时 home 下没造 Library/Application Support，也读不了它
    assert.deepEqual(await findDataRoots(DATA_ROOT_SPECS["reasonix"], ctx()), []);
  });

  test("基础目录读不了时 env 指定的仍收（只有 env 那个）", async () => {
    const elsewhere = join(home, "codex-elsewhere");
    await mkdir(join(elsewhere, "sessions"), { recursive: true });
    // home 指向不存在的目录：base 读不了，只剩 env 指定且 validate 过的那一个
    const noHome: LocateContext = { platform: "darwin", home: join(home, "no-such-home"), env: { CODEX_HOME: elsewhere } };
    assert.deepEqual(await findDataRoots(DATA_ROOT_SPECS["codex"], noHome), [elsewhere]);
  });
});
