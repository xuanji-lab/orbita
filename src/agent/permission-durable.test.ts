/**
 * 新内核的库目录（`<userData>/durable/`：每棵会话树一个 SQLite 库、它的 -wal / -shm、删除的墓碑 `.purge.json`、
 * 迁到一半的半份）与会话账本同等受保护：智能体的 write / edit / bash 改不了、删不了、挪不走；read 工具读不受限。
 * 开发实例里还要护正式实例的 durable/。
 *
 * 夹具是真实文件系统（tmp 下的假数据目录 + 符号链接），与 permission-whitelist.test.ts 同一个做法；目录名单用产品代码的
 * toolProtectedDirs 拼（index.ts 交给两个内核的就是它），不另写一份。
 */
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protectedPathRefusal } from "./permission.ts";
import { formalUserDataDir, toolProtectedDirs } from "../main/data-dirs.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "orbita-durable-guard-")));
const HOME = join(root, "home");
const APP_DATA = join(HOME, "Library", "Application Support");
const DATA = join(APP_DATA, "orbita-dev-d5");
const FORMAL = formalUserDataDir(APP_DATA);
const DUR = join(DATA, "durable");
const FDUR = join(FORMAL, "durable");
const WB = join(DATA, "workbenches", "w1");
const PROJ = join(root, "project");
const LIB = "1f0e2d3c-0000-4000-8000-000000000001.sqlite";
for (const dir of [DUR, FDUR, WB, PROJ, join(DATA, "sessions"), join(DATA, "pi-sessions"), join(FORMAL, "sessions")]) mkdirSync(dir, { recursive: true });
for (const base of [DUR, FDUR]) for (const suffix of ["", "-wal", "-shm", ".purge.json"]) writeFileSync(join(base, `${LIB}${suffix}`), "x");
writeFileSync(join(PROJ, "notes.sqlite"), "x");
symlinkSync(DUR, join(PROJ, "lib-link"));
after(() => rmSync(root, { recursive: true, force: true }));

const PATHS = toolProtectedDirs(DATA, FORMAL);
const FILES = [join(DATA, "automations.json"), join(FORMAL, "automations.json")];
const GUARD = { home: HOME, env: { HOME, APPDATA: APP_DATA } };
const refused = (tool: string, input: Record<string, unknown>, cwd = PROJ): string | null => protectedPathRefusal(tool, input, PATHS, cwd, FILES, GUARD);
const D = DUR;
const F = FDUR;

/** 30 条针对 durable/ 的攻击：本实例与正式实例各一批，write / edit / bash 的自然写法与常见变形 */
const attacks: [string, string, Record<string, unknown>, string?][] = [
  ["write 覆盖库文件", "write", { path: join(D, LIB), content: "" }],
  ["write 写 -wal", "write", { path: join(D, `${LIB}-wal`), content: "" }],
  ["write 改墓碑", "write", { path: join(D, `${LIB}.purge.json`), content: "[]" }],
  ["write 在 durable/ 新建文件", "write", { path: join(D, "new.sqlite"), content: "" }],
  ["edit 改库文件", "edit", { path: join(D, LIB), edits: [{ oldText: "x", newText: "y" }] }],
  ["write 相对路径（cwd 在数据目录）", "write", { path: `durable/${LIB}`, content: "" }, DATA],
  ["write 经符号链接", "write", { path: join(PROJ, "lib-link", LIB), content: "" }],
  ["write 正式实例的库", "write", { path: join(F, LIB), content: "" }],
  ["bash rm 库文件", "bash", { command: `rm "${D}/${LIB}"` }],
  ["bash rm -rf durable", "bash", { command: `rm -rf "${D}"` }],
  ["bash 删 -wal 与 -shm", "bash", { command: `rm -f "${D}/${LIB}-wal" "${D}/${LIB}-shm"` }],
  ["bash 删墓碑", "bash", { command: `rm "${D}/${LIB}.purge.json"` }],
  ["bash cd 后删", "bash", { command: `cd "${D}" && rm -f *.sqlite` }],
  ["bash cd 数据目录后删", "bash", { command: `cd "${DATA}" && rm -rf durable` }],
  ["bash mv 挪走库", "bash", { command: `mv "${D}/${LIB}" /tmp/x.sqlite` }],
  ["bash mv durable 改名", "bash", { command: `mv "${D}" "${D}-old"` }],
  ["bash 截断库文件", "bash", { command: `: > "${D}/${LIB}"` }],
  ["bash sqlite3 改库", "bash", { command: `sqlite3 "${D}/${LIB}" "DELETE FROM entries"` }],
  ["bash cp 空文件覆盖", "bash", { command: `cp /dev/null "${D}/${LIB}"` }],
  ["bash find -delete", "bash", { command: `find "${D}" -name '*.sqlite*' -delete` }],
  ["bash find | xargs rm", "bash", { command: `find "${D}" -type f | xargs rm -f` }],
  ["bash chmod durable", "bash", { command: `chmod 000 "${D}"` }],
  ["bash $HOME 写法删", "bash", { command: `rm "$HOME/Library/Application Support/orbita-dev-d5/durable/${LIB}"` }],
  ["bash ~ 写法删", "bash", { command: `rm -f ~/Library/Application\\ Support/orbita-dev-d5/durable/${LIB}` }],
  ["bash 经符号链接删", "bash", { command: `rm "${PROJ}/lib-link/${LIB}"` }],
  ["bash python 写库", "bash", { command: `python3 -c "open('${D}/${LIB}','w').write('')"` }],
  ["bash 正式实例 rm", "bash", { command: `rm "${F}/${LIB}"` }],
  ["bash 正式实例 rm -rf", "bash", { command: `rm -rf "${F}"` }],
  ["bash 正式实例 cd 后删", "bash", { command: `cd "${FORMAL}" && rm -rf durable` }],
  ["bash 正式实例 sqlite3", "bash", { command: `sqlite3 "${F}/${LIB}" "VACUUM"` }],
];

/**
 * 用 shell 读 durable/ 也拦：与会话账本（sessions/、pi-sessions/）同一条规则——目录名出现在命令串里就拒（permission.ts 的
 * 完整路径字面量拦，`cat sessions/a.jsonl` 早就是拒的）。要读库只能用 read 工具（读不受限）。
 */
const shellReads: [string, string, Record<string, unknown>, string?][] = [
  ["ls 库目录", "bash", { command: `ls -la "${D}"` }],
  ["stat 库文件", "bash", { command: `stat "${D}/${LIB}"` }],
  ["cp 库文件到 /tmp（往外拷）", "bash", { command: `cp "${D}/${LIB}" /tmp/copy.sqlite` }],
  ["ls 正式实例库目录", "bash", { command: `ls "${F}"` }],
];

/** 不该误伤的正常命令：项目里的同名文件、工作台、别处、read 工具 */
const normal: [string, string, Record<string, unknown>, string?][] = [
  ["项目里的同名 sqlite", "bash", { command: `rm "${PROJ}/notes.sqlite"` }],
  ["项目里写 durable 同名子目录", "write", { path: join(PROJ, "durable", LIB), content: "" }],
  ["项目里 ls durable 同名子目录", "bash", { command: `mkdir -p "${PROJ}/durable" && ls "${PROJ}/durable"` }],
  ["工作台里写", "write", { path: join(WB, "out.txt"), content: "" }],
  ["工作台里 rm", "bash", { command: `rm -f "${WB}/old.txt"` }],
  ["/tmp 里 rm", "bash", { command: "rm -rf /tmp/orbita-scratch" }],
  ["读库文件（read 不受限）", "read", { path: join(D, LIB) }],
  ["读正式实例的库文件（read 不受限）", "read", { path: join(F, LIB) }],
];

describe("新内核的库目录（durable/）受保护", () => {
  for (const [name, tool, input, cwd] of attacks) {
    test(`拦：${name}`, () => {
      assert.notEqual(refused(tool, input, cwd), null);
    });
  }
  for (const [name, tool, input, cwd] of shellReads) {
    test(`也拦（与会话账本同一条规则）：${name}`, () => {
      assert.notEqual(refused(tool, input, cwd), null);
    });
  }
  for (const [name, tool, input, cwd] of normal) {
    test(`放行：${name}`, () => {
      assert.equal(refused(tool, input, cwd), null);
    });
  }
  test("攻击 30 条", () => assert.equal(attacks.length, 30));
});

/**
 * 拒绝理由按碰到的是什么说（2026-11-16 验收：命令碰 durable/ 回的是「Automation records are immutable」，与目标对不上）。
 * 这些话只在被拒时回给模型，不进系统提示。
 */
describe("拒绝理由按被碰到的是什么来说", () => {
  const SESS = join(DATA, "sessions");
  const AUTO = join(DATA, "automations.json");
  const cases: [string, string, Record<string, unknown>, RegExp][] = [
    ["write 库文件：会话库", "write", { path: join(D, LIB), content: "" }, /^The session database is immutable: its folder ".*durable" is protected — no tool may write/],
    ["bash rm 库文件：会话库", "bash", { command: `rm "${D}/${LIB}"` }, /^The session database is immutable/],
    ["bash ls 库目录：会话库", "bash", { command: `ls "${D}"` }, /^The session database is immutable/],
    ["正式实例的库：会话库", "bash", { command: `rm "${F}/${LIB}"` }, /^The session database is immutable/],
    ["bash rm 会话账本：会话记录", "bash", { command: `rm "${SESS}/a.jsonl"` }, /^Session records are immutable/],
    ["write 会话账本：会话记录", "write", { path: join(SESS, "a.jsonl"), content: "" }, /^Session records are immutable/],
    ["bash 改自动化记录：自动化记录", "bash", { command: `rm "${AUTO}"` }, /^Automation records are immutable/],
    ["cd 进数据目录再删：说整个数据目录", "bash", { command: `cd "${DATA}" && rm -rf x` }, /^Orbita's data folder ".*" holds session records, the session database and automation records/],
    // 一条命令碰了好几样时按优先级说：会话库 > 会话记录 > 自动化记录（2026-11-16 复验：把优先级对调，原有测试不红）
    ["同时碰会话记录与会话库：说会话库", "bash", { command: `rm "${SESS}/a.jsonl" "${D}/${LIB}"` }, /^The session database is immutable/],
    ["会话库在后面也一样：说会话库", "bash", { command: `cp "${D}/${LIB}" /tmp/x && rm "${SESS}/a.jsonl" "${D}/${LIB}"` }, /^The session database is immutable/],
  ];
  for (const [name, tool, input, pattern] of cases) {
    test(name, () => {
      const message = refused(tool, input);
      assert.ok(message !== null, "应当被拒");
      assert.match(message, pattern);
      // 讲会话库的话不该再提自动化记录，反之亦然
      if (/session database/.test(pattern.source)) assert.doesNotMatch(message, /Automation records/);
    });
  }
});
