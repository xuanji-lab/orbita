/**
 * 自动化记录的命令串禁区（bash / powershell）。
 *
 * 背景（2026-11-14 独立验收）：只比对「受保护文件的绝对路径字面量」拦不住智能体最自然的写法——
 * `cd <数据目录> && rm automations.json`、`find <数据目录> -name 'automations*' -delete`、
 * `rm "$HOME/…/automations.json"`、`ln -s` 之后用 write 写链接、`mv <数据目录> <别名>`。
 * 这些命令串里根本没有那个绝对路径。所以这里在字面量之外再加一层，按**命令串里能看见的东西**拦：
 *
 *   1. 受保护文件的**文件名本身**（含 `.tmp` / `.bad-` 兄弟，含 `automations*`、`<数据目录>/*.json`
 *      这类能匹配到它们的通配）——不管前面是 cd、find -name、变量拼接还是花括号展开；
 *   2. 环境变量、命令里写的 `NAME=值` 赋值、花括号 `{a,b}`、`$'\xNN'`、拼接的引号先展开再比：
 *      `$HOME` / `${HOME}` / `~` / `$TMPDIR` / `%APPDATA%` / `$env:APPDATA`；
 *   3. `cd` / `pushd` / `Set-Location` 进到「直接装着受保护文件的目录」（数据目录根）——
 *      顺着命令里的 cd 一步步模拟（含相对路径与分步 cd），进到会话工作台
 *      （`<数据目录>/workbenches/<id>`）不算；
 *   4. 数据目录本身或它任何上级目录作为目标的破坏性操作（mv / rm / chmod / find -delete / rsync --delete / …）；
 *   5. 「解码后执行」（`base64 -d | sh`）与内联解释器（`python -c` / `node -e`）里点到数据目录。
 *
 * **拦截力度如实说**：这仍是对命令串的启发式匹配，不是沙箱。拦得住常规写法与几十种变形，
 * 拦不住「名字在运行时才拼出来」（`$(…)` 命令替换产出名字、脚本文件里写好再 `bash x.sh`、
 * 从别的文件读出名字）。真正密封要靠操作系统级沙箱（另一件事）；主进程的自愈兜底
 * （automation/guard.ts）负责让「拦不住的」也不会无声消失。
 *
 * **不误伤**：`git grep automations`、读写会话工作台、`ls ~/Library`、在项目目录里 `find . -delete`
 * 都放行；纯检索类命令（grep / rg / git grep / 不带删除的 find）里单独出现文件名只是在搜字符串，放行。
 * 完整路径字面量（原有规则）不在这里，仍然一律拦。
 */
import { homedir } from "node:os";

export interface CommandGuardEnv {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}

export function defaultGuardEnv(): CommandGuardEnv {
  return { home: homedir(), env: process.env };
}

/* ---------- 规整 ---------- */

/** `$'\x61…'` ANSI-C 引号：解成明文（只处理 \xHH、\NNN 八进制、\uHHHH 与常见单字符转义） */
function decodeAnsiC(command: string): string {
  return command.replaceAll(/\$'((?:[^'\\]|\\.)*)'/g, (_whole: string, body: string) =>
    body.replaceAll(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|u[0-9a-fA-F]{4}|.)/g, (_m: string, esc: string) => {
      if (esc[0] === "x" && esc.length > 1) return String.fromCharCode(parseInt(esc.slice(1), 16));
      if (esc[0] === "u" && esc.length === 5) return String.fromCharCode(parseInt(esc.slice(1), 16));
      if (/^[0-7]+$/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
      if (esc === "n") return "\n";
      if (esc === "t") return "\t";
      return esc;
    }),
  );
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
    const fromEnv = guard.env[name] ?? guard.env[name.toUpperCase()];
    return fromEnv;
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

/** 参数位置的 `~` 展开成家目录（与 permission.ts 原来的规则一致，另外认行首与 `cd ~`） */
function expandTilde(text: string, home: string): string {
  return text.replaceAll(/(^|[\s"'=;&|()><])~(?=\/|\\|\s|$)/g, (_m: string, lead: string) => lead + home);
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

/** 路径折叠：小写（macOS APFS / Windows NTFS 默认不分大小写）、反斜杠转正斜杠、收拢连续斜杠与 `/./` */
export function foldCmdPath(value: string): string {
  return value.replaceAll("\\", "/").replaceAll(/\/{2,}/g, "/").replaceAll(/\/\.(?=\/|$)/g, "").toLowerCase();
}

/** 把路径里的 `.` / `..` 折掉（纯字符串，不碰文件系统）；输入已经 foldCmdPath */
function collapseDots(path: string): string {
  const drive = /^[a-z]:/.exec(path)?.[0] ?? "";
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

interface Normalized {
  /** 路径比对用：反斜杠当分隔符 */
  path: string;
  /** 文件名比对用：反斜杠当转义直接删（`au\tomations`） */
  name: string;
  /** 展开前不含 `$` 与反引号：命令里的路径都是字面量，可以拿去解析（同名文件误伤收窄的前提）。
 *   含变量的（`$D/automations.json`、`rm $a$b`）解析不出名字到底指哪——保守，维持一律拒 */
  literal: boolean;
}

/**
 * 引号内的空格与转义空格编码成 \`\u0000\`：路径可以含空格（"Application Support"），
 * 引号折平后那些空格不能变成词边界——否则数据目录里的受保护路径会被拆成两个词，
 * 「解析后放行」的判定（同名文件误伤收窄）就认不出它了。所有参与比对的路径同样编码。
 */
function encodeQuotedSpaces(text: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (quote === null) {
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "\\" && text[i + 1] === " ") {
        out += "\u0000";
        i += 1;
      } else out += ch;
    } else {
      if (ch === quote) quote = null;
      else if (ch === " ") out += "\u0000";
      else out += ch;
    }
  }
  return out;
}

function normalizeVariants(command: string, guard: CommandGuardEnv): Normalized[] {
  const decoded = decodeAnsiC(command);
  const literal = !/[$`]/.test(decoded);
  const vars = parseAssignments(decoded);
  const expanded = encodeQuotedSpaces(expandTilde(expandVars(decoded, vars, guard), guard.home));
  // 引号折平：相邻引号段拼成一个词；引号内 / 转义的空格已编码成 \u0000，不再是词边界
  const loosened = expanded.replaceAll(/["']/g, "");
  const variants: Normalized[] = [];
  for (const brace of expandBraces(loosened)) {
    variants.push({ path: foldCmdPath(brace), name: brace.replaceAll("\\", "").replaceAll(/\/{2,}/g, "/").toLowerCase(), literal });
  }
  return variants;
}

/* ---------- 路径关系 ---------- */

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "" : path.slice(0, index);
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** 这条路径的所有上级（不含自己、不含根）：`/a/b/c` → [`/a/b`, `/a`] */
function ancestorsOf(path: string): string[] {
  const out: string[] = [];
  let current = parentOf(path);
  while (current !== "" && current !== "/" && !/^[a-z]:$/.test(current)) {
    out.push(current);
    current = parentOf(current);
  }
  return out;
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

/** 同上，但路径是 `~` 之后的相对家目录写法时（运行时才拼 HOME），拿「去掉家目录前缀的尾部」再试一遍 */
function mentionsWholeOrHomeRelative(text: string, path: string, home: string): boolean {
  if (mentionsWhole(text, path)) return true;
  if (home !== "" && path.startsWith(`${home}/`)) return mentionsWhole(text, path.slice(home.length));
  return false;
}

/* ---------- 命令切段 ---------- */

/** 按 `;` `&&` `||` `|` `&` 换行与括号切成「一条条命令」；子进程替换里的也各算一段 */
function segmentsOf(text: string): string[] {
  return text
    .split(/\n|;|&&|\|\||\||&|<<<|\$\(|\(|\)|`|\{|\}/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

const SEARCH_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);
const GIT_READ_SUBCOMMANDS = new Set(["grep", "log", "show", "diff", "blame", "ls-files", "status"]);

/** 取一段命令的首个命令词（跳过 `VAR=x` 赋值、sudo / time / command / env） */
function firstWords(segment: string): string[] {
  const words = segment.split(/\s+/).filter((word) => word !== "");
  let index = 0;
  while (index < words.length) {
    const word = words[index] ?? "";
    if (/^[a-z_][a-z0-9_]*=/.test(word) || ["sudo", "time", "command", "env", "nohup", "exec", "builtin"].includes(word)) index += 1;
    else break;
  }
  return words.slice(index);
}

/**
 * 纯检索类命令：grep / rg / git grep（log / show / diff…）与不带删除 / 执行动作的 find。
 * 它们里面单独出现受保护文件的**名字**只是在搜字符串（比如在 Orbita 自己的源码里 `git grep automations.json`），放行；
 * 完整路径字面量照旧一律拦。
 */
function isSearchSegment(segment: string): boolean {
  if (/\$\(|`/.test(segment)) return false;
  const words = firstWords(segment);
  const head = words[0];
  if (head === undefined) return false;
  if (SEARCH_COMMANDS.has(head)) return true;
  if (head === "git" && words.slice(1).some((word) => GIT_READ_SUBCOMMANDS.has(word))) return true;
  if (head === "find") return !/(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprint0?|fls|fprintf)(?:\s|$)/.test(segment);
  return false;
}

/* ---------- 通配 ---------- */

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

/** 通配词里「第一个通配符之前」的字面前缀 */
function literalPrefix(glob: string): string {
  const index = glob.search(/[*?[]/);
  return index === -1 ? glob : glob.slice(0, index);
}

/* ---------- 破坏性动词 ---------- */

const DESTRUCTIVE_WORDS =
  /(?:^|[\s;&|(`])(?:rm|rmdir|unlink|shred|truncate|mv|chmod|chown|chgrp|chattr|chflags|ln|dd|del|erase|rd|move|ren|rename|remove-item|move-item|rename-item|clear-content|set-content|out-file|install|ditto|trash|rmtrash|gio|osascript)(?=$|[\s;&|)])/;

function hasDestructiveVerb(segment: string): boolean {
  if (DESTRUCTIVE_WORDS.test(segment)) return true;
  if (/(?:^|[\s;&|(`])find(?=\s)/.test(segment) && /(?:^|\s)-(?:delete|exec|execdir|ok|okdir)(?:\s|$)/.test(segment)) return true;
  if (/(?:^|[\s;&|(`])rsync(?=\s)/.test(segment) && /--(?:delete|remove-source-files|del)\b/.test(segment)) return true;
  if (/(?:^|[\s;&|(`])git(?=\s)/.test(segment) && /\b(?:clean|reset|checkout|restore|rm|stash|gc|prune)\b/.test(segment)) return true;
  if (/(?:^|[\s;&|(`])(?:tar|unzip|7z|7za|cpio|pax)(?=\s)/.test(segment)) return true;
  return false;
}

/**
 * 通配路径（目录部分也带通配）能不能匹配到数据目录本身或某个受保护文件：
 * `…/Application Support/orbita*` 、`…/orbita-dev-x/auto*`。通配词从「数据目录的某个上级」起头、里面含通配符。
 */
function globPathHitsData(text: string, dataDirs: readonly string[], filePaths: readonly string[], home: string): boolean {
  const targets = [...dataDirs, ...filePaths];
  for (const dir of dataDirs) {
    for (const ancestor of [dir, ...ancestorsOf(dir)]) {
      for (const root of [ancestor, ...(home !== "" && ancestor.startsWith(`${home}/`) ? [ancestor.slice(home.length)] : [])]) {
        const pattern = new RegExp(`${escapeRegExp(root)}/+([^\\s;&|)"']*[*?\\[][^\\s;&|)"']*)`, "g");
        for (const match of text.matchAll(pattern)) {
          const regex = globToRegExp(`${root}/${match[1] ?? ""}`.replaceAll(/\/+$/g, ""));
          if (targets.some((target) => regex.test(target) || regex.test(target.slice(home.length)))) return true;
        }
      }
    }
  }
  return false;
}

/** mv / ln 只有**来源**会被改动：目标路径出现在最后一个参数位置（命令串末尾）不算 */
function onlyAsDestination(segment: string, path: string): boolean {
  const head = firstWords(segment)[0];
  if (head !== "mv" && head !== "ln" && head !== "move" && head !== "cp" && head !== "copy" && head !== "install") return false;
  const trimmed = segment.replace(/[\s/]+$/, "");
  return trimmed.endsWith(path) && trimmed.indexOf(path) === trimmed.length - path.length;
}

/** 目标 token 是不是这个破坏性命令的**最后一个参数**（mv / cp 这类只有来源会被改动；相对名与绝对路径都判） */
function tokenIsDestination(segment: string, word: string): boolean {
  const head = firstWords(segment)[0];
  if (head !== "mv" && head !== "ln" && head !== "move" && head !== "cp" && head !== "copy" && head !== "install") return false;
  const trimmed = segment.replace(/[\s/]+$/, "");
  const bare = word.replace(/\/+$/, "");
  // lastIndexOf：短名（data）可能先出现在别的参数里（mv data2 data），目标只看最后一处
  return trimmed.endsWith(bare) && trimmed.lastIndexOf(bare) === trimmed.length - bare.length;
}

/* ---------- cd 跟踪与相对名解析（主会话 2026-11-14 实测漏网后补） ---------- */

/** cd / pushd 目标里的重定向（`>/dev/null`、`2>&1`、`&>`、`<`）不是目标的一部分，剥掉再解析 */
function stripRedirects(target: string): string {
  return target
    .split(/\s+/)
    .filter((word) => !/^(?:\d*&?>+|>&|&>|>+|<)/.test(word))
    .join(" ");
}

/** token 里的赋值前缀（dd 的 `of=`、`VAR=`）与重定向前缀（`2>file`）剥掉 */
function cleanToken(word: string): string {
  return word.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "").replace(/^(?:\d*&?>+|>&|&>|>+|<)+/, "");
}

/** 是不是「能确定解析」的字面路径 token：无通配、无变量、无 shell 元字符（输入已折叠小写） */
function isLiteralPathToken(word: string): boolean {
  return word !== "" && !/[*?[\]()'";$`]/.test(word);
}

/** token 解析成绝对路径（输入已折叠；相对的按当前目录拼，`..` 折叠掉）。返回 null = 解析不了 */
function resolveToken(word: string, current: string): string | null {
  if (/^(?:\/|[a-z]:)/.test(word)) return collapseDots(word);
  return collapseDots(`${current}/${word}`);
}

/**
 * 「内容会被当成命令再执行」的宿主：内联解释器（python -c / node -e …）、`sh -c`、here-string（`<<<`）、eval。
 * 它们的内容在引号里，里面的 `cd 数据目录` 空格被编码后 cd 跟踪看不见——内容闸门看不清（可先 chdir 再删），
 * 文件名命中一律保守拒，不做「解析安全」放行。
 */
function isInterpreterSegment(segment: string): boolean {
  if (segment.includes("<<<")) return true;
  return (
    /(?:^|[\s;&|(])(?:python[0-9.]*|node|bun|deno|perl|ruby|php|lua)\s+(?:--?[a-z]*[ce]\b|--?r\b|--?eval\b|--?e\b)/.test(segment) ||
    /(?:^|[\s;&|(])(?:ba|z|da|k)?sh\s+-c\b/.test(segment) ||
    /(?:^|[\s;&|(])eval\b/.test(segment)
  );
}

/**
 * 字面量 variant 里，文件名在一段里的每处出现是不是都能确定解析且**不**指向受保护文件 / 本实例的数据目录
 * ——能（删的是项目里 / 别的实例里的同名文件）就放行；解析不了或命中就保守拒。
 * 主会话 2026-11-14：用户用 Orbita 开发 Orbita，智能体常要造 / 清开发实例的数据，同名文件不能一刀切拦。
 */
function nameHitResolvesSafe(
  segment: string,
  entry: { path: string; base: string },
  current: string,
  dataDirs: readonly string[],
): boolean {
  let at = segment.indexOf(entry.base);
  while (at !== -1) {
    // 这一处出现所在的「词」：向两侧扩到空白（路径可以含空格，不能按空白切 token）
    let from = at;
    while (from > 0 && !/\s/.test(segment[from - 1] ?? "")) from -= 1;
    let to = at + entry.base.length;
    while (to < segment.length && !/\s/.test(segment[to] ?? "")) to += 1;
    const word = cleanToken(segment.slice(from, to));
    if (!isLiteralPathToken(word)) return false;
    const resolved = resolveToken(word, current);
    if (resolved === null) return false;
    if (resolved === entry.path || resolved.startsWith(`${entry.path}.`)) return false;
    if (dataDirs.some((dir) => resolved === dir)) return false;
    at = segment.indexOf(entry.base, at + 1);
  }
  return true;
}

/** 泛目标 token：`*`、`.`、`..`、`*.json`、`auto*` 这类会把当前目录里的东西一并卷进去的 */
function isWildTarget(word: string): boolean {
  if (word === "*" || word === "." || word === "..") return true;
  return !word.includes("/") && /\*/.test(word);
}

/* ---------- 入口 ---------- */

export type CommandRefusal =
  | { kind: "file"; file: string }
  | { kind: "dataDir"; dir: string; why: string };

/**
 * 命令串里有没有「不带完整路径、却冲着受保护记录去」的东西。
 * @param command 原样命令串
 * @param protectedFiles 受保护单文件的绝对路径
 * @param cwd 这条命令开始时的工作目录（模拟 cd 用）
 */
export function protectedCommandRefusal(
  command: string,
  protectedFiles: readonly string[],
  cwd: string,
  guard: CommandGuardEnv = defaultGuardEnv(),
): CommandRefusal | null {
  if (protectedFiles.length === 0) return null;
  const files = protectedFiles.map((file) => {
    const path = foldCmdPath(file).replaceAll(" ", "\u0000");
    return { file, path, base: baseOf(path) };
  });
  const dataDirs = [...new Set(files.map((entry) => parentOf(entry.path)).filter((dir) => dir !== ""))];
  const home = foldCmdPath(guard.home).replaceAll(" ", "\u0000");
  const variants = normalizeVariants(command, guard);

  // 「解码后执行」：base64 -d | sh、printf '\x72\x6d' | sh——名字在运行时才拼出来，字面上什么都看不见；
  // 正常命令里几乎没有「把解码结果交给 shell 执行」，所以整条拒。在原始命令串上比（折叠会改掉反斜杠）
  if (
    /(?:base64\s+(?:-d|-D|--decode)|xxd\s+-r|openssl\s+(?:enc|base64)\b.*-d|printf\s+['"]?[^|]*\\x[0-9a-fA-F]{2}|echo\s+-e\s+['"]?[^|]*\\x[0-9a-fA-F]{2})/.test(command) &&
    /(?:\|\s*(?:ba|z|da|k)?sh\b|(?:^|[\s;&|(])eval\b|(?:^|\s)(?:ba|z|da|k)?sh\s+-c\b|\bsource\s+<\(|\bpython[0-9.]*\s+-c\b|\bnode\s+-e\b)/.test(command)
  ) {
    return { kind: "dataDir", dir: humanDir(dataDirs[0] ?? ""), why: "running decoded text as a command" };
  }

  for (const variant of variants) {
    const segments = segmentsOf(variant.name);
    const pathSegments = segmentsOf(variant.path);
    const filePaths = files.map((entry) => entry.path);

    // 0. 数据目录根里的任何通配（`<数据目录>/*.json`、`<数据目录>/*`、`<数据目录>/automations*`）：整个目录都危险，不管匹配到哪个名字
    for (const dir of dataDirs) {
      const inDir = new RegExp(`${escapeRegExp(dir)}/+([^\\s/;&|)"']*[*?\\[][^\\s/;&|)"']*)`, "g");
      for (const match of variant.path.matchAll(inDir)) {
        const owner = variant.path.slice(0, match.index);
        if (isSearchSegment(segmentsOf(owner).pop() ?? "") && /^(?:find|grep|rg|ag|ack|git)\b/.test(firstWords(segmentsOf(owner).pop() ?? "").join(" "))) continue;
        return { kind: "dataDir", dir: humanDir(dir), why: "a glob over the data folder" };
      }
    }

    // 1-4 逐段过，带着当前目录跟踪：字面量 cd / pushd 更新 current，后面的段里能确定解析的
    // 相对名按 current 解析，解析到数据目录或受保护文件就拒（`cd <上级> && mv data data2` 这类
    // 不带完整路径的写法）。跟踪不出来（目标是变量、命令替换）就停在原地，按原有保守规则处理。
    let current = collapseDots(foldCmdPath(cwd).replaceAll(" ", "\u0000"));
    const dataDirSet = new Set(dataDirs);
    const parentDirSet = new Set(dataDirs.map((dir) => parentOf(dir)).filter((dir) => dir !== ""));
    for (let index = 0; index < pathSegments.length; index += 1) {
      const pathSegment = pathSegments[index] ?? "";
      const nameSegment = segments[index] ?? "";

      // cd / pushd / Set-Location：剥掉重定向（`>/dev/null`、`2>&1`）再解析目标；进到数据目录根就拒
      const cdMatch = /^(?:cd|pushd|chdir|set-location|sl|push-location)(?:\s+\/d)?\s+(?:-[a-z]+\s+)*(?:--\s+)?(.+)$/.exec(firstWords(pathSegment).join(" "));
      if (cdMatch !== null) {
        const rawTarget = stripRedirects((cdMatch[1] ?? "").trim());
        if (rawTarget !== "" && rawTarget !== "-" && !/[$`]/.test(rawTarget)) {
          const target = foldCmdPath(rawTarget).replace(/\/+$/, "") || "/";
          current = collapseDots(/^(?:\/|[a-z]:)/.test(target) ? target : `${current}/${target}`);
          if (dataDirSet.has(current)) return { kind: "dataDir", dir: humanDir(current), why: "cd into the data folder" };
        }
      }

      const isSearch = isSearchSegment(pathSegment) || isSearchSegment(nameSegment);
      // 解释器 -c/-e 的代码里常有 ( ) ; ——切段后那些片段仍属于解释器内容：整条里任一段是解释器调用，
      // 文件名命中就一律保守拒（代码可以先 chdir 再删，闸门看不清），不做「解析安全」放行
      const isInterp = isInterpreterSegment(pathSegment) || isInterpreterSegment(nameSegment) || isInterpreterSegment(variant.path);

      if (!isSearch) {
        // 1. 文件名本身。两种读法都试：反斜杠当转义（`au\tomations`）与当路径分隔符（Windows 的 `orbita\automations.json`）。
        //    字面量 variant 里能确定解析且不指向受保护文件 / 本数据目录的同名文件放行（误伤收窄：
        //    用户拿 Orbita 开发 Orbita，项目目录 / 别的开发实例里的同名文件是正常操作对象）；
        //    含变量 / 通配 / 解释器代码里出现的一律保守拒
        for (const segment of [nameSegment, pathSegment]) {
          if (segment === "") continue;
          for (const entry of files) {
            if (!mentionsName(segment, entry.base)) continue;
            if (variant.literal && !isInterp && nameHitResolvesSafe(segment, entry, current, dataDirs)) continue;
            return { kind: "file", file: entry.file };
          }
        }
        // 1b. 不带目录的通配，前缀已经写到「automation」：`rm automations*`、`rm automation[s].json`（通配解析不了，保守拒）
        for (const segment of [nameSegment, pathSegment]) {
          if (segment === "") continue;
          for (const word of segment.split(/\s+/)) {
            if (!/[*?[]/.test(word) || word.includes("/")) continue;
            if (literalPrefix(cleanToken(word)).length < "automation".length) continue;
            const regex = globToRegExp(cleanToken(word));
            const hit = files.find((entry) => regex.test(entry.base));
            if (hit !== undefined) return { kind: "file", file: hit.file };
          }
        }
      }

      // 2. 破坏性动词
      if (hasDestructiveVerb(pathSegment) || hasDestructiveVerb(nameSegment)) {
        const segment = pathSegment;
        if (globPathHitsData(segment, dataDirs, filePaths, home)) {
          return { kind: "dataDir", dir: humanDir(dataDirs[0] ?? ""), why: "a destructive command whose glob reaches the data folder" };
        }
        const targets = dataDirs.flatMap((dir) => [dir, ...ancestorsOf(dir)]);
        for (const target of targets) {
          if (mentionsWholeOrHomeRelative(segment, target, home) && !onlyAsDestination(segment, target)) {
            return { kind: "dataDir", dir: humanDir(dataDirs[0] ?? target), why: "a destructive command aimed at the data folder or one of its parent folders" };
          }
        }
        // `rm -rf /`：根目录本身也是上级
        if (/(?:^|\s)\/\*?(?=\s|$)/.test(segment) && /(?:^|[\s;&|(`])(?:rm|chmod|chown|find|shred)(?=\s)/.test(segment)) {
          return { kind: "dataDir", dir: humanDir(dataDirs[0] ?? "/"), why: "a destructive command aimed at the root folder" };
        }
        // 2b. 字面量 token（含相对名）解析后指向数据目录或受保护文件：拒（mv / cp 的目标参数除外——只有来源会被改动）。
        //     `data/*` 这类「相对目录 + 通配」：通配解析不了，但字面目录前缀能——解析到数据目录就是泛删它
        if (!isInterp) {
          for (const rawWord of segment.split(/\s+/)) {
            const word = cleanToken(rawWord);
            if (!isLiteralPathToken(word)) {
              if (/[*?[]/.test(word)) {
                const prefix = word.slice(0, Math.max(word.search(/[*?[]/), 0));
                if (prefix !== "" || word.startsWith("*")) {
                  const resolvedPrefix = resolveToken(prefix === "" ? "./" : prefix, current);
                  if (resolvedPrefix !== null && dataDirSet.has(resolvedPrefix) && !tokenIsDestination(segment, rawWord)) {
                    return { kind: "dataDir", dir: humanDir(resolvedPrefix), why: "a destructive command whose glob reaches the data folder" };
                  }
                }
              }
              continue;
            }
            const resolved = resolveToken(word, current);
            if (resolved === null) continue;
            if (dataDirSet.has(resolved) && !tokenIsDestination(segment, rawWord)) {
              return { kind: "dataDir", dir: humanDir(resolved), why: "a destructive command aimed at the data folder" };
            }
            for (const entry of files) {
              if ((resolved === entry.path || resolved.startsWith(`${entry.path}.`)) && !tokenIsDestination(segment, rawWord)) {
                return { kind: "file", file: entry.file };
              }
            }
          }
        }
        // 2c. 泛目标（`*`、`.`、`*.json`、`auto*`）与以 `.` 为默认范围的 find / git clean：
        //     有效当前目录是数据目录本身或它的直接上级时，这些东西会把记录一并卷进去，拒
        if (dataDirSet.has(current) || parentDirSet.has(current)) {
          const words = segment.split(/\s+/).map((word) => cleanToken(word));
          if (words.some((word) => isWildTarget(word))) {
            return { kind: "dataDir", dir: humanDir(dataDirs[0] ?? current), why: dataDirSet.has(current) ? "a destructive command inside the data folder" : "a destructive command over the folder holding the data folder" };
          }
          if (/(?:^|\s)(?:find|git)(?=\s)/.test(segment) && (/(?:^|\s)\.(?:\s|$)/.test(segment) || /\bclean\b/.test(segment))) {
            return { kind: "dataDir", dir: humanDir(dataDirs[0] ?? current), why: "a destructive command over the folder holding the data folder" };
          }
        }
      }
    }

    // 5. 管道 / 循环 / xargs / -exec 把「列出来的名字」交给破坏性命令：整条里点到数据目录或其上级
    const targets5 = dataDirs.flatMap((dir) => [dir, ...ancestorsOf(dir)]);
    const wholeMentions = targets5.some((target) => mentionsWholeOrHomeRelative(variant.path, target, home)) || globPathHitsData(variant.path, dataDirs, filePaths, home);
    if (wholeMentions) {
      if (/(?:^|[\s;&|])(?:xargs|parallel)(?=\s)|(?:^|\s)-(?:delete|exec|execdir)(?:\s|$)|(?:^|[\s;&|])(?:for|while)\s/.test(variant.path) && pathSegments.some(hasDestructiveVerb)) {
        return { kind: "dataDir", dir: humanDir(dataDirs[0] ?? ""), why: "listing the data folder into a destructive command" };
      }
      // 内联解释器点到数据目录（os.remove / rmSync / glob / rename …）
      if (isInterpreterSegment(variant.path)) {
        return { kind: "dataDir", dir: humanDir(dataDirs[0] ?? ""), why: "an inline script touching the data folder" };
      }
    }
  }
  return null;
}

/** 拒绝语里给人看的目录：把编码空格还原 */
function humanDir(dir: string): string {
  return dir.replaceAll("\u0000", " ");
}

/** 文件名在一段命令里出现，前后都落在名字边界上（`automations.json.bad-1` 是兄弟，`xautomations.json`、`automations.jsonx` 是别的文件） */
function mentionsName(segment: string, base: string): boolean {
  let index = segment.indexOf(base);
  while (index !== -1) {
    const before = segment[index - 1];
    const after = segment[index + base.length];
    const beforeOk = before === undefined || !/[a-z0-9_-]/.test(before);
    const afterOk = after === undefined || !/[a-z0-9_-]/.test(after);
    if (beforeOk && afterOk) return true;
    index = segment.indexOf(base, index + 1);
  }
  return false;
}

/** 给模型的拒绝理由（数据目录一类）：改道说清——读用 read / automation_list，工作台照常能用 */
export function dataDirRefusalMessage(refusal: Extract<CommandRefusal, { kind: "dataDir" }>): string {
  return (
    `Automation records are immutable, and they live in Orbita's data folder "${refusal.dir}". ` +
    `This shell command was refused (${refusal.why}) in every permission mode: it may not cd into that folder, ` +
    "list it into a destructive command, or rename / delete / chmod it or any folder above it. " +
    "To read automation records use the read tool or automation_list (not the shell). " +
    `Your session workbench inside it ("${refusal.dir}/workbenches/<session>") is still yours — use absolute paths there.`
  );
}
