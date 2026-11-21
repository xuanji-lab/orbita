/**
 * 自动化记录的命令串闸门（bash / powershell）。
 *
 * 背景：闸门先后按「列举危险写法」补过三轮（完整路径 → cd / $HOME / find / 符号链接 / 改名 → pushd / 相对改名 /
 * 泛破坏），每轮独立验收都找到新漏洞——最后一轮漏的是 `cp` / `mv` / `rsync` / `install` 把记录文件或数据目录
 * **当目标**去覆盖。黑名单没有尽头，所以这一版对**本实例的数据目录**翻成**白名单**：
 *
 *   一条命令只要「碰到」数据目录（会话工作台 `workbenches/<id>/` 之下除外），默认就拒；
 *   只有能确定是**只读**的才放行。
 *
 * ## 一条命令进来之后依次经过的判断
 *
 * 1. **规整**：`$'\x61'` 解码 → 命令里自己写的 `NAME=值` 与环境变量展开（`$HOME` / `${HOME}` / `%APPDATA%` /
 *    `$env:APPDATA`）→ `~` 展开 → 引号折平（引号内空格编码成 \u0000，路径可以含空格）→ 花括号展开。
 *    得到若干 variant；反斜杠既可能是转义也可能是 Windows 路径分隔符，两种读法各过一遍。
 * 2. **解码后执行**（`base64 -d | sh`、`printf '\x72\x6d' | sh`）整条拒——名字在运行时才拼出来，字面上什么都看不见。
 * 3. **切段**：按 `; && || | & 换行 <<< $( ( ) { }` 切成一条条命令，顺着字面量 `cd` / `pushd` 模拟当前目录。
 * 4. **逐词落点**：每个词按当前目录解析成绝对路径（跟符号链接 realpath、大小写折叠、`..` 折叠），
 *    通配词按「它可能展开到哪」判断；落点归成六类：
 *      record（本实例或受保护的记录文件及其 `.tmp` / `.bad-` / `.tampered-` 兄弟）/ data（数据目录本身与其下
 *      非工作台的路径）/ above（数据目录的上级，或别处记录所在目录本身及其上级）/ wb（会话工作台，放行）/ other / 解析不了。
 * 5. **判定**（只看「碰到」的段）：
 *      - 落点是 record：一律拒（读也拒，拒绝语指向 read 工具与 automation_list）；重定向输出落进 record / data 一律拒；
 *      - 其余碰到 data（或有效当前目录在 data）的段：命令词必须在**只读白名单**里（ls / stat / du / file / wc / head / tail /
 *        cat / grep / rg / find（不带 -delete -exec -ok -fprint*）/ diff / shasum / md5 与几个纯输出命令），
 *        或者是「以 data 为**源**往外拷」的 cp / rsync / ditto / install / tar -c，其余（mv / ln / rm / tar -x / 解释器 / 重定向 …）一律拒；
 *      - 碰到 above：只读与「以它为拷贝**目标目录**且来源里没有同名子项」放行，递归 / 覆盖到它的一律拒；
 *      - 碰到过 data 的命令里，后面再出现 xargs / parallel / shell / eval / 循环这类「把列出来的名字交给别的命令」的段，拒；
 *      - 内联解释器（`python -c` / `node -e` …）里的代码看不懂：代码里出现 data 路径 / 上级路径 / 记录文件名（非绝对安全路径）就拒；
 *      - 变量拼接出来的记录文件名（展开前含 `$` 与反引号）解析不了，保守拒。
 *    没有任何词落在数据目录里、当前目录也不在里面的命令，闸门不管（项目里、工作台里、别的实例里、/tmp 里都照常）。
 * 5b. 数据目录之外还有**只保记录文件**的名单（开发实例里的正式实例记录、数据目录外的事件镜像）：它们的目录不是白名单管辖区，
 *    只有记录文件本身（含兄弟）按 record 管，目录本身及其上级按 above 管（不许删 / 改名 / chmod）。
 *
 * **拦截力度如实说**：这仍是对命令串的匹配，不是沙箱。拦不住「名字在运行时才拼出来」（命令替换产出名字、脚本文件里写好再
 * `bash x.sh`、解释器里 base64 解码拼名）、按 inode 删、从文件里读出名字再删；真正密封要靠操作系统级沙箱（另立项）。
 * 主进程的兜底（automation/guard.ts）负责让这些拦不住的也不会无声消失。
 */
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { msysDrivePath } from "./tool-paths.ts";

export interface CommandGuardEnv {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  /** 测试注入：路径的真实位置（默认跟符号链接走，不存在的部分接在最深的已存在父目录后） */
  realpath?: (path: string) => string;
  /** 默认 process.platform；测试注入。只有 win32 才把 Git Bash / UNC / `\\?\` 等写法折成盘符路径再比（见 windowsPathForm） */
  platform?: NodeJS.Platform;
}

export function defaultGuardEnv(): CommandGuardEnv {
  return { home: homedir(), env: process.env, platform: process.platform };
}

/**
 * Windows 上「同一个文件的别种写法」折成盘符写法 `c:/x`（输入是反斜杠已转成正斜杠的路径词）。只给闸门比对用。
 *
 * 根因（2026-11-17 Windows 真机验收）：闸门的比对只把反斜杠转正斜杠、小写，受保护目录是 `c:/…` 形式，
 * Git Bash 里 `rm -f /c/…/sessions/x.jsonl` 的 `/c/…` 对不上——当成了根目录下一个叫 `c` 的目录，放行，文件被删。
 * read / write / edit 那边早就用 tool-paths.ts 的 msysDrivePath 折算，这里用同一个函数，不再手抄。
 *
 * 折的写法：
 * - `/c/x`、`/mnt/c/x`、`/cygdrive/c/x`、`/proc/cygdrive/c/x`（msysDrivePath）；
 * - `//c/x`：MSYS 里是主机名为 `c` 的 UNC，不到 C 盘；仍当成 C 盘算（多拦一个单字母主机名的网络路径，安全向）；
 * - `\\?\C:\x`、`\\.\C:\x`（及正斜杠版 `//?/C:/x`）：去掉设备前缀；
 * - 管理共享 `\\<任意主机>\c$\x`（localhost、127.0.0.1、本机名……）与 `\\?\UNC\<主机>\c$\x`：折成 `c:/x`。
 *   不认主机是不是本机——别的机器上同路径的文件也拦，安全向。
 * 不折：裸的 `/c`（后面没有 `/`）——在 Windows 命令里它几乎总是开关（`cmd /c`、`dir /s`），折成 C 盘根会把每条
 * `cmd /c …` 都当成「对数据目录的上级动手」拒掉。要指 C 盘根写 `/c/` 会折。
 * 折不了（纯字符串做不到）：8.3 短文件名、`\\?\Volume{…}\`、`\\?\GLOBALROOT\Device\…`、subst / 映射盘 / 联接点——
 * 已存在的路径靠 realpathLoose 在 Windows 上走 realpathSync.native（长名、跟联接点）。
 */
export function windowsPathForm(word: string): string {
  let text = word.replace(/^\/\/[?.]\/unc\//i, "//").replace(/^\/\/[?.]\/(?=[a-z]:(?:\/|$))/i, "");
  const share = /^\/\/[^/]+\/([a-z])\$(\/.*)?$/i.exec(text);
  if (share !== null) return `${share[1] ?? ""}:${share[2] ?? "/"}`;
  if (/^\/\/[a-z](?:\/|$)/i.test(text)) text = text.slice(1);
  if (/^\/[a-z]$/i.test(text)) return text;
  const native = msysDrivePath(text);
  return native === text ? text : native.replaceAll("\\", "/");
}

/** 一段命令文本里以 `/` 开头的词逐个过 windowsPathForm（解释器代码、重定向、`of=/c/…` 这类不走逐词解析的位置） */
export function windowsTextForms(text: string): string {
  return text.replaceAll(/(^|[\s\u0000=,;&|()<>])(\/[^\s=,;&|()<>]*)/g, (_m: string, lead: string, path: string) => lead + windowsPathForm(path));
}

/**
 * 路径的真实位置：跟符号链接走；文件还不存在时，对「已存在的最深一级父目录」取真实路径再接上剩下的名字。
 * Windows 上用 realpathSync.native（GetFinalPathNameByHandle）：JS 版只逐级 lstat，不把 8.3 短名（`ORBITA~1`）展开成长名，
 * 闸门就认不出 `C:\Users\U\AppData\Roaming\ORBITA~1\sessions\x` 是受保护目录。posix 上照旧用 JS 版，行为不变。
 */
export function realpathLoose(path: string): string {
  const start = resolve(path);
  const realpathOf = process.platform === "win32" ? realpathSync.native : realpathSync;
  let current = start;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathOf(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return start;
      tail.push(basename(current));
      current = parent;
    }
  }
}

/** 闸门管辖范围：受保护的记录文件，加上「本实例的数据目录」（白名单管辖区，不一定等于记录文件的父目录） */
export interface CommandScope {
  /** 受保护的记录文件（绝对路径；本实例的与只保记录文件的别处的混在一起） */
  files: readonly string[];
  /** 本实例的数据目录（白名单管辖）；记录文件在它们之外的，只按文件保 */
  ownDirs: readonly string[];
}

export type CommandRefusal =
  | { kind: "file"; file: string }
  | { kind: "dataDir"; dir: string; why: string };

/* ---------- 规整 ---------- */

/**
 * `$'\x61…'` ANSI-C 引号：解成明文（只处理 \xHH、\NNN 八进制、\uHHHH 与常见单字符转义）。
 * **解完仍包在单引号里**：引号里的空格是路径的一部分（`$'…/Application Support/…/dura\x62le/x'`），
 * 丢了引号，后面按空格切参数会把路径拆成两半、对不上受保护路径（2026-11-16 复验在真实例里用它删成了文件）。
 */
function decodeAnsiC(command: string): string {
  return command.replaceAll(/\$'((?:[^'\\]|\\.)*)'/g, (_whole: string, body: string) => {
    const plain = body.replaceAll(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|u[0-9a-fA-F]{4}|.)/g, (_m: string, esc: string) => {
      if (esc[0] === "x" && esc.length > 1) return String.fromCharCode(parseInt(esc.slice(1), 16));
      if (esc[0] === "u" && esc.length === 5) return String.fromCharCode(parseInt(esc.slice(1), 16));
      if (/^[0-7]+$/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
      if (esc === "n") return "\n";
      if (esc === "t") return "\t";
      return esc;
    });
    return `'${plain.replaceAll("'", "'\\''")}'`;
  });
}

/** 命令里自己写的 `NAME=值`（含 export / declare / local）；值可以带引号 */
function parseAssignments(command: string): Map<string, string> {
  const vars = new Map<string, string>();
  const pattern = /(?:^|[\s;&|(])(?:(?:export|declare|local|typeset|readonly)\s+(?:-\S+\s+)?)?([A-Za-z_][A-Za-z0-9_]*)=("([^"]*)"|'([^']*)'|[^\s;&|)]*)/g;
  for (const match of command.matchAll(pattern)) {
    const name = match[1];
    if (name === undefined) continue;
    vars.set(name, match[3] ?? match[4] ?? (match[2] ?? "").replaceAll(/["']/g, ""));
  }
  return vars;
}

/** `$NAME` / `${NAME}` / `%NAME%` / `$env:NAME` 展开（命令里的赋值优先于进程环境）；未知变量原样留着 */
function expandVars(text: string, vars: ReadonlyMap<string, string>, guard: CommandGuardEnv): string {
  const lookup = (name: string): string | undefined => {
    const own = vars.get(name);
    if (own !== undefined) return own;
    if (name === "HOME" || name === "USERPROFILE") return guard.home;
    return guard.env[name] ?? guard.env[name.toUpperCase()];
  };
  let current = text;
  // 变量里还可能引用别的变量：展开几轮（环路由轮数上限兜住）
  for (let round = 0; round < 4; round += 1) {
    const next = current
      .replaceAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole: string, name: string) => lookup(name) ?? whole)
      .replaceAll(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (whole: string, name: string) => lookup(name) ?? whole)
      .replaceAll(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole: string, name: string) => lookup(name) ?? whole)
      .replaceAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole: string, name: string) => lookup(name) ?? whole);
    if (next === current) break;
    current = next;
  }
  return current;
}

/** 参数位置的 `~` / `~用户名` 展开成家目录（行首 / 空白 / 引号 / `=` / 分隔符之后、`/` 或结尾之前） */
function expandTilde(text: string, guard: CommandGuardEnv): string {
  return text.replaceAll(/(^|[\s"'=;&|()><])~([A-Za-z0-9._-]*)(?=\/|\\|\s|$)/g, (_m: string, lead: string, user: string) => {
    // 家目录带空格（命令里自己给 HOME 赋了 `…/Application Support` 这种值）：包上引号，免得后面按空格切参数时把路径拆成两半
    const home = tildeHome(user, guard);
    return lead + (/\s/.test(home) ? `"${home}"` : home);
  });
}

/**
 * `~` / `~用户名` 指向哪个家目录（shell 的展开规则）：`~` 与本人的用户名（家目录末段、USER、LOGNAME）→ 本人家目录；
 * 别的用户名 → 与本人家目录同级的同名目录（macOS `/Users/<名>`、Linux `/home/<名>` 的惯例）。
 * 2026-11-16 复验：`rm ~guanhongli/Library/…/automations.json` 绕过了只认 `~/` 的展开，在真实例里删成了。
 * 只给闸门比对用，不改真命令。
 */
export function tildeHome(user: string, guard: CommandGuardEnv): string {
  if (user === "") return guard.home;
  // Windows：家目录是 `C:\Users\<名>`，用户名在 USERNAME 里（Git Bash 的 `~<名>` 按它认本人）
  const win = (guard.platform ?? process.platform) === "win32";
  const own = [basename(guard.home), guard.env["USER"], guard.env["LOGNAME"], ...(win ? [win32.basename(guard.home), guard.env["USERNAME"]] : [])];
  if (own.includes(user)) return guard.home;
  return win ? win32.join(win32.dirname(guard.home), user) : join(dirname(guard.home), user);
}

/** 找第一个带逗号的 `{a,b}` 组（没有逗号的 `{}` 是字面量，跳过） */
function findBraceGroup(value: string): { open: number; close: number; commas: number[] } | null {
  for (let open = value.indexOf("{"); open !== -1; open = value.indexOf("{", open + 1)) {
    let depth = 0;
    const commas: number[] = [];
    for (let i = open; i < value.length; i += 1) {
      const ch = value[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          if (commas.length > 0) return { open, close: i, commas };
          break;
        }
      } else if (ch === "," && depth === 1) commas.push(i);
    }
  }
  return null;
}

/** 花括号展开 `a{b,c}d` → abd / acd（嵌套递归，最多 64 个结果） */
export function expandBraces(text: string, cap = 64): string[] {
  const out: string[] = [];
  const walk = (value: string): void => {
    if (out.length >= cap) return;
    const group = findBraceGroup(value);
    if (group === null) {
      out.push(value);
      return;
    }
    const pre = value.slice(0, group.open);
    const post = value.slice(group.close + 1);
    const bounds = [group.open, ...group.commas, group.close];
    for (let i = 0; i < bounds.length - 1; i += 1) {
      const start = bounds[i];
      const end = bounds[i + 1];
      if (start === undefined || end === undefined) continue;
      walk(pre + value.slice(start + 1, end) + post);
    }
  };
  walk(text);
  return out;
}

/**
 * 引号内的空格与转义空格编码成 \u0000：路径可以含空格（"Application Support"），
 * 引号折平后那些空格不能变成词边界。比对路径时再还原。
 *
 * 例外：紧跟在 `<<<` / `eval` / `sh -c` / `powershell -Command` 之后的引号串是**代码**——里面的空格就是命令的词边界，
 * 不能编码（否则 `bash <<< "cd D; rm x"` 整串成了一个词）。代码里已知的含空格路径（数据目录、记录文件及其上级）仍然编码。
 */
function encodeQuotedSpaces(text: string, knownSpacePaths: readonly string[]): string {
  const protectKnown = (content: string): string => {
    let out = content;
    for (const known of knownSpacePaths) out = out.replace(new RegExp(escapeRegExp(known), "gi"), (hit: string) => hit.replaceAll(" ", "\u0000"));
    return out;
  };
  let out = "";
  let quote: string | null = null;
  let codeQuote = false;
  let codeStart = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (quote === null) {
      if (ch === '"' || ch === "'") {
        quote = ch;
        codeQuote = /(?:<<<|\beval|\s-[a-z]*c|\s-command|\s\/c)\s*$/i.test(out);
        codeStart = out.length;
      } else if (ch === "\\" && text[i + 1] === " ") {
        out += "\u0000";
        i += 1;
      } else out += ch;
    } else {
      if (ch === quote) {
        quote = null;
        if (codeQuote) out = out.slice(0, codeStart) + protectKnown(out.slice(codeStart));
      } else if (ch === " " && !codeQuote) out += "\u0000";
      else if (ch === "\\" && text[i + 1] === " " && codeQuote) {
        out += "\u0000";
        i += 1;
      } else out += ch;
    }
  }
  return out;
}

interface Variant {
  /** 规整后的命令串（保留大小写；反斜杠按本读法处理） */
  text: string;
  /** 展开前不含 `$` 与反引号：名字都是字面量，可以拿去解析；含变量的（`rm $a$b`）解析不出名字到底指哪，保守 */
  literal: boolean;
}

/**
 * 「当前目录」的几种写法换成 `.`：`~+`、`$PWD` / `${PWD}`、`$(pwd)` / `` `pwd` ``（可带 -L / -P）。它们的值完全可预测，
 * 换成 `.` 之后，后面的相对段落按（跟踪了 cd 的）当前目录解析，与直接写相对路径走同一套判定。
 * 2026-11-16 复验：`rm ~+/../../Library/…/durable/x`、`rm "$PWD/../../…"`、`rm "$(pwd)/../../…"` 在真实例里删成了——
 * 闸门不认这几种写法，相对段落就落不到受保护路径上（直接写 `../../Library/…` 是拦得住的）。
 * `~-` / `$OLDPWD`（上一个目录）闸门不知道是哪，不换，归入变量一类。
 */
function currentDirForms(command: string): string {
  return command
    .replaceAll(/\$\(\s*pwd(?:\s+-[LP])?\s*\)|`\s*pwd(?:\s+-[LP])?\s*`/g, ".")
    .replaceAll(/\$\{PWD\}|\$PWD(?![A-Za-z0-9_])/g, ".")
    .replaceAll(/(^|[\s"'=;&|()><])~\+(?=\/|\\|\s|$)/g, "$1.");
}

/**
 * macOS 的 firmlink 前缀：`/System/Volumes/Data/Users/…` 与 `/Users/…` 是同一批文件（`/Library`、`/private`、`/opt` 等同理），
 * realpath 不换它。比对前去掉这段前缀，路径就与受保护路径的写法对得上。只给闸门比对用。
 * 2026-11-16 复验：`cd /System/Volumes/Data/…/Application\ Support && rm 相对名` 删成了（cd 跟踪是字符串比较）；
 * write 到还不存在的受保护目录时，按文件身份比也认不出这个前缀（stat 不到）。
 */
export function stripFirmlinkPrefix(text: string): string {
  return text.replaceAll(/\/System\/Volumes\/Data(?=\/)/gi, "");
}

function normalizeVariants(command: string, guard: CommandGuardEnv, knownSpacePaths: readonly string[]): Variant[] {
  const decoded = stripFirmlinkPrefix(decodeAnsiC(currentDirForms(command)));
  const literal = !/[$`]/.test(decoded);
  const vars = parseAssignments(decoded);
  // 命令里自己给 HOME 赋了值（`HOME=…; rm ~/…`）：`~` 可能按新值展开（前缀式 `HOME=… rm ~/…` 则仍按旧值），
  // 两种都判。2026-11-16 复验：先把 HOME 改成数据目录的上级再 `rm ~/orbita/…` 删成了
  const assignedHome = vars.get("HOME");
  const homes = assignedHome !== undefined && assignedHome !== "" && assignedHome !== guard.home ? [guard.home, assignedHome] : [guard.home];
  const variants: Variant[] = [];
  const win = (guard.platform ?? process.platform) === "win32";
  const push = (text: string): void => {
    variants.push({ text: win ? windowsTextForms(text) : text, literal });
  };
  for (const home of homes) {
    const expanded = encodeQuotedSpaces(expandTilde(expandVars(decoded, vars, guard), { ...guard, home }), knownSpacePaths);
    const loosened = expanded.replaceAll(/["']/g, "");
    const hasBackslash = loosened.includes("\\");
    for (const brace of expandBraces(loosened)) {
      // 反斜杠的两种读法：Windows 路径分隔符（`orbita\automations.json`）与 posix 转义（`au\tomations`）
      push(brace.replaceAll("\\", "/"));
      if (hasBackslash) push(brace.replaceAll("\\", ""));
    }
  }
  return variants;
}

/* ---------- 路径工具 ---------- */

/** 比对用的折叠：反斜杠转正斜杠、收拢连续斜杠与 `/./`、小写（APFS / NTFS 默认不分大小写） */
function fold(value: string): string {
  return value.replaceAll("\\", "/").replaceAll(/\/{2,}/g, "/").replaceAll(/\/\.(?=\/|$)/g, "").toLowerCase();
}

const ABSOLUTE = /^(?:\/|[A-Za-z]:\/)/;

/** 把路径里的 `.` / `..` 折掉（纯字符串，不碰文件系统） */
function collapseDots(path: string): string {
  const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? "";
  const rest = path.slice(drive.length);
  const absolute = rest.startsWith("/");
  const stack: string[] = [];
  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") stack.pop();
      else if (!absolute) stack.push("..");
      continue;
    }
    stack.push(part);
  }
  return `${drive}${absolute ? "/" : ""}${stack.join("/")}`;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] ?? "";
    if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else if (ch === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close === -1) source += "\\[";
      else {
        source += `[${glob.slice(i + 1, close).replace(/^!/, "^")}]`;
        i = close;
      }
    } else source += escapeRegExp(ch);
  }
  return new RegExp(`^${source}$`);
}

function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? (index === 0 && path.length > 1 ? "/" : "") : path.slice(0, index);
}

function ancestorsOf(path: string): string[] {
  const out: string[] = [];
  let current = parentOf(path);
  while (current !== "") {
    out.push(current);
    // 盘符根两种写法都算上级（`rm -rf C:/` 折叠后是 `c:/`，不是 `c:`）；posix 路径没有盘符，不受影响
    if (/^[a-z]:$/.test(current)) out.push(`${current}/`);
    if (current === "/" || /^[a-z]:$/.test(current)) break;
    current = parentOf(current);
  }
  return out;
}

function componentsBelow(base: string, target: string): string[] | null {
  if (target === base) return [];
  const prefix = base === "/" ? "/" : `${base}/`;
  if (!target.startsWith(prefix)) return null;
  return target.slice(prefix.length).split("/").filter((part) => part !== "");
}

/* ---------- 落点模型 ---------- */

type RelKind = "other" | "wb" | "above" | "data" | "record" | "unresolved";
interface Rel {
  kind: RelKind;
  file?: string;
  /** above 的是哪个目录（拒绝语与「拷贝目标目录」判断用） */
  dir?: string;
}
const RANK: Record<RelKind, number> = { other: 0, wb: 0, unresolved: 1, above: 2, data: 3, record: 4 };
const worse = (a: Rel, b: Rel): Rel => (RANK[b.kind] > RANK[a.kind] ? b : a);
const OTHER: Rel = { kind: "other" };

interface RecordEntry {
  file: string;
  /** 折叠后的路径（字面量与 realpath 两种都收） */
  path: string;
  base: string;
  dir: string;
}

class Model {
  readonly records: RecordEntry[] = [];
  readonly ownDirs: string[] = [];
  /** 数据目录之外、只保记录文件的那些目录（目录本身与上级按 above 管） */
  readonly foreignDirs: string[] = [];
  readonly above = new Map<string, string>();
  readonly home: string;
  private readonly realCache = new Map<string, string>();
  private readonly real: (path: string) => string;

  constructor(scope: CommandScope, guard: CommandGuardEnv) {
    this.real = guard.realpath ?? realpathLoose;
    this.home = fold(guard.home);
    const addVariants = (path: string): string[] => [...new Set([fold(path), fold(this.realOf(path))])];
    for (const dir of scope.ownDirs) for (const variant of addVariants(dir)) if (!this.ownDirs.includes(variant)) this.ownDirs.push(variant);
    for (const file of scope.files) {
      for (const variant of addVariants(file)) {
        const entry: RecordEntry = { file, path: variant, base: variant.slice(variant.lastIndexOf("/") + 1), dir: parentOf(variant) };
        this.records.push(entry);
        if (!this.ownDirs.includes(entry.dir) && !this.foreignDirs.includes(entry.dir)) this.foreignDirs.push(entry.dir);
      }
    }
    for (const dir of this.ownDirs) for (const ancestor of ancestorsOf(dir)) this.above.set(ancestor, dir);
    for (const dir of this.foreignDirs) {
      this.above.set(dir, dir);
      for (const ancestor of ancestorsOf(dir)) this.above.set(ancestor, dir);
    }
  }

  realOf(path: string): string {
    const cached = this.realCache.get(path);
    if (cached !== undefined) return cached;
    let value: string;
    try {
      value = this.real(path);
    } catch {
      value = path;
    }
    this.realCache.set(path, value);
    return value;
  }

  /** 折叠后的路径落在哪一类 */
  relateFolded(path: string): Rel {
    for (const entry of this.records) {
      if (path === entry.path || path.startsWith(`${entry.path}.`)) return { kind: "record", file: entry.file };
    }
    for (const own of this.ownDirs) {
      if (path === own) return { kind: "data", dir: own };
      if (path.startsWith(`${own}/`)) {
        return /^workbenches\/[^/]+(?:\/|$)/.test(path.slice(own.length + 1)) ? { kind: "wb" } : { kind: "data", dir: own };
      }
    }
    const above = this.above.get(path);
    if (above !== undefined) return { kind: "above", dir: above };
    return OTHER;
  }

  /** 一个绝对路径（保留大小写，已折叠 `..`）：字面量与 realpath 两个读法取更危险的 */
  relateAbsolute(abs: string): Rel {
    let rel = this.relateFolded(fold(abs));
    const real = fold(this.realOf(abs));
    if (real !== fold(abs)) rel = worse(rel, this.relateFolded(real));
    return rel;
  }

  /**
   * 通配词可能展开到哪里：`base` 是通配符之前那一段目录（绝对路径），`rest` 是通配符起的各级。
   * 沿着「记录文件 / 数据目录 / 别处记录所在目录」的路径逐级比对，匹配得上就算碰到。
   */
  relateGlob(baseAbs: string, rest: string): Rel {
    const comps = fold(rest).split("/").filter((part) => part !== "");
    const regexes = comps.map((part) => globToRegExp(part));
    let result: Rel = OTHER;
    for (const base of new Set([fold(baseAbs), fold(this.realOf(baseAbs))])) {
      // 起点本身在数据目录里 / 工作台里 / 就是记录：算上；起点只是数据目录的上级不算（通配还得真匹配到下一级的名字）
      let baseRel = this.relateFolded(base);
      // `<数据目录>/workbenches/*`：通配这一级是工作台 id，等于已经在工作台里
      if (baseRel.kind === "data" && this.ownDirs.some((own) => base === `${own}/workbenches`)) baseRel = { kind: "wb" };
      if (baseRel.kind !== "above") result = worse(result, baseRel);
      const chains: { target: string; hit: Rel }[] = [];
      for (const own of this.ownDirs) chains.push({ target: own, hit: { kind: "data", dir: own } });
      for (const dir of this.foreignDirs) chains.push({ target: dir, hit: { kind: "above", dir } });
      for (const entry of this.records) chains.push({ target: entry.path, hit: { kind: "record", file: entry.file } });
      for (const { target, hit } of chains) {
        const below = componentsBelow(base, target);
        if (below === null) continue;
        if (below.length === 0) {
          // 通配就在目标目录里面：能匹配到记录文件名就是 record，否则只是数据目录里的东西
          const first = regexes[0];
          if (first === undefined) continue;
          if (hit.kind === "data" || hit.kind === "above") {
            if (this.records.some((entry) => entry.dir === target && first.test(entry.base))) {
              const entry = this.records.find((item) => item.dir === target && first.test(item.base));
              result = worse(result, { kind: "record", file: entry?.file ?? "" });
            } else if (hit.kind === "data") result = worse(result, { kind: "data", dir: target });
          }
          continue;
        }
        const depth = Math.min(regexes.length, below.length);
        let matches = true;
        for (let i = 0; i < depth; i += 1) {
          if (!(regexes[i]?.test(below[i] ?? "") ?? false)) {
            matches = false;
            break;
          }
        }
        if (!matches || regexes.length === 0) continue;
        if (regexes.length < below.length) result = worse(result, { kind: "above", dir: target });
        else if (regexes.length === below.length) result = worse(result, hit);
        else if (hit.kind === "data") result = worse(result, hit);
      }
    }
    return result;
  }
}

/* ---------- 切段与分词 ---------- */

interface Segment {
  text: string;
  /** 前面紧挨着的是管道 `|`：它在吃上一段的输出 */
  pipeBefore: boolean;
  /** 在 `$( )` / 反引号 / `<( )` 里面：它的输出会被外层命令吃掉 */
  inSubst: boolean;
}

/** 按 `;` `&&` `||` `|` `&` 换行与括号切成「一条条命令」，并记下管道与命令替换的嵌套；`2>&1`、`&>` 这类重定向里的 & 先摘掉 */
function segmentsOf(text: string): Segment[] {
  const cleaned = text.replaceAll(/\d*>&\d*-?/g, " ").replaceAll(/&>>?/g, ">");
  const parts = cleaned.split(/(\n|;|&&|\|\||\||&|<<<|\$\(|<\(|>\(|\(|\)|`|\{|\})/);
  const stack: string[] = [];
  const out: Segment[] = [];
  let pendingPipe = false;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? "";
    if (index % 2 === 1) {
      if (part === "$(" || part === "<(" || part === ">(") stack.push("subst");
      else if (part === "(") stack.push("paren");
      else if (part === ")") stack.pop();
      else if (part === "`") {
        if (stack[stack.length - 1] === "tick") stack.pop();
        else stack.push("tick");
      }
      if (part === "|") pendingPipe = true;
      else if (part !== "(" && part !== "{") pendingPipe = false;
      continue;
    }
    const trimmed = part.trim();
    if (trimmed === "") continue;
    out.push({ text: trimmed, pipeBefore: pendingPipe, inSubst: stack.includes("subst") || stack.includes("tick") });
    pendingPipe = false;
  }
  return out;
}

interface Redirect {
  op: "out" | "in";
  target: string;
}
interface ParsedSegment {
  words: string[];
  redirects: Redirect[];
}

function parseSegment(segment: string): ParsedSegment {
  const tokens = segment.split(/\s+/).filter((token) => token !== "");
  const words: string[] = [];
  const redirects: Redirect[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    if (token.startsWith("<<")) {
      // here-doc 标记（`<<EOF` / `<< EOF`）：定界词不是路径
      if (token === "<<" || token === "<<-") i += 1;
      continue;
    }
    const match = /^(?:\d*|&)(>>|>\||>|<)(.*)$/.exec(token);
    if (match === null) {
      words.push(token);
      continue;
    }
    let target = match[2] ?? "";
    if (target === "") {
      target = tokens[i + 1] ?? "";
      i += 1;
    }
    if (target !== "") redirects.push({ op: match[1] === "<" ? "in" : "out", target });
  }
  return { words, redirects };
}

const WRAPPERS = new Set(["sudo", "doas", "time", "command", "builtin", "nohup", "exec", "env", "nice", "ionice", "timeout", "stdbuf", "caffeinate"]);

/** 取一段命令的命令词与其后的参数（跳过 `VAR=x` 赋值与 sudo / env / nice 这类前缀） */
function verbOf(words: readonly string[]): { verb: string; args: string[] } {
  let index = 0;
  while (index < words.length) {
    const word = words[index] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) index += 1;
    else if (WRAPPERS.has(word.toLowerCase())) {
      const wrapper = word.toLowerCase();
      index += 1;
      // 这些前缀自己带的选项与参数
      while (index < words.length) {
        const next = words[index] ?? "";
        if (next.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(next)) {
          index += 1;
          if ((wrapper === "nice" || wrapper === "ionice") && /^-[nc]$/.test(next)) index += 1;
          if (wrapper === "timeout" && /^-[ks]$/.test(next)) index += 1;
        } else if (wrapper === "timeout" && /^[0-9.]+[smhd]?$/.test(next)) {
          index += 1;
          break;
        } else break;
      }
    } else break;
  }
  const raw = words[index] ?? "";
  const stripped = raw.replace(/^\\/, "").replaceAll("\u0000", " ");
  const verb = stripped.slice(stripped.lastIndexOf("/") + 1).toLowerCase().replace(/\.exe$/, "");
  return { verb, args: words.slice(index + 1) };
}

/* ---------- 动词分类 ---------- */

const NAVIGATION = new Set(["cd", "pushd", "popd", "chdir", "set-location", "sl", "push-location", "pop-location"]);

/** 只读白名单：小而明确。其余命令碰到数据目录一律拒 */
const READ_ONLY = new Set([
  "ls", "dir", "stat", "du", "file", "wc", "head", "tail", "cat", "type", "grep", "egrep", "fgrep", "rg", "diff", "jq", "shasum", "md5", "md5sum", "sha1sum", "sha256sum",
  "get-childitem", "gci", "get-content", "gc", "select-string", "sls",
  // 纯输出，不读不写文件内容（重定向另行检查）
  "echo", "printf", "pwd", "true", "false", "test", "[", "basename", "dirname", "realpath", "readlink",
]);
/** 管道里接在「碰过数据目录」的段后面也无害的过滤器（它们自己的路径参数照样检查） */
const FILTERS = new Set(["sort", "uniq", "cut", "tr", "nl", "rev", "tac", "column", "awk", "tee", "sed", "less", "more", "xxd", "od", "strings"]);
const COPY_OUT = new Set(["cp", "copy", "copy-item", "rsync", "ditto", "install"]);
const MOVERS = new Set(["mv", "move", "move-item"]);
const LANG_RUNTIMES = /^(?:python[0-9.]*|node|nodejs|bun|deno|perl|ruby|php|lua|osascript)$/;
/**
 * 解释器单行里「路径可能在运行时变」的迹象：chdir / 环境变量 / 取 cwd / 路径拼接 / 起别的进程。出现任何一个，
 * 代码里的相对名不能按当前目录解析（先 chdir 再删、环境变量里藏路径、拼出别的名字），保守拒。输入是折叠成小写的代码文本。
 */
const UNCERTAIN_CODE = /chdir|environ|getenv|process\.env|argv|getcwd|\bcwd\b|__file__|__dirname|expanduser|homedir|join\s*\(|path\.resolve|\+|\bformat\s*\(|\bsystem\b|popen|subprocess|spawn|child_process|\bexec|\beval\s*\(|\bimport\s*\(/;
const FIND_MUTATING = /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fls|fprintf)$/;
const FIND_PATTERN_ARGS = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex", "-lname", "-ilname", "-type", "-perm", "-user", "-group", "-size", "-mtime", "-atime", "-ctime", "-mmin", "-amin", "-cmin", "-maxdepth", "-mindepth"]);
const GIT_CWD_MUTATING = /^(?:clean|reset|checkout|restore|rm|stash|gc|prune|mv|apply|merge|pull|rebase|switch|am|cherry-pick|revert)$/;
const OPTION_WITH_ARG: Record<string, readonly string[]> = {
  cp: ["-t", "-S", "--target-directory", "--suffix"],
  copy: [],
  "copy-item": ["-destination", "-path", "-literalpath"],
  ditto: [],
  install: ["-m", "-o", "-g", "-t", "-S", "--target-directory"],
  rsync: [
    "-e", "--rsh", "--exclude", "--include", "--exclude-from", "--include-from", "--filter", "-f", "--files-from", "--partial-dir", "--backup-dir", "--log-file", "--temp-dir", "-T",
    "--compare-dest", "--copy-dest", "--link-dest", "--chmod", "--chown", "--usermap", "--groupmap", "--max-size", "--min-size", "--bwlimit", "--timeout", "--port", "--rsync-path",
    "--password-file", "--out-format", "--info", "--debug", "--suffix", "--read-batch", "--write-batch",
  ],
};

/**
 * 只读白名单命令的「已知安全选项」：每个命令一份。判断按参数的**角色**：落在数据目录里的词，必须是这个命令的**输入操作数**
 * 或「已知只带输入的选项」的取值才放行；落在任何别的选项的取值位置、或出现在含**不认识的选项**的命令里，一律拒——
 * 不再逐个追「又发现一个能写文件的选项」（sort -o、diff --output、find -fls …），名单之外的选项一概不信。
 * 读 man（macOS BSD 与 GNU 两套）定的：flags = 不带取值的短选项字母；input = 取值是**读**的文件；other = 取值不是路径（模式、数字、格式串）。
 * 故意不收：file -C（写 magic.mgc）、sort -o、diff --output、find -fprint* / -fls、rg --pre、任何 -o / --output / --out* / --log-file 一类。
 */
interface OptionSpec {
  flags: string;
  input: string;
  other: string;
  longFlags: readonly string[];
  longInput: readonly string[];
  longOther: readonly string[];
}
const words = (text: string): string[] => text.split(/\s+/).filter((word) => word !== "");
const CHECKSUM_SPEC: OptionSpec = {
  flags: "bcCghpqrstUvwxz01",
  input: "",
  other: "as",
  longFlags: words("binary check tag text quiet status warn strict ignore-missing zero portable"),
  longInput: [],
  longOther: words("algorithm"),
};
const GREP_SPEC: OptionSpec = {
  flags: "abcEFGHhIiLlnoOPpqRrSsTUuVvwxyZz",
  input: "f",
  other: "eAmBCdD",
  longFlags: words(
    "recursive dereference-recursive count no-filename with-filename ignore-case invert-match line-number only-matching quiet silent files-with-matches files-without-match word-regexp line-regexp text null-data null no-messages extended-regexp fixed-strings perl-regexp basic-regexp initial-tab byte-offset",
  ),
  longInput: words("file exclude-from"),
  longOther: words("color colour regexp max-count after-context before-context context include exclude exclude-dir include-dir binary-files directories devices label"),
};
const OPTION_SPECS: Readonly<Record<string, OptionSpec>> = {
  ls: {
    flags: "1@AaBbCcdeFfGgHhiklmnOopqRrSsTtUuvWwxZ",
    input: "",
    other: "",
    longFlags: words("all almost-all classify directory human-readable inode recursive reverse size si dereference group-directories-first literal numeric-uid-gid hide-control-chars show-control-chars quote-name no-group author escape"),
    longInput: [],
    longOther: words("color sort time format width tabsize indicator-style time-style quoting-style"),
  },
  cat: { flags: "AbeEnstTuv", input: "", other: "", longFlags: words("show-all number-nonblank show-ends number squeeze-blank show-tabs show-nonprinting"), longInput: [], longOther: [] },
  head: { flags: "qvz", input: "", other: "nc", longFlags: words("quiet silent verbose zero-terminated"), longInput: [], longOther: words("lines bytes") },
  tail: { flags: "fFqrRvz", input: "", other: "nbc", longFlags: words("follow quiet silent verbose retry zero-terminated"), longInput: [], longOther: words("lines bytes sleep-interval pid max-unchanged-stats") },
  wc: { flags: "clmwL", input: "", other: "", longFlags: words("bytes chars lines words max-line-length"), longInput: words("files0-from"), longOther: [] },
  grep: GREP_SPEC,
  egrep: GREP_SPEC,
  fgrep: GREP_SPEC,
  rg: {
    flags: "abcFHhiIlLnNoPqsSUuvwxZ",
    input: "f",
    other: "ABCegjmMtTrEd",
    longFlags: words(
      "files hidden no-ignore no-ignore-vcs ignore-case case-sensitive smart-case word-regexp fixed-strings invert-match line-number no-line-number only-matching count count-matches files-with-matches files-without-match quiet follow no-filename with-filename heading no-heading json column vimgrep sort-files stats text null no-messages unrestricted multiline binary type-list line-regexp trim",
    ),
    longInput: words("file ignore-file"),
    longOther: words("glob iglob type type-not max-depth max-count max-filesize after-context before-context context regexp replace threads encoding color colors sort sortr path-separator"),
  },
  diff: {
    flags: "abBdEiNpqrsTtuwyZcefhln",
    input: "XS",
    other: "CUILxD",
    longFlags: words(
      "brief recursive unified new-file ignore-case report-identical-files text side-by-side ignore-all-space ignore-space-change ignore-blank-lines expand-tabs initial-tab strip-trailing-cr minimal speed-large-files left-column suppress-common-lines show-c-function",
    ),
    longInput: words("exclude-from from-file to-file starting-file"),
    longOther: words("unified context label exclude ignore-matching-lines width tabsize color palette"),
  },
  stat: { flags: "FLlnqrsxH", input: "", other: "fct", longFlags: words("dereference file-system terse"), longInput: [], longOther: words("format printf") },
  du: {
    flags: "aAcgHhkLlmnPrsSxZ0",
    input: "",
    other: "dBtI",
    longFlags: words("all apparent-size bytes total dereference human-readable si summarize one-file-system separate-dirs count-links"),
    longInput: words("files0-from exclude-from"),
    longOther: words("max-depth block-size threshold exclude time"),
  },
  file: {
    flags: "bchiLNnprsvzZ0",
    input: "mf",
    other: "F",
    longFlags: words("brief mime mime-type mime-encoding dereference no-dereference keep-going raw uncompress special-files no-pad no-buffer preserve-date"),
    longInput: words("magic-file files-from"),
    longOther: words("separator exclude parameter"),
  },
  shasum: CHECKSUM_SPEC,
  md5: CHECKSUM_SPEC,
  md5sum: CHECKSUM_SPEC,
  sha1sum: CHECKSUM_SPEC,
  sha256sum: CHECKSUM_SPEC,
  jq: {
    flags: "CcenrjRsSaMhV",
    input: "f",
    other: "L",
    longFlags: words("null-input raw-input slurp compact-output raw-output join-output ascii-output sort-keys tab color-output monochrome-output exit-status seq stream unbuffered"),
    longInput: words("from-file"),
    longOther: words("indent"),
  },
};

interface WordInfo {
  raw: string;
  rel: Rel;
  /** 词按当前目录解析出的绝对路径（通配词与解析不了的是 null） */
  abs: string | null;
  /** 是不是选项（`-rf`、`--delete`）：选项不是路径 */
  option: boolean;
  /** 引号串（`sed 'w D/x'`、`awk '… > "D/x"'`）里拆出来的子词：只参与「碰没碰到」，不是命令的操作数 */
  sub?: boolean;
}

/* ---------- 判定器 ---------- */

type Refusal = CommandRefusal | null;

interface SegmentAnalysis {
  verb: string;
  pipeBefore: boolean;
  inSubst: boolean;
  /** 这一段碰到了数据目录 / 其上级（或当前目录就在数据目录里） */
  touched: boolean;
  refusal: Refusal;
}

class Judge {
  private readonly model: Model;
  private readonly scope: CommandScope;
  private readonly guard: CommandGuardEnv;
  private readonly knownSpacePaths: readonly string[];

  constructor(model: Model, scope: CommandScope, guard: CommandGuardEnv, knownSpacePaths: readonly string[]) {
    this.model = model;
    this.scope = scope;
    this.guard = guard;
    this.knownSpacePaths = knownSpacePaths;
  }

  /**
   * 含空格的引号串（脚本、模式）里可能藏着路径：把已知含空格路径保护起来后按空白与标点拆成子词，逐个当路径落点判断。
   * 整串仍按一个词判过（它可能就是一个含空格的路径），子词只会让判定更严。
   */
  private subWords(raw: string): string[] {
    if (!raw.includes("\u0000")) return [];
    let text = raw.replaceAll("\u0000", " ");
    for (const known of this.knownSpacePaths) text = text.replace(new RegExp(escapeRegExp(known), "gi"), (hit: string) => hit.replaceAll(" ", "\u0000"));
    const whole = raw.replaceAll("\u0000", " ");
    return text.split(/[\s,;(){}[\]<>|&"'=]+/).filter((part) => part !== "" && !part.startsWith("-") && part.replaceAll("\u0000", " ") !== whole);
  }

  private dataDirName(): string {
    return humanDir(this.scope.ownDirs[0] ?? this.scope.files[0] ?? "");
  }

  private deny(why: string): CommandRefusal {
    return { kind: "dataDir", dir: this.dataDirName(), why };
  }

  private denyFile(rel: Rel): CommandRefusal {
    return { kind: "file", file: rel.file ?? this.scope.files[0] ?? "" };
  }

  private get win(): boolean {
    return (this.guard.platform ?? process.platform) === "win32";
  }

  /** win32：路径词的 Git Bash / UNC / `\\?\` 写法折成盘符写法（见 windowsPathForm）；其余平台原样 */
  private pathForm(word: string): string {
    return this.win ? windowsPathForm(word) : word;
  }

  /**
   * 本机原生路径（cwd、家目录）换成闸门内部的正斜杠写法。win32 上 cwd 是 `C:\Users\u\proj`：不转的话 collapseDots
   * 只认 `/`，`../..` 会把整段 `\Users\u\proj` 当成一级弹掉，得出 `C:../AppData/…` 这种对不上任何东西的相对路径（漏拦）。
   * posix 上反斜杠是合法文件名字符，不动。
   */
  nativeDir(path: string): string {
    return collapseDots(this.win ? windowsPathForm(path.replaceAll("\\", "/")) : path);
  }

  /** 去掉词尾的 `/`；win32 上盘符根 `C:/` 保留斜杠（去掉就成了「C 盘上的当前目录」`C:`，对不上盘符根） */
  private trimSlash(word: string): string {
    if (word.length <= 1) return word;
    if (this.win && /^[A-Za-z]:\/+$/.test(word)) return `${word.slice(0, 2)}/`;
    return word.replace(/\/+$/, "") || "/";
  }

  /** 当前目录 + 一个词 → 绝对路径（保留大小写）；current 未知且词是相对的 = null */
  private absoluteOf(word: string, current: string | null): string | null {
    const text = this.pathForm(word.replaceAll("\u0000", " "));
    if (ABSOLUTE.test(text)) return collapseDots(text);
    if (current === null) return null;
    return collapseDots(`${current}/${text}`);
  }

  /** 非通配、无变量的词 → 绝对路径；其余 null */
  private plainAbsolute(rawWord: string, current: string | null): string | null {
    const word = this.pathForm(rawWord.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "").replaceAll("\u0000", " "));
    if (word === "" || /[$`*?[]/.test(word)) return null;
    return this.absoluteOf(this.trimSlash(word), current);
  }

  relateWord(rawWord: string, current: string | null): Rel {
    // 先折 Windows 写法：`//?/C:/x` 的 `?`、`//h/c$/x` 的 `$` 不是通配与变量
    const word = this.pathForm(rawWord.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "").replaceAll("\u0000", " "));
    if (word === "" || /[$`]/.test(word)) return { kind: "unresolved" };
    const cleaned = this.trimSlash(word);
    const globAt = cleaned.search(/[*?[]/);
    if (globAt !== -1) {
      const slash = cleaned.lastIndexOf("/", globAt);
      const dirPart = slash === -1 ? "" : slash === 0 ? "/" : cleaned.slice(0, slash);
      const rest = cleaned.slice(slash + 1);
      const base = dirPart === "" ? current : this.absoluteOf(dirPart, current);
      if (base === null) return { kind: "unresolved" };
      return this.model.relateGlob(collapseDots(base), rest);
    }
    const abs = this.absoluteOf(cleaned, current);
    if (abs === null) return { kind: "unresolved" };
    return this.model.relateAbsolute(abs);
  }

  /** 内联解释器代码（看不懂）：出现数据目录 / 上级路径 / 记录文件名（非绝对安全路径）就拒 */
  private interpreterRefusal(variantText: string, current: string | null): Refusal {
    // raw 保留 \u0000（引号内空格），词边界按它切；text 是还原空格的副本，两者等长
    const raw = fold(variantText);
    const text = raw.replaceAll("\u0000", " ");
    const home = this.model.home;
    const mentions = (path: string): boolean => mentionsWhole(text, path) || (home !== "" && path.startsWith(`${home}/`) && mentionsWhole(text, path.slice(home.length)));
    for (const dir of this.model.ownDirs) {
      if (mentions(dir)) return this.deny("an inline script touching the data folder");
      for (const ancestor of ancestorsOf(dir)) if (ancestor.length > 1 && mentions(ancestor)) return this.deny("an inline script touching a parent folder of the data folder");
    }
    for (const dir of this.model.foreignDirs) {
      for (const ancestor of [dir, ...ancestorsOf(dir)]) if (ancestor.length > 1 && mentions(ancestor)) return this.deny("an inline script touching a folder that holds automation records");
    }
    for (const entry of this.model.records) {
      let index = text.indexOf(entry.base);
      while (index !== -1) {
        const before = text[index - 1];
        const after = text[index + entry.base.length];
        if ((before === undefined || !/[a-z0-9_-]/.test(before)) && (after === undefined || !/[a-z0-9_-]/.test(after) || after === ".")) {
          // 记录文件名出现在内联代码里：只有写成「绝对路径、且解析后不指向记录与数据目录」才放行，裸名拒（代码可以先 chdir）
          let from = index;
          while (from > 0 && !/[\s,;()[\]{}<>|&]/.test(raw[from - 1] ?? "")) from -= 1;
          let to = index + entry.base.length;
          while (to < raw.length && !/[\s,;()[\]{}<>|&]/.test(raw[to] ?? "")) to += 1;
          const token = text.slice(from, to);
          // 代码里有「路径可能在运行时变」的迹象（chdir、环境变量、拼接……）：这个名字前面可能还拼着别的目录，不信
          if (UNCERTAIN_CODE.test(text)) return { kind: "file", file: entry.file };
          if (!ABSOLUTE.test(token)) {
            // 裸名 / 相对路径：当前目录能确定，才按 当前目录/名字 解析；解析后落在别处放行
            if (current === null) return { kind: "file", file: entry.file };
            const here = this.model.relateAbsolute(collapseDots(`${current}/${token}`));
            if (here.kind === "record" || here.kind === "data" || here.kind === "above") return { kind: "file", file: entry.file };
            index = text.indexOf(entry.base, index + 1);
            continue;
          }
          const rel = this.model.relateAbsolute(collapseDots(token));
          if (rel.kind === "record" || rel.kind === "data" || rel.kind === "above") return { kind: "file", file: entry.file };
        }
        index = text.indexOf(entry.base, index + 1);
      }
    }
    return null;
  }

  /** 一个 variant 过一遍：返回第一个拒绝 */
  judgeVariant(variant: Variant, cwd: string): Refusal {
    const segments = segmentsOf(variant.text);

    // 内联解释器：代码里的路径看不懂，整条按「出现数据目录 / 记录名」判
    const hasHeredoc = /<<(?!<)/.test(variant.text);
    const lang = segments.some((segment) => {
      const { verb, args } = verbOf(parseSegment(segment.text).words);
      return LANG_RUNTIMES.test(verb) && (hasHeredoc || args.some((arg) => /^-[a-z]*[cerEp]$|^--eval$|^--print$/.test(arg) || arg === "-"));
    });
    // 解释器代码在它自己那一段轮到时才判（那时 cd 已经走完，当前目录才是它真正的 cwd）
    const langIndex = lang
      ? segments.findIndex((segment) => {
          const { verb } = verbOf(parseSegment(segment.text).words);
          return LANG_RUNTIMES.test(verb);
        })
      : -1;

    // 第一遍：逐段分析（顺着 cd 更新当前目录）；第二遍：管道与命令替换里「把列出来的名字交给别的命令」
    const state = { current: this.nativeDir(cwd) as string | null };
    const analyses: SegmentAnalysis[] = [];
    for (const [index, segment] of segments.entries()) {
      if (index === langIndex) {
        const refusal = this.interpreterRefusal(variant.text, state.current);
        if (refusal !== null) return refusal;
      }
      const analysis = this.analyzeSegment(segment, variant, state, lang);
      analyses.push(analysis);
      if (analysis.refusal !== null) return analysis.refusal;
    }
    const substTouched = analyses.some((item) => item.inSubst && item.touched);
    let pipelineTouched = false;
    for (const item of analyses) {
      const consumer = item.verb !== "" && !READ_ONLY.has(item.verb) && !FILTERS.has(item.verb) && !NAVIGATION.has(item.verb);
      if (consumer && item.pipeBefore && pipelineTouched) return this.deny("piping a listing of the data folder into another command");
      if (consumer && !item.inSubst && substTouched) return this.deny("feeding a listing of the data folder (command substitution) into another command");
      pipelineTouched = item.pipeBefore ? pipelineTouched || item.touched : item.touched;
    }
    return null;
  }

  /** 一段命令的分析：更新当前目录，返回这一段自己的拒绝（没有就 null）与「碰没碰到数据目录」 */
  private analyzeSegment(segment: Segment, variant: Variant, state: { current: string | null }, lang: boolean): SegmentAnalysis {
    const parsed = parseSegment(segment.text);
    const { verb, args } = verbOf(parsed.words);
    const current = state.current;
    const base = { verb, pipeBefore: segment.pipeBefore, inSubst: segment.inSubst };
    const refuse = (refusal: CommandRefusal): SegmentAnalysis => ({ ...base, touched: true, refusal });
    const recordBases = [...new Set(this.model.records.map((entry) => entry.base))];

    // 变量拼出来的记录文件名（展开前含 `$`）：解析不了，保守拒；检索类命令里单独出现文件名只是在搜字符串
    if (!variant.literal && !isSearchVerb(verb, segment.text)) {
      const lower = fold(segment.text.replaceAll("\u0000", " "));
      for (const entry of this.model.records) {
        if (mentionsName(lower, entry.base)) return refuse({ kind: "file", file: entry.file });
      }
    }

    const rels: WordInfo[] = [];
    const skipPatternArgs = verb === "find";
    for (let i = 0; i < args.length; i += 1) {
      const raw = args[i] ?? "";
      if (raw.startsWith("-") && raw.length > 1) {
        rels.push({ raw, rel: OTHER, abs: null, option: true });
        // `--target-directory=X` 一类 `=` 后面是路径
        const eq = raw.indexOf("=");
        if (raw.startsWith("--") && eq !== -1) rels.push({ raw: raw.slice(eq + 1), rel: this.relateWord(raw.slice(eq + 1), current), abs: this.plainAbsolute(raw.slice(eq + 1), current), option: false });
        // 短选项与取值连写（`-o/路径`、`-ofile`）：路径藏在选项词里，从紧跟字母的位置与每个 `/`、`=` 之后各取一个候选
        if (!raw.startsWith("--") && raw.length > 2) {
          for (const candidate of attachedCandidates(raw)) {
            const rel = this.relateWord(candidate, current);
            if (rel.kind === "data" || rel.kind === "record" || rel.kind === "above") rels.push({ raw: candidate, rel, abs: null, option: false, sub: true });
          }
        }
        if (skipPatternArgs && FIND_PATTERN_ARGS.has(raw)) i += 1;
        continue;
      }
      rels.push({ raw, rel: this.relateWord(raw, current), abs: this.plainAbsolute(raw, current), option: false });
      for (const part of this.subWords(raw)) rels.push({ raw: part, rel: this.relateWord(part, current), abs: null, option: false, sub: true });
    }
    // 命令词本身也可能是路径（`/x/automations.json` 被当成解释器代码里的碎片）
    const verbRel = this.relateWord(parsed.words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? "", current);
    const redirectRels = parsed.redirects.map((redirect) => ({ ...redirect, rel: this.relateWord(redirect.target, current) }));

    // —— 重定向与记录文件：任何命令词都不豁免 ——
    for (const redirect of redirectRels) {
      if (redirect.rel.kind === "record") return refuse(this.denyFile(redirect.rel));
      if (redirect.op === "out" && redirect.rel.kind === "data") return refuse(this.deny("a redirect writing into the data folder"));
      if (redirect.op === "out" && redirect.rel.kind === "unresolved" && !variant.literal && recordBases.some((name) => mentionsName(fold(redirect.target), name))) {
        return refuse({ kind: "file", file: this.scope.files[0] ?? "" });
      }
    }
    for (const info of rels) if (!info.option && info.rel.kind === "record") return refuse(this.denyFile(info.rel));
    if (verbRel.kind === "record") return refuse(this.denyFile(verbRel));

    // —— 导航：cd / pushd 进数据目录拒；其余更新当前目录 ——
    if (NAVIGATION.has(verb)) {
      const cdpathSet = /(?:^|[\s;&|(])(?:export\s+)?CDPATH=/.test(variant.text) || (this.guard.env["CDPATH"] ?? "") !== "";
      const targetWord = args.find((arg) => !arg.startsWith("-") && arg !== "/d");
      if (verb === "popd" || verb === "pop-location") state.current = null;
      else if (targetWord === undefined) state.current = verb === "cd" || verb === "chdir" ? this.nativeDir(this.guard.home) : current;
      else if (targetWord === "-" || /[$`]/.test(targetWord)) state.current = null;
      else if (cdpathSet && !ABSOLUTE.test(targetWord) && !/^\.{1,2}(?:\/|$)/.test(targetWord)) {
        // 设了 CDPATH 的相对 cd 会按 CDPATH 里的目录找，落到哪里我们模拟不了：不猜，按解析不出来拒
        return refuse(this.deny("a relative cd while CDPATH is set (it can land in a folder this check cannot see)"));
      } else {
        const abs = this.absoluteOf(targetWord, current);
        if (abs === null) state.current = null;
        else {
          if (this.model.relateAbsolute(abs).kind === "data") return refuse(this.deny("cd into the data folder"));
          state.current = collapseDots(abs);
        }
      }
      return { ...base, touched: false, refusal: null };
    }

    const currentRel: Rel = current === null ? { kind: "unresolved" } : this.model.relateAbsolute(current);
    const strict = rels.some((info) => !info.option && info.rel.kind === "data") || verbRel.kind === "data" || redirectRels.some((item) => item.rel.kind === "data");
    const cwdInData = currentRel.kind === "data";
    const aboveWords = rels.filter((info) => !info.option && info.rel.kind === "above");

    // 命令词本身解析不了、而当前目录就在数据目录里：看不清它在干什么
    if (cwdInData && /[$`]/.test(parsed.words[0] ?? "")) return refuse(this.deny("an unresolvable command inside the data folder"));
    if (lang && (strict || cwdInData || aboveWords.length > 0)) return refuse(this.deny("an inline script touching the data folder"));

    if (!strict && !cwdInData && aboveWords.length === 0) {
      // 没碰到数据目录。有效当前目录在上级时，隐含「在当前目录里递归」的命令也要看
      if (currentRel.kind === "above") {
        const implicit = this.implicitCwdRefusal(verb, args, rels);
        if (implicit !== null) return refuse(implicit);
      }
      return { ...base, touched: false, refusal: null };
    }

    // —— 碰到了 ——
    const refusal = this.touchingRefusal(verb, args, rels, strict || cwdInData, current, cwdInData);
    return { ...base, touched: true, refusal };
  }

  /** 当前目录是数据目录的上级时，没写路径却默认在当前目录里动手的命令 */
  private implicitCwdRefusal(verb: string, args: readonly string[], rels: readonly WordInfo[]): Refusal {
    if (verb === "git" && args.some((arg) => GIT_CWD_MUTATING.test(arg))) return this.deny("a git command that rewrites the working folder, which holds the data folder");
    if (verb === "find" && args.some((arg) => FIND_MUTATING.test(arg))) {
      const hasRoot = args.length > 0 && !(args[0] ?? "-").startsWith("-") && !(args[0] ?? "").startsWith("(") && args[0] !== "!";
      if (!hasRoot) return this.deny("find with no root, deleting under the folder that holds the data folder");
    }
    if (verb === "tar" && args.some((arg) => /^-?[a-z]*x[a-z]*$|^--extract$|^--get$/.test(arg)) && !rels.some((info) => /^-C$|^--directory/.test(info.raw))) {
      return this.deny("extracting into the folder that holds the data folder");
    }
    if (verb === "unzip" && !args.some((arg) => /^-[a-z]*[ltpvZ][a-z]*$/.test(arg)) && !args.includes("-d")) return this.deny("extracting into the folder that holds the data folder");
    return null;
  }

  /** 碰到数据目录（strict）或它的上级（只有 above）的命令：只读放行，往外拷放行，其余拒 */
  private touchingRefusal(verb: string, args: readonly string[], rels: readonly WordInfo[], strict: boolean, current: string | null, cwdInData: boolean): Refusal {
    const aboveWords = rels.filter((info) => !info.option && info.rel.kind === "above");

    if (verb === "find") return this.findRefusal(args, current, cwdInData);
    if (READ_ONLY.has(verb)) {
      if (verb === "rg" && args.some((arg) => /^--(?:pre|hostname-bin|search-zip)/.test(arg) || arg === "-z")) return this.deny("rg with --pre can run a command");
      return this.readOnlyRoleRefusal(verb, args, current);
    }
    if (COPY_OUT.has(verb)) return this.copyRefusal(verb, args, rels, strict, cwdInData);
    if (MOVERS.has(verb)) return this.moveRefusal(args, rels, strict, cwdInData);
    if (verb === "tar") return this.tarRefusal(args, rels, strict, cwdInData);
    if (verb === "unzip") return this.unzipRefusal(args, rels, strict, cwdInData);
    if (cwdInData) return this.deny(`"${verb}" inside the data folder (only read-only commands are allowed there)`);
    if (strict) return this.deny(`"${verb}" touching the data folder (only read-only commands may)`);
    return this.deny(`"${verb}" aimed at a folder that holds the data folder or automation records`);
  }

  /**
   * find：起点（命令词后面第一个表达式之前的词）是输入。带 -delete / -exec / -ok / -fprint* / -fls / -fprintf 的：起点碰到数据目录或上级拒；
   * 另外这些动作后面出现的、落在数据目录里的词（`-fls D/x`、`-exec cp {} D \;`）是输出 / 命令参数，拒。
   * 不带这些动作的 find 只读：起点与 `-newer` 之类的取值都是输入，放行。
   */
  private findRefusal(args: readonly string[], current: string | null, cwdInData: boolean): Refusal {
    const firstAction = args.findIndex((arg) => FIND_MUTATING.test(arg));
    if (firstAction === -1) return null;
    const roots = findRoots(args);
    const rootRels = roots.length === 0 ? [current === null ? ({ kind: "unresolved" } as Rel) : this.model.relateAbsolute(current)] : roots.map((root) => this.relateWord(root, current));
    if (rootRels.some((rel) => rel.kind === "data" || rel.kind === "above" || rel.kind === "record" || rel.kind === "unresolved") || cwdInData) {
      return this.deny("find with -delete / -exec / -ok / -fprint over the data folder or a folder above it");
    }
    for (const word of args.slice(firstAction)) {
      if (word.startsWith("-") && word.length > 1) {
        const eq = word.indexOf("=");
        if (eq !== -1 && this.touchesData(word.slice(eq + 1), current)) return this.deny("find writing or running something on the data folder");
        continue;
      }
      if (this.touchesData(word, current)) return this.deny("find with an action whose output or command line names the data folder");
    }
    return null;
  }

  private touchesData(text: string, current: string | null): boolean {
    const kind = this.relateWord(text, current).kind;
    if (kind === "data" || kind === "record") return true;
    return attachedCandidates(`-x${text}`).some((candidate) => {
      const rel = this.relateWord(candidate, current).kind;
      return rel === "data" || rel === "record";
    });
  }

  /**
   * 只读白名单命令的参数角色检查（见 OPTION_SPECS）：数据目录里的词只能是输入操作数，或已知「只带输入」的选项的取值；
   * 别的选项的取值位置、含不认识的选项的命令里出现数据目录路径，一律拒。
   */
  private readOnlyRoleRefusal(verb: string, args: readonly string[], current: string | null): Refusal {
    const spec = OPTION_SPECS[verb];
    if (spec === undefined) return null;
    const bad = (text: string): boolean => this.touchesData(text, current);
    const deny = (): CommandRefusal => this.deny(`"${verb}" with an option that may write to or run something on the data folder (only known read-only options are trusted there)`);
    const operands: string[] = [];
    const inputValues: string[] = [];
    let unknownOption = false;
    let endOfOptions = false;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i] ?? "";
      if (!endOfOptions && arg === "--") {
        endOfOptions = true;
        continue;
      }
      if (endOfOptions || !arg.startsWith("-") || arg === "-") {
        operands.push(arg);
        continue;
      }
      if (arg.startsWith("--")) {
        const eq = arg.indexOf("=");
        const name = arg.slice(2, eq === -1 ? undefined : eq);
        const attached = eq === -1 ? undefined : arg.slice(eq + 1);
        const nextValue = (): string | undefined => (attached !== undefined ? attached : args[++i]);
        if (spec.longFlags.includes(name)) {
          if (attached !== undefined && bad(attached)) return deny();
        } else if (spec.longInput.includes(name)) {
          const value = nextValue();
          if (value !== undefined) inputValues.push(value);
        } else if (spec.longOther.includes(name)) {
          const value = nextValue();
          if (value !== undefined && bad(value)) return deny();
        } else {
          unknownOption = true;
          if (attached !== undefined && bad(attached)) return deny();
        }
        continue;
      }
      const bundle = arg.slice(1);
      if (/^\d+$/.test(bundle)) continue;
      for (let j = 0; j < bundle.length; j += 1) {
        const letter = bundle[j] ?? "";
        const rest = bundle.slice(j + 1);
        if (spec.flags.includes(letter)) continue;
        if (spec.input.includes(letter)) {
          const value = rest !== "" ? rest : args[++i];
          if (value !== undefined) inputValues.push(value);
          break;
        }
        if (spec.other.includes(letter)) {
          const value = rest !== "" ? rest : args[++i];
          if (value !== undefined && bad(value)) return deny();
          break;
        }
        unknownOption = true;
        if (rest !== "" && bad(rest)) return deny();
        break;
      }
    }
    if (unknownOption && [...operands, ...inputValues].some((operand) => bad(operand))) return deny();
    return null;
  }

  /** cp / rsync / ditto / install：以数据目录为**源**往外拷放行；目标落进数据目录 / 上级里同名子项拒 */
  private copyRefusal(verb: string, args: readonly string[], rels: readonly WordInfo[], strict: boolean, cwdInData: boolean): Refusal {
    if (cwdInData) return this.deny(`"${verb}" inside the data folder (only read-only commands are allowed there)`);
    if (verb === "install" && args.some((arg) => /^-[a-zA-Z]*d[a-zA-Z]*$/.test(arg))) return this.deny("install -d creates folders in the data folder");
    if (verb === "rsync" && args.some((arg) => /^--remove-(?:source|sent)-files$/.test(arg))) return this.deny("rsync --remove-source-files removes the sources");
    const optionArgs = new Set(OPTION_WITH_ARG[verb] ?? []);
    const operands: WordInfo[] = [];
    let targetDir: WordInfo | null = null;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i] ?? "";
      const lower = arg.toLowerCase();
      if (arg.startsWith("-") && arg.length > 1) {
        if (/^(?:-t|--target-directory|-destination)$/i.test(arg)) {
          const next = args[i + 1];
          if (next !== undefined) targetDir = rels.find((info) => info.raw === next && !info.option && !info.sub) ?? null;
          i += 1;
        } else if (optionArgs.has(lower) || optionArgs.has(arg)) i += 1;
        else if (/^--target-directory=/.test(arg)) targetDir = rels.find((info) => info.raw === arg.slice(arg.indexOf("=") + 1) && !info.option && !info.sub) ?? null;
        continue;
      }
      const info = rels.find((item) => !item.option && !item.sub && item.raw === arg && !operands.includes(item));
      if (info !== undefined) operands.push(info);
    }
    const dest = targetDir ?? (operands.length >= 2 ? (operands[operands.length - 1] ?? null) : null);
    const sources = targetDir !== null ? operands : operands.slice(0, Math.max(operands.length - 1, 0));
    if (dest === null) return this.deny(`"${verb}" with no clear destination touching the data folder`);
    // 目标要能确定解析，且不在数据目录 / 记录里
    if (dest.rel.kind === "data" || dest.rel.kind === "record") return this.deny(`"${verb}" with the data folder as the destination (overwrites it)`);
    if (dest.rel.kind === "unresolved") return this.deny(`"${verb}" with an unresolvable destination while touching the data folder`);
    // 数据目录只能出现在来源位置
    for (const info of rels) {
      if (info.option || (info.rel.kind !== "data" && info.rel.kind !== "above")) continue;
      if (info === dest) continue;
      if (!sources.includes(info)) return this.deny(`"${verb}" with the data folder in a role other than a source`);
    }
    if (dest.rel.kind === "above") {
      const conflict = this.aboveDestConflict(dest, sources);
      if (conflict !== null) return conflict;
    }
    return null;
  }

  /** 目标是数据目录（或记录所在目录）的上级：来源里有同名子项（或看不清的通配 / 目录内容合并）就会覆盖进去 */
  private aboveDestConflict(dest: WordInfo, sources: readonly WordInfo[]): Refusal {
    // 目标目录之下「通往数据目录 / 记录」的下一级名字
    const children = new Set<string>();
    const destFolded = dest.abs === null ? null : fold(dest.abs);
    if (destFolded === null) return this.deny("a copy into a folder above the data folder with an unresolvable destination");
    for (const dir of [...this.model.ownDirs, ...this.model.foreignDirs]) {
      const below = componentsBelow(destFolded, dir);
      if (below !== null && below.length > 0) children.add(below[0] ?? "");
      if (below !== null && below.length === 0 && this.model.foreignDirs.includes(dir)) for (const entry of this.model.records) if (entry.dir === dir) children.add(entry.base);
    }
    for (const source of sources) {
      const raw = source.raw.replaceAll("\u0000", " ");
      if (/[$`]/.test(raw)) return this.deny("a copy into a folder above the data folder from an unresolvable source");
      // 以 `/` 或 `/.` 结尾 = 拷内容进来，内容里有什么看不清
      if (/\/\.?$/.test(raw)) return this.deny("a copy of folder contents into a folder above the data folder");
      const name = fold(raw.slice(raw.lastIndexOf("/") + 1));
      if (/[*?[]/.test(name)) {
        const regex = globToRegExp(name);
        if ([...children].some((child) => regex.test(child))) return this.deny("a glob copy that can overwrite the data folder");
      } else if (children.has(name)) return this.deny("a copy named like the data folder into its parent folder");
    }
    return null;
  }

  /** mv：来源会被移走，数据目录以任何角色出现都拒；目标是上级时同样查同名子项 */
  private moveRefusal(args: readonly string[], rels: readonly WordInfo[], strict: boolean, cwdInData: boolean): Refusal {
    if (cwdInData || strict) return this.deny("mv touching the data folder (moves the data out, or overwrites it)");
    const operands = rels.filter((info) => !info.option && !info.sub);
    void args;
    const dest = operands[operands.length - 1];
    const sources = operands.slice(0, -1);
    for (const info of operands) if (info !== dest && info.rel.kind === "above") return this.deny("mv of a folder that holds the data folder");
    if (dest !== undefined && dest.rel.kind === "above") return this.aboveDestConflict(dest, sources);
    return null;
  }

  /** tar：-c 以数据目录为源往外打包放行；-t 只读；解包到数据目录 / 上级、或数据目录里的 --remove-files 拒 */
  private tarRefusal(args: readonly string[], rels: readonly WordInfo[], strict: boolean, cwdInData: boolean): Refusal {
    if (cwdInData) return this.deny("tar inside the data folder");
    const first = args.find((arg) => arg !== "") ?? "";
    const flags = args.filter((arg) => arg.startsWith("--")).join(" ");
    const letters = first.startsWith("--") ? "" : first.replace(/^-/, "");
    const create = /c/.test(letters) || /--create/.test(flags);
    const list = /t/.test(letters) || /--list/.test(flags);
    const extract = /x/.test(letters) || /--(?:extract|get)/.test(flags);
    if (/--remove-files/.test(flags)) return this.deny("tar --remove-files deletes the sources");
    if (list && !create && !extract) return null;
    // -f 的归档文件与 -C 的目录
    let archive: WordInfo | null = null;
    let dir: WordInfo | null = null;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i] ?? "";
      const next = args[i + 1];
      if (next === undefined) continue;
      // 打包写法 `czf X` / `-czf X`（第一个参数里带 f）、`-f X`、`--file X`
      const bundled = i === 0 && !arg.startsWith("--") && /^-?[a-zA-Z]+$/.test(arg) && arg.includes("f");
      if (bundled || /^-[a-zA-Z]*f$/.test(arg) || arg === "--file") archive = rels.find((info) => info.raw === next && !info.option && !info.sub) ?? archive;
      if (arg === "-C" || arg === "--directory") dir = rels.find((info) => info.raw === next && !info.option && !info.sub) ?? dir;
    }
    const attached = args.find((arg) => /^--file=/.test(arg));
    if (attached !== undefined) archive = rels.find((info) => info.raw === attached.slice(attached.indexOf("=") + 1) && !info.option && !info.sub) ?? archive;
    if (create && !extract) {
      if (archive !== null && (archive.rel.kind === "data" || archive.rel.kind === "record" || archive.rel.kind === "above" || archive.rel.kind === "unresolved")) {
        return this.deny("tar writing its archive into the data folder");
      }
      if (archive === null) return this.deny("tar -c without a clear archive file while touching the data folder");
      return null;
    }
    // 解包 / 追加 / 更新：目的地（-C 或当前目录）不许是数据目录或其上级
    if (dir !== null && (dir.rel.kind === "data" || dir.rel.kind === "above" || dir.rel.kind === "record")) return this.deny("tar extracting into the data folder");
    if (dir === null && strict && !extract) return this.deny("tar touching the data folder");
    if (extract && dir !== null && dir.rel.kind === "other" && !rels.some((info) => !info.option && info !== dir && info !== archive && info.rel.kind === "data")) return null;
    if (extract && dir !== null && dir.rel.kind === "wb") return null;
    return this.deny("tar touching the data folder (only creating an archive from it is allowed)");
  }

  private unzipRefusal(args: readonly string[], rels: readonly WordInfo[], strict: boolean, cwdInData: boolean): Refusal {
    if (cwdInData) return this.deny("unzip inside the data folder");
    if (args.some((arg) => /^-[a-zA-Z]*[ltpvZ][a-zA-Z]*$/.test(arg))) return null;
    const index = args.indexOf("-d");
    const next = index === -1 ? undefined : args[index + 1];
    const dest = next === undefined ? null : (rels.find((info) => info.raw === next && !info.option && !info.sub) ?? null);
    if (dest !== null && (dest.rel.kind === "other" || dest.rel.kind === "wb")) {
      const others = rels.filter((info) => !info.option && info !== dest && (info.rel.kind === "data" || info.rel.kind === "above"));
      return others.every((info) => /\.zip$/i.test(info.raw)) ? null : this.deny("unzip touching the data folder");
    }
    return this.deny(strict ? "unzip extracting into the data folder" : "unzip extracting into a folder that holds the data folder");
  }
}

function humanDir(dir: string): string {
  return dir.replaceAll("\u0000", " ");
}

/** 短选项与取值连写时，取值可能从哪里开始：紧跟选项字母的位置、每个 `/` 与 `=` 之后（`-o/a/b`、`-ofile`、`-x=/a`） */
function attachedCandidates(option: string): string[] {
  const out = new Set<string>();
  const body = option.slice(2);
  if (body !== "") out.add(body.replace(/^=/, ""));
  for (let i = 2; i < option.length; i += 1) {
    const ch = option[i];
    if (ch === "/" || ch === "=") out.add(option.slice(ch === "=" ? i + 1 : i));
  }
  return [...out].filter((candidate) => candidate !== "");
}

/** find 的起点：命令词后面、第一个表达式之前的词 */
function findRoots(args: readonly string[]): string[] {
  const roots: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-") || arg === "(" || arg === "!" || arg === ",") break;
    roots.push(arg);
  }
  return roots;
}

/** 检索类命令里单独出现文件名只是在搜字符串（`git grep automations.json`、`grep -rn … src`） */
function isSearchVerb(verb: string, segment: string): boolean {
  if (verb === "grep" || verb === "egrep" || verb === "fgrep" || verb === "rg" || verb === "ag" || verb === "ack") return true;
  if (verb === "git") return /\b(?:grep|log|show|diff|blame|ls-files|status)\b/.test(segment);
  if (verb === "find") return !/(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprint0?|fls|fprintf)(?:\s|$)/.test(segment);
  return false;
}

/** 文件名在一段命令里出现，前后都落在名字边界上（`automations.json.bad-1` 是兄弟，`xautomations.json`、`automations.jsonx` 是别的文件） */
function mentionsName(segment: string, base: string): boolean {
  let index = segment.indexOf(base);
  while (index !== -1) {
    const before = segment[index - 1];
    const after = segment[index + base.length];
    if ((before === undefined || !/[a-z0-9_-]/.test(before)) && (after === undefined || !/[a-z0-9_-]/.test(after))) return true;
    index = segment.indexOf(base, index + 1);
  }
  return false;
}

/**
 * `path` 作为**整条路径**（而不是某个子路径的前缀）出现在 `text` 里：后面是结尾 / 空白 / 引号 / 分隔符 / 通配，
 * 或者 `/`（再接结尾 / 空白 / 通配 / `.`）。`<目录>/workbenches/x` 是子路径，不算。
 */
function mentionsWhole(text: string, path: string): boolean {
  const body = escapeRegExp(path);
  const pattern = new RegExp(`${body}(?:/+(?:\\.{1,2}(?:/|(?=$|[\\s;&|)"'*?\\[,\\]+<>])))*)?(?=$|[\\s;&|)"'*?\\[,\\]+<>])`, "g");
  for (const match of text.matchAll(pattern)) {
    const before = text[match.index - 1];
    // 前面紧挨着路径字符 = 别的更长的路径的一段（`/xx/Users/...`）
    if (before !== undefined && /[a-z0-9_.-]/.test(before) && !path.startsWith("/")) continue;
    return true;
  }
  return false;
}

/* ---------- 入口 ---------- */

/**
 * 命令串对「受保护记录 + 本实例数据目录」的判定。
 * @param command 原样命令串
 * @param scope 受保护的记录文件与本实例的数据目录
 * @param cwd 这条命令开始时的工作目录（模拟 cd 用）
 */
export function protectedCommandRefusal(
  command: string,
  scope: CommandScope,
  cwd: string,
  guard: CommandGuardEnv = defaultGuardEnv(),
): CommandRefusal | null {
  if (scope.files.length === 0) return null;
  const model = new Model(scope, guard);
  

  // 「解码后执行」：base64 -d | sh、printf '\x72\x6d' | sh——名字在运行时才拼出来，字面上什么都看不见；
  // 正常命令里几乎没有「把解码结果交给 shell 执行」，所以整条拒。在原始命令串上比（折叠会改掉反斜杠）
  if (
    /(?:base64\s+(?:-d|-D|--decode)|xxd\s+-r|openssl\s+(?:enc|base64)\b.*-d|printf\s+['"]?[^|]*\\x[0-9a-fA-F]{2}|echo\s+-e\s+['"]?[^|]*\\x[0-9a-fA-F]{2})/.test(command) &&
    /(?:\|\s*(?:ba|z|da|k)?sh\b|(?:^|[\s;&|(])eval\b|(?:^|\s)(?:ba|z|da|k)?sh\s+-c\b|\bsource\s+<\(|\bpython[0-9.]*\s+-c\b|\bnode\s+-e\b)/.test(command)
  ) {
    return { kind: "dataDir", dir: humanDir(scope.ownDirs[0] ?? parentDirOf(scope.files[0] ?? "")), why: "running decoded text as a command" };
  }

  // 含空格的已知路径（数据目录、记录文件及其上级）：代码引号串里要靠它们认出路径边界
  const knownSpacePaths = new Set<string>();
  for (const start of [...scope.ownDirs, ...scope.files]) {
    for (let current = start; current !== dirname(current); current = dirname(current)) if (current.includes(" ")) knownSpacePaths.add(current);
  }
  const known = [...knownSpacePaths].sort((a, b) => b.length - a.length);
  const judge = new Judge(model, scope, guard, known);
  for (const variant of normalizeVariants(command, guard, known)) {
    const refusal = judge.judgeVariant(variant, cwd);
    if (refusal !== null) return refusal;
  }
  return null;
}

function parentDirOf(file: string): string {
  return dirname(file);
}

/**
 * 被拒的命令碰的是数据目录里的什么（调用方按命令串里出现的受保护路径判，见 permission.ts 的 touchedSubject）：
 * 会话库目录 / 会话账本 / 自动化记录 / 说不出具体哪个（cd 进去、相对路径、上级目录）。
 */
export type DataDirSubject = "database" | "sessions" | "automation" | "dataFolder";

const DATA_DIR_SUBJECT: Readonly<Record<DataDirSubject, { lead: (dir: string) => string; read: string }>> = {
  automation: {
    lead: (dir) => `Automation records are immutable, and they live in Orbita's data folder "${dir}". `,
    read: "To read automation records use the read tool or automation_list (not the shell). ",
  },
  sessions: {
    lead: (dir) => `Session records are immutable, and they live in Orbita's data folder "${dir}". `,
    read: "To read session records use the read tool, or read_task for a task's transcript (not the shell). ",
  },
  database: {
    lead: (dir) => `The session database is immutable, and it lives in Orbita's data folder "${dir}". `,
    read: "To read a task's history use read_task (not the shell). ",
  },
  dataFolder: {
    lead: (dir) => `Orbita's data folder "${dir}" holds session records, the session database and automation records, all immutable. `,
    read: "To read them use the read tool or automation_list, or read_task for a task's transcript (not the shell). ",
  },
};

/** 给模型的拒绝理由（数据目录一类）：按碰到的是什么说；改道说清——读用哪个工具，工作台照常能用 */
export function dataDirRefusalMessage(refusal: Extract<CommandRefusal, { kind: "dataDir" }>, subject: DataDirSubject): string {
  const words = DATA_DIR_SUBJECT[subject];
  return (
    words.lead(refusal.dir) +
    `This shell command was refused (${refusal.why}): a command that touches that folder ` +
    "(or cd's into it, or renames / deletes / chmods it or any folder above it) is allowed only when it is read-only — " +
    "ls, stat, du, file, wc, head, tail, cat, grep / rg, find without -delete or -exec, diff — or when it only copies out of it. " +
    words.read +
    `Your session workbench inside it ("${refusal.dir}/workbenches/<session>") is still yours — use absolute paths there.`
  );
}
