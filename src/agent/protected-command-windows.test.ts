/**
 * Windows 上「同一个文件的各种写法」对命令闸门的判定（平台注入为 win32，在 macOS / Linux 上也能跑）。
 *
 * 起因（2026-11-17 Windows 真机验收，Git Bash / MSYS bash 5.2.37）：bash 工具里 `rm -f "/c/…/sessions/canary.jsonl"`
 * 没被拦，会话记录被删；同一个文件用 `C:\…`、大小写变体、cmd del、PowerShell Remove-Item 等 13 种写法都拦住了。
 * 根因是命令闸门只把反斜杠转正斜杠、小写，`/c/…` 与受保护目录的 `c:/…` 对不上。
 *
 * 夹具是纯字符串（realpath 注入为恒等，或模拟 Windows 的 8.3 长名展开），不碰文件系统。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { protectedPathRefusal } from "./permission.ts";
import { windowsPathForm, type CommandGuardEnv } from "./protected-command.ts";

const HOME = "C:\\Users\\alice";
const APPDATA = `${HOME}\\AppData\\Roaming`;
// 受保护路径用正斜杠的盘符写法：测试跑在 macOS 时 permission.ts 用 posix 的 dirname 求数据目录，认不出反斜杠
// （真 Windows 上主进程给的是 `C:\\…`，win32 的 dirname 认得；闸门内部两种都折成 `c:/…` 比）
const D = "C:/Users/alice/AppData/Roaming/orbita";
const PATHS = [`${D}/sessions`, `${D}/pi-sessions`, `${D}/durable`];
const FILES = [`${D}/automations.json`];
const CWD = `${HOME}\\project`;
const ENV = {
  APPDATA,
  LOCALAPPDATA: `${HOME}\\AppData\\Local`,
  USERPROFILE: HOME,
  USERNAME: "alice",
  SystemDrive: "C:",
};
const WIN: CommandGuardEnv = { home: HOME, env: ENV, platform: "win32", realpath: (path) => path };

/** Git Bash 写法的会话记录 */
const G = "/c/Users/alice/AppData/Roaming/orbita";

function judge(command: string, guard: CommandGuardEnv = WIN, cwd = CWD): string | null {
  return protectedPathRefusal("bash", { command }, PATHS, cwd, FILES, guard);
}

interface Row {
  name: string;
  command: string;
  cwd?: string;
}

/** 应拦：每种写法都指向受保护的会话记录 / 会话库 / 自动化记录 / 数据目录本身或其上级 */
const BLOCK: Row[] = [
  // 真机上漏的那一条与它的近亲
  { name: "Git Bash 盘符（真机漏拦原样）", command: `rm -f "${G}/sessions/canary.jsonl"` },
  { name: "Git Bash 盘符不带引号", command: `rm -f ${G}/sessions/canary.jsonl` },
  { name: "Git Bash 大写盘符与混大小写", command: `rm -f /C/USERS/Alice/appdata/ROAMING/Orbita/Sessions/canary.jsonl` },
  { name: "WSL /mnt/c", command: `rm -f /mnt/c/Users/alice/AppData/Roaming/orbita/sessions/canary.jsonl` },
  { name: "Cygwin /cygdrive/c", command: `rm -f /cygdrive/c/Users/alice/AppData/Roaming/orbita/sessions/canary.jsonl` },
  { name: "/proc/cygdrive/c", command: `rm -f /proc/cygdrive/c/Users/alice/AppData/Roaming/orbita/sessions/canary.jsonl` },
  { name: "//c/ 双斜杠", command: `rm -f //c/Users/alice/AppData/Roaming/orbita/sessions/canary.jsonl` },
  { name: "Git Bash 写法删会话库", command: `rm -rf ${G}/durable` },
  { name: "Git Bash 写法删自动化记录", command: `rm ${G}/automations.json` },
  { name: "Git Bash 写法删整个数据目录", command: `rm -rf ${G}` },
  { name: "Git Bash 写法删数据目录的上级", command: `rm -rf /c/Users/alice/AppData` },
  { name: "Git Bash 写法删 C 盘根", command: `rm -rf /c/` },
  { name: "原生写法删 C 盘根", command: `rm -rf C:/` },
  // 设备前缀与 UNC
  { name: "\\\\?\\C:\\ 设备前缀", command: `rm -f "\\\\?\\C:\\Users\\alice\\AppData\\Roaming\\orbita\\sessions\\canary.jsonl"` },
  { name: "//?/C:/ 设备前缀（正斜杠）", command: `rm -f //?/C:/Users/alice/AppData/Roaming/orbita/sessions/canary.jsonl` },
  { name: "\\\\.\\C:\\ 设备前缀", command: `rm -f "\\\\.\\C:\\Users\\alice\\AppData\\Roaming\\orbita\\sessions\\canary.jsonl"` },
  { name: "\\\\localhost\\c$ 管理共享", command: `rm -f "\\\\localhost\\c$\\Users\\alice\\AppData\\Roaming\\orbita\\sessions\\canary.jsonl"` },
  { name: "\\\\127.0.0.1\\c$ 管理共享", command: `rm -f "\\\\127.0.0.1\\c$\\Users\\alice\\AppData\\Roaming\\orbita\\sessions\\canary.jsonl"` },
  { name: "//localhost/c$ 管理共享（正斜杠）", command: `rm -f //localhost/c$/Users/alice/AppData/Roaming/orbita/sessions/canary.jsonl` },
  { name: "本机名管理共享", command: `rm -f "\\\\DESKTOP-01\\C$\\Users\\alice\\AppData\\Roaming\\orbita\\sessions\\canary.jsonl"` },
  { name: "\\\\?\\UNC\\localhost\\c$", command: `rm -f "\\\\?\\UNC\\localhost\\c$\\Users\\alice\\AppData\\Roaming\\orbita\\sessions\\canary.jsonl"` },
  // 环境变量与 ~
  { name: "Git Bash $APPDATA", command: `rm -f "$APPDATA/orbita/sessions/canary.jsonl"` },
  { name: "Git Bash ${APPDATA}", command: `rm -f "\${APPDATA}/orbita/sessions/canary.jsonl"` },
  { name: "Git Bash $LOCALAPPDATA/../Roaming", command: `rm -f "$LOCALAPPDATA/../Roaming/orbita/sessions/canary.jsonl"` },
  { name: "Git Bash $USERPROFILE", command: `rm -f "$USERPROFILE/AppData/Roaming/orbita/sessions/canary.jsonl"` },
  { name: "Git Bash $HOME", command: `rm -f "$HOME/AppData/Roaming/orbita/sessions/canary.jsonl"` },
  { name: "Git Bash ~", command: `rm -f ~/AppData/Roaming/orbita/sessions/canary.jsonl` },
  { name: "Git Bash ~用户名", command: `rm -f ~alice/AppData/Roaming/orbita/sessions/canary.jsonl` },
  { name: "cmd %APPDATA%", command: `cmd /c del "%APPDATA%\\orbita\\sessions\\canary.jsonl"` },
  { name: "PowerShell $env:APPDATA", command: `powershell -c "Remove-Item $env:APPDATA\\orbita\\sessions\\canary.jsonl"` },
  { name: "Git Bash 里把 Git Bash 家目录赋给 HOME 再用 ~", command: `HOME=/c/Users/alice; rm -f ~/AppData/Roaming/orbita/sessions/canary.jsonl` },
  // cd / pushd 之后的相对路径
  { name: "cd 进会话目录再删", command: `cd ${G}/sessions && rm -f canary.jsonl` },
  { name: "cd 到上级再相对删", command: `cd /c/Users/alice/AppData/Roaming && rm -f orbita/sessions/canary.jsonl` },
  { name: "pushd 到上级再相对删", command: `pushd /c/Users/alice/AppData/Roaming; rm -f orbita/sessions/canary.jsonl` },
  { name: "cd 到 /cygdrive 上级再相对删", command: `cd /cygdrive/c/Users/alice && rm -f AppData/Roaming/orbita/sessions/canary.jsonl` },
  { name: "从 Windows 原生 cwd 出发的 ../ 相对路径", command: `rm -f ../AppData/Roaming/orbita/sessions/canary.jsonl` },
  { name: "cwd 就在上级（原生反斜杠 cwd）的相对路径", command: `rm -f orbita/sessions/canary.jsonl`, cwd: APPDATA },
  { name: "无参 cd（回家目录）后相对删", command: `cd; rm -f AppData/Roaming/orbita/sessions/canary.jsonl` },
  // 套在 cmd / PowerShell / bash -c / wsl 里
  { name: "cmd /c \"del /c/…\"", command: `cmd /c "del ${G}/sessions/canary.jsonl"` },
  { name: "cmd /c del 原生路径", command: `cmd /c del C:\\Users\\alice\\AppData\\Roaming\\orbita\\sessions\\canary.jsonl` },
  { name: "powershell -c \"Remove-Item /c/…\"", command: `powershell -c "Remove-Item ${G}/sessions/canary.jsonl"` },
  { name: "powershell -Command Remove-Item \\\\?\\ 前缀", command: `powershell -Command "Remove-Item -LiteralPath '\\\\?\\C:\\Users\\alice\\AppData\\Roaming\\orbita\\sessions\\canary.jsonl'"` },
  { name: "bash -c 里的 /c/", command: `bash -c "rm -f ${G}/sessions/canary.jsonl"` },
  { name: "wsl rm /mnt/c", command: `wsl rm -f /mnt/c/Users/alice/AppData/Roaming/orbita/sessions/canary.jsonl` },
  { name: "命令替换里的 cygpath", command: `rm -f "$(cygpath -w ${G}/sessions/canary.jsonl)"` },
  // 盘符大小写与正反斜杠混写
  { name: "正反斜杠混写", command: `rm -f "C:\\Users/alice\\AppData/Roaming\\orbita/sessions\\canary.jsonl"` },
  { name: "小写盘符正斜杠", command: `rm -f c:/users/ALICE/appdata/roaming/orbita/sessions/canary.jsonl` },
  { name: "双反斜杠（JSON 转义残留）", command: `rm -f "C:\\\\Users\\\\alice\\\\AppData\\\\Roaming\\\\orbita\\\\sessions\\\\canary.jsonl"` },
  // 别的改写动作
  { name: "mv 走 /c/", command: `mv ${G}/sessions/canary.jsonl /tmp/` },
  { name: "cp 覆盖 /c/", command: `cp /tmp/x.jsonl ${G}/sessions/canary.jsonl` },
  { name: "重定向写 /c/", command: `echo x > ${G}/sessions/canary.jsonl` },
  { name: "dd of=/c/", command: `dd if=/dev/zero of=${G}/sessions/canary.jsonl bs=1 count=1` },
  { name: "sed -i /c/", command: `sed -i s/a/b/ ${G}/sessions/canary.jsonl` },
  { name: "find -delete /c/", command: `find ${G}/sessions -name "*.jsonl" -delete` },
  { name: "通配 /c/", command: `rm -f ${G}/sessions/*.jsonl` },
  { name: "短选项连写 /c/", command: `sort -o${G}/sessions/canary.jsonl /tmp/x` },
  { name: "python 单行 /c/", command: `python -c "import os; os.remove('${G}/automations.json')"` },
  { name: "node 单行 /c/ 数据目录", command: `node -e "require('fs').rmSync('${G}/sessions', {recursive: true})"` },
];

/** 应放行：受保护目录之外的正常读写（误伤检查） */
const ALLOW: Row[] = [
  { name: "项目里读", command: `cat /c/Users/alice/project/src/a.ts` },
  { name: "项目里删", command: `rm -f /c/Users/alice/project/tmp.txt` },
  { name: "项目里重定向写", command: `echo x > /c/Users/alice/project/out.txt` },
  { name: "项目里 cd 后相对删", command: `cd /c/Users/alice/project && rm -rf dist` },
  { name: "cwd 下的相对 ../ 不越界", command: `rm -f ../project2/tmp.txt` },
  { name: "工作台里删（Git Bash 写法）", command: `rm -rf ${G}/workbenches/w1/tmp` },
  { name: "工作台里写（原生写法）", command: `echo x > C:\\Users\\alice\\AppData\\Roaming\\orbita\\workbenches\\w1\\note.txt` },
  { name: "cd 进工作台后删", command: `cd ${G}/workbenches/w1 && rm -f note.txt` },
  { name: "别的应用的 AppData", command: `rm -rf /c/Users/alice/AppData/Roaming/Code/Cache` },
  { name: "/tmp", command: `rm -rf /tmp/x` },
  { name: "cmd /c dir（裸 /c 是开关，不当 C 盘根）", command: `cmd /c dir` },
  { name: "cmd /c echo", command: `cmd /c echo hi` },
  { name: "dir /s /b", command: `dir /s /b` },
  { name: "taskkill 开关", command: `taskkill /f /t /pid 1234` },
  { name: "xcopy 开关", command: `xcopy /e /i src dst` },
  { name: "D 盘的同名路径", command: `rm -f /d/Users/alice/AppData/Roaming/orbita/sessions/canary.jsonl` },
  { name: "别的主机的 d$ 共享", command: `rm -f //nas/d$/backup/x` },
  { name: "只读看会话目录（白名单只读命令）", command: `ls ${G}/workbenches` },
];

describe("命令闸门：Windows 上同一个文件的各种写法（platform 注入为 win32）", () => {
  for (const row of BLOCK) {
    test(`拦：${row.name}`, () => {
      assert.notEqual(judge(row.command, WIN, row.cwd ?? CWD), null, row.command);
    });
  }
  for (const row of ALLOW) {
    test(`放：${row.name}`, () => {
      assert.equal(judge(row.command, WIN, row.cwd ?? CWD), null, row.command);
    });
  }

  test("8.3 短文件名：纯字符串认不出，靠 realpath（Windows 上是 realpathSync.native，会展开成长名）", () => {
    const short = "C:/Users/alice/AppData/Roaming/ORBITA~1/sessions/canary.jsonl";
    const command = `rm -f ${short}`;
    // 不展开短名的 realpath：放行——这正是纯字符串的上限
    assert.equal(judge(command), null);
    // 模拟 Windows 的 native realpath：短名展开成长名后拦
    const expand: CommandGuardEnv = { ...WIN, realpath: (path) => path.replace(/ORBITA~1/i, "orbita") };
    assert.notEqual(judge(command, expand), null);
    assert.notEqual(judge(`rm -f /c/Users/alice/AppData/Roaming/ORBITA~1/sessions/canary.jsonl`, expand), null);
  });
});

describe("posix 上 /c/… 是真实目录，不折成 C 盘", () => {
  const POSIX_HOME = "/Users/alice";
  const PD = `${POSIX_HOME}/Library/Application Support/orbita`;
  const posixGuard: CommandGuardEnv = { home: POSIX_HOME, env: { HOME: POSIX_HOME }, platform: "darwin", realpath: (path) => path };
  const posix = (command: string): string | null =>
    protectedPathRefusal("bash", { command }, [`${PD}/sessions`], "/Users/alice/project", [`${PD}/automations.json`], posixGuard);

  test("同一条 Git Bash 写法在 darwin 上放行（/c 是根目录下的普通目录）", () => {
    assert.equal(posix(`rm -f "${G}/sessions/canary.jsonl"`), null);
    assert.equal(posix(`rm -rf /c/`), null);
    assert.equal(posix(`rm -f //localhost/c$/Users/alice/x`), null);
  });
  test("darwin 上受保护目录照旧拦", () => {
    assert.notEqual(posix(`rm -f "${PD}/sessions/x.jsonl"`), null);
  });
  test("win32 闸门的 Windows 写法（C:\\…）在 darwin 上也照旧不折", () => {
    // Windows 受保护目录 + darwin 平台：/c/… 不折成 c:/…，与修之前一致
    assert.equal(judge(`rm -f "${G}/sessions/canary.jsonl"`, { ...WIN, platform: "darwin" }), null);
  });
});

describe("windowsPathForm：折成盘符写法的规则", () => {
  const cases: [string, string][] = [
    ["/c/Users/x", "C:/Users/x"],
    ["/C/Users/x", "C:/Users/x"],
    ["/mnt/c/x", "C:/x"],
    ["/cygdrive/d/x", "D:/x"],
    ["/proc/cygdrive/c/x", "C:/x"],
    ["//c/x", "C:/x"],
    ["/c/", "C:/"],
    ["//?/C:/x", "C:/x"],
    ["//./C:/x", "C:/x"],
    ["//localhost/c$/x", "c:/x"],
    ["//127.0.0.1/C$/x", "C:/x"],
    ["//?/UNC/localhost/c$/x", "c:/x"],
    ["//?/unc/host/c$", "c:/"],
    ["//c", "/c"],
  ];
  for (const [input, want] of cases) test(`${input} → ${want}`, () => assert.equal(windowsPathForm(input), want));
  const unchanged = ["/c", "/s", "/users/x", "c:/x", "relative/c/x", "//server/share/x", "//?/Volume{abc}/x"];
  for (const input of unchanged) test(`${input} 原样`, () => assert.equal(windowsPathForm(input), input));
});
