/**
 * 工具审批 —— 走 pi 官方的 `tool_call` 扩展钩子。
 *
 * ⚠ 修正一个我先前的错误判断：我说过「pi 没有审批钩子，所以要把工具的 execute 包一层」。
 * **pi 有**，在扩展 API 里：`pi.on("tool_call", handler)`，handler 返回
 * `{ block?, reason? }` 即可拦截，注释还明写「要改参数就原地改 `event.input`」。
 * 那正好是我们要的三种行为，而且比包装 execute 正确得多——
 * 包装的路子当时还写错了（`createAgentSession` 的 `tools` 是**名字白名单**，
 * 不是工具对象数组，传对象进去等于一个工具都没装上）。
 *
 * 这层因此只剩一件事：把「模式 + 用户回答」翻成 pi 的 ToolCallEventResult。
 */
import {
  decidePermission,
  gatedCommandTimeout,
  type PermissionAnswer,
  type PermissionMode,
} from "../shared/permission.ts";
import { statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { resolveToCwd } from "@earendil-works/pi-coding-agent";
import type { ContextMessage } from "./image-byte-budget.ts";
import { dataDirRefusalMessage, defaultGuardEnv, protectedCommandRefusal, realpathLoose, stripFirmlinkPrefix, tildeHome, type CommandGuardEnv, type DataDirSubject } from "./protected-command.ts";

/**
 * **本会话实际启用的 pi 内建工具集**。真源一份、两个消费者：
 *
 *   1. `runtime.ts` 开轮时经 `settingsManager.applyOverrides({ defaultTools })` 交给 pi，
 *      决定本会话**内建工具的初始选择**（不是 `tools` 白名单——那个是全局的，会连自定义
 *      工具一起过滤掉，实测见 runtime.ts 那段注释）；
 *   2. `describePermissionMode` 把「哪些工具会放行 / 询问 / 拒绝」讲给模型听（见下）。
 *
 * 两者**必须同一份**：分开写就会漂——这份名单以前带着一个 pi 根本没有的 `glob`，
 * 于是提示词常年在告诉模型一个不存在的工具（2026-10-04 查证：pi 0.84.3 的
 * `createAllToolDefinitions` 只有 read / bash / powershell / edit / write / grep / find / ls）。
 *
 * **为什么搜索类工具必须在里面**：pi 的默认集是 `["read","bash","edit","write"]`，而 pi 的
 * system prompt 里有一条规则——**当工具集里有 bash、却一个 grep / find / ls 都没有的时候**，
 * 它给模型下一句 "Use bash for file operations like ls, rg, find"（0.84.3 与上游 1.0.0 同构，
 * 条件写死在 system-prompt 里）。于是搜索全走 shell：真实会话 33,201 次 bash 调用里
 * **52.4% 是搜索类命令**；而 `grep -rn X .` 会递归进 node_modules（本仓 34,337 个文件里
 * 30,997 个是它），实测 **5.57s** —— pi 自带的 grep 走 ripgrep、尊重 .gitignore，
 * 同一个任务 **0.08s**。
 *
 * 把这三个补进来**同时做两件事**：搜索改走 ripgrep / fd；并且上面那条把模型推向 bash 的
 * 规则的**触发条件不再成立**，那句话自动消失。这比「在提示词里劝模型别用 bash 搜索」硬：
 * 我们只能往 pi 的 system prompt 后面**追加**，删不掉它写的那句，劝也劝不过
 * （模型自填 timeout 那件事已经证明：提示词管不住模型）。
 *
 * 顺序只影响提示词里工具清单的先后（pi 拿它当「内建工具的初始选择」，顺序无功能含义），
 * 保持按名字排列。
 */
export const ENABLED_BUILTIN_TOOLS = ["bash", "edit", "find", "grep", "ls", "read", "write"] as const;

/**
 * 把当前模式翻成一段系统提示。
 *
 * 为什么需要它：审批只拦在 `tool_call` 上，**模型对此一无所知**。实测的表现是——
 * plan 模式下问 agent「能不能改这个文件」，它答「能」，然后真去动工具，撞墙了才发现不能。
 * 它不是在撒谎，是没人告诉过它。
 *
 * 文案**从 `decidePermission` 推出来**，不是另写一遍：三档的工具分桶由策略函数当场算，
 * 策略改了这段话跟着改。两处描述各说各话，比没有描述更糟。
 *
 * 枚举的是 `ENABLED_BUILTIN_TOOLS`——**真的启用了哪些**，不是「pi 有哪些」。
 *
 * @param extraToolNames 内建之外当前真实注册的工具名（1-2 起 MCP 的
 * `mcp__server__tool` 全部由调用方从注册表里拿来传入）——不再只枚举内建的那几个，
 * 否则 plan 模式下模型不知道 MCP 工具会被拒，照样一头撞墙（已知缺口 #4）。
 * MCP 工具没有「只读」豁免，分桶全由 decidePermission 算，不在提示词里另立规则。
 *
 * @param protectedFiles 受保护的单文件（绝对路径）：说明里点名它们的文件名，模型被告知的禁区名单
 * 与闸门真正拦的同一份（以前只写死 automations.json，归档文件对模型是隐形的）。
 */
export function describePermissionMode(
  mode: PermissionMode,
  extraToolNames: readonly string[] = [],
  protectedFiles: readonly string[] = [],
): string {
  const allow: string[] = [];
  const ask: string[] = [];
  const deny: string[] = [];
  for (const tool of [...ENABLED_BUILTIN_TOOLS, ...extraToolNames]) {
    const decision = decidePermission(mode, tool);
    if (decision.behavior === "allow") allow.push(tool);
    else if (decision.behavior === "ask") ask.push(tool);
    else deny.push(tool);
  }

  const lines = ["<orbita-permission>", `The user has set tool permission to "${mode}".`];
  if (allow.length > 0) lines.push(`Runs immediately: ${allow.join(", ")}.`);
  if (ask.length > 0) {
    lines.push(
      `Asks the user first: ${ask.join(", ")}. Each call is shown to them before it runs; ` +
        "they may allow it, deny it, or edit the arguments. Expect pauses, and expect denials.",
    );
  }
  if (deny.length > 0) {
    lines.push(
      `Refused outright: ${deny.join(", ")}. Do not call them, and do not tell the user you will ` +
        "change anything on disk — describe the change instead, and say that this mode cannot apply it.",
    );
  }
  const recordNames = [...new Set(protectedFiles.map((file) => basename(file)))];
  lines.push(
    "Immutable in every mode: task session files (transcripts and their metadata) can never be " +
      `written by any tool, and neither can the automation records (${recordNames.length > 0 ? recordNames.join(", ") : "automations.json"}) — manage ` +
      "automations only through the automation tools. Do not attempt to write, move, rename or delete these, or " +
      "cd into the folder that holds them, or rename / delete / chmod that folder or any folder above it, including via " +
      "shell commands — describe the change to the user instead; only the user can modify session data. " +
      "Any other shell command that touches Orbita's data folder outside your session workbench is refused unless it is read-only " +
      "(ls, stat, du, wc, head, tail, cat, grep / rg, find without -delete or -exec, diff) or only copies out of it. " +
      "Read automation records with the read tool or automation_list. Your session workbench stays yours to write.",
  );
  lines.push("</orbita-permission>");
  return lines.join("\n");
}

/** pi 的 tool_call 事件里我们用得上的部分 */
export interface ToolCallLike {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** pi 的 tool_call 处理结果 */
export interface ToolCallGateResult {
  block?: boolean;
  reason?: string;
}

export type PermissionAsk = (request: ToolCallLike) => Promise<PermissionAnswer>;

/**
 * 拦截面：按路径改文件的（input.path）与跑命令的（bash/powershell 的 input.command）。
 * 按路径改文件的除了 write / edit，还有文档与演示文稿那几件：新建（slides_create；doc_open 只在 create:true 时，见
 * `writePaths`）、改写演示文稿（slides_write / slides_edit / slides_insert_image）、文档插图（附件放在文档旁边）、导出
 * （doc_export / slides_export，out 相对文档所在目录）。2026-11-16 复验：slides_create / doc_open 经工作区里的符号链接在
 * sessions/、durable/ 里新建成功——这几件以前不过这道闸；工作区恰好是家目录时连符号链接都不用。
 */
const PATH_MUTATING_TOOLS = new Set([
  "write",
  "edit",
  "slides_create",
  "slides_write",
  "slides_edit",
  "slides_insert_image",
  "slides_export",
  "doc_insert_image",
  "doc_export",
]);
/** 导出工具：另有 `out`，相对文档所在目录解析 */
const EXPORT_TOOLS = new Set(["doc_export", "slides_export"]);
const COMMAND_TOOLS = new Set(["bash", "powershell"]);
/**
 * 受保护路径的命令串检查另外管着可见终端：terminal_execute 把一整行命令敲进终端，和 bash 一样能删能改
 * （2026-11-15 独立验收在真实例里用它删掉了受保护文件——它原先不过这道闸）。不并进 COMMAND_TOOLS：
 * 那个集合还决定「抬超时」，终端命令没有超时参数。终端的当前目录可能已不是会话 cwd，相对路径按会话 cwd
 * 解析只是近似——带完整路径、~、变量指向数据目录的写法照拦。
 */
const PROTECTED_COMMAND_TOOLS = new Set([...COMMAND_TOOLS, "terminal_execute"]);

/**
 * write / edit 的目标路径可能落到哪：闸门自己的字面解析，加上 **pi 落盘前实际用的那套规整**
 * （resolveToCwd：展开 `~`、去掉 `@` 前缀、把不间断空格等换成普通空格、认 `file://`）。
 * 只做字面解析时，`~/Library/…/sessions/x` 会被当成 cwd 下一个叫 `~` 的相对目录而放行，随后 pi 把它
 * 写进真实的会话目录（2026-11-15 独立验收在真实例里写成功）。两种解析都比，各自再跟一遍符号链接。
 */
function resolvedForms(cwd: string, target: string): string[] {
  const resolved = [resolve(cwd, target)];
  try {
    resolved.push(resolveToCwd(target, cwd));
  } catch {
    // 规整不了的输入（如畸形 file:// URL）pi 自己也会抛、写不成；字面解析那一份照比
  }
  // firmlink 前缀去掉的那一份也比：受保护目录还不存在时（stat 不到），按文件身份比认不出它
  // （2026-11-16 复验：开关开着时 pi-sessions/ 还没建，firmlink 前缀的 write 把它连同文件一起建了出来）
  return [...new Set(resolved.flatMap((path) => [path, stripFirmlinkPrefix(path)]))];
}

/**
 * 这次工具调用会写到哪些路径（绝对路径，未折叠）；null = 这个工具不按路径写文件，[] = 没给路径（工具自己会报错）。
 * doc_open 只有 create:true 才写盘（新建空文档），只是打开不算。导出的 out 相对文档所在目录；不给 out 时写在文档旁边，
 * 文档路径本身已经覆盖了那个目录。
 */
function writePaths(toolName: string, input: Record<string, unknown>, cwd: string): string[] | null {
  const writes = PATH_MUTATING_TOOLS.has(toolName) || (toolName === "doc_open" && input["create"] === true);
  if (!writes) return null;
  const target = input["path"];
  if (typeof target !== "string" || target === "") return [];
  const paths = resolvedForms(cwd, target);
  const out = input["out"];
  if (EXPORT_TOOLS.has(toolName) && typeof out === "string" && out !== "") {
    for (const doc of [...paths]) paths.push(resolve(dirname(doc), out));
  }
  return [...new Set(paths)];
}

/**
 * 文件身份（设备号 + inode，stat 跟符号链接走）。字符串规整与 realpath 认不出的写法，身份认得出：macOS 的 firmlink
 * （`/System/Volumes/Data/Users/…` 与 `/Users/…` 是同一个目录，realpath 不换）、硬链接、大小写变体。
 * 2026-11-16 独立复验在真实例里用 firmlink 前缀的 write / edit 覆盖了会话库、会话记录与自动化记录。
 * 读不到、或文件系统不给 inode（ino 为 0）时为 null——只剩字符串那几道比较。
 */
function identityOf(path: string): string | null {
  try {
    const stat = statSync(path, { bigint: true });
    return stat.ino === 0n ? null : `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

/** path 与它往上各级中已存在的那些的身份（判「落在受保护目录里」用：任一级就是受保护目录本身） */
function ancestorIdentities(path: string): Set<string> {
  const ids = new Set<string>();
  for (let current = path; ; current = dirname(current)) {
    const id = identityOf(current);
    if (id !== null) ids.add(id);
    if (dirname(current) === current) return ids;
  }
}

/**
 * 按身份判受保护路径（字符串与 realpath 比过之后的第二道）。没命中返回 null。
 * - `/.vol/<设备>/<inode>`（macOS 按 inode 寻址）一律拒：它的上级在字面上不是真实目录，判不出落在哪；正常工作用不着它。
 * - 受保护文件：目标就是它（硬链接 / firmlink），或目标与它同目录且同名 / 是 `<名>.` 开头的兄弟（原子写临时文件）。
 * - 受保护目录：目标往上任一已存在的一级就是它。
 * 仍拦不住（已知）：工作区里事先存在的、指向 sessions/ 或 durable/ 里某个文件的硬链接——要逐个比对目录里全部文件的
 *   inode，代价不值；造这样的硬链接本身要先绕过命令串闸门。
 */
function identityRefusal(paths: readonly string[], protectedPaths: readonly string[], protectedFiles: readonly string[]): string | null {
  if (process.platform === "darwin" && paths.some((path) => /^\/\.vol(\/|$)/i.test(path))) return VOLFS_REFUSAL;
  for (const file of protectedFiles) {
    const fileId = identityOf(file);
    const parentId = identityOf(dirname(file));
    const name = basename(file).toLowerCase();
    for (const path of paths) {
      if (fileId !== null && identityOf(path) === fileId) return fileRefusalMessage(file, "path");
      const own = basename(path).toLowerCase();
      if (parentId !== null && (own === name || own.startsWith(`${name}.`)) && identityOf(dirname(path)) === parentId) {
        return fileRefusalMessage(file, "path");
      }
    }
  }
  const dirs = new Map<string, string>();
  for (const dir of protectedPaths) {
    const id = identityOf(dir);
    if (id !== null) dirs.set(id, dir);
  }
  if (dirs.size === 0) return null;
  for (const path of paths) {
    for (const id of ancestorIdentities(path)) {
      const dir = dirs.get(id);
      if (dir !== undefined) return refusalMessage(dir, "path");
    }
  }
  return null;
}

const VOLFS_REFUSAL =
  "Paths under /.vol address a file by its inode, so Orbita cannot tell whether they reach protected session or automation " +
  "records; writing through them is refused in every permission mode. Use the file's ordinary path instead.";

/**
 * 模型自填的命令超时**下限**（秒）：低于它的 `timeout` 抬到它，不填就不动。
 *
 * pi 的 bash 工具**没有系统超时**（`MAX_TIMEOUT_SECONDS` 是 2147483.647 秒，约 24 天），
 * 唯一的秒表就是 schema 里那个可选 `timeout` 参数——**由模型自己填**。它会填一个保守的
 * 小值（2026-10-01 统计全部会话：60s ×128、30s ×27、10s ×12；2026-10-04 复查，填过的共
 * 1,812 次），于是慢命令被自己的秒表拦腰砍掉：全仓 grep、依赖安装、构建、测试在 Windows 上
 * 本来就慢。**代价不是「命令失败」，是白等一分钟再重试**——进程重开、环境重热、从头再跑。
 * 系统提示词里那句「不要传 timeout」拦不住，所以这里兜底。
 *
 * **填了只升不降**：填得比下限大（900s）是模型自己的判断，尊重它。非法值
 * （≤ 0 / 非有限数）不在这里修——pi 自己会报「Invalid timeout」，我们不替它做第二套校验。
 *
 * **不填补默认上限**（2026-10-30 起，`COMMAND_TIMEOUT_DEFAULT_SECONDS` = 1 小时）：以前
 * 不填就不设超时，命令自己卡死时整轮永远挂着；到点 pi 杀整棵进程树、把输出交回模型。
 * 整条规则在 shared 的 `gatedCommandTimeout`，这里只管「哪些工具」与「原地改」。
 *
 * 常量本体在 shared/permission.ts（闸门与 renderer 的「上限」显示同源：闸门改的是
 * clone、不回写入参，显示若不套同一条规则，模型填 60 时界面说「上限 1:00」、
 * 实际跑在 10 分钟上）。提示词那段话也引它：同一个数有两处真源的话，改了常量提示词还说着旧数。
 */

/** 原地抬 `event.input.timeout`（pi 的约定，与下面的改写入参同一套）。闸门内部用，行为经 `createToolCallGate` 测。 */
function raiseCommandTimeout(toolName: string, input: Record<string, unknown>): void {
  if (!COMMAND_TOOLS.has(toolName)) return;
  const raw = input["timeout"];
  const gated = gatedCommandTimeout(raw);
  // 值没变不写：非法值原样留给 pi 报错，NaN 也不被「重写成自己」
  if (!Object.is(gated, raw)) input["timeout"] = gated;
}

/**
 * 路径折叠：Windows 文件系统大小写不敏感，比较前小写化、反斜杠转正斜杠、
 * 收拢连续斜杠（JSON.stringify 会把 `\` 转义成 `\\`，不收拢就对不上）。
 * posix 保持原样——文件系统大小写敏感，不折。
 */
function foldPath(value: string): string {
  // 小写一律折：macOS APFS 与 Windows NTFS 默认都不分大小写（2026-11-14 验收：大写变体能指到同一个文件）；
  // Linux 上多折一点只会多拦一个大小写不同的同名文件，安全向
  const slashed = process.platform === "win32" ? value.replaceAll("\\", "/").replace(/\/{2,}/g, "/") : value;
  return slashed.toLowerCase();
}

/**
 * 命令串比前把引号与转义空格折平：真命令里路径常被引号分段（`~/'Application Support'/x`）
 * 或反斜杠转义空格（`Application\ Space`），折平后字面量才对得上。只剥引号、只把 `\ `
 * 折成空格——**不能剥所有反斜杠**：posix 下它还是路径分隔符（`sessions\abc` 剥掉就成
 * `sessionsabc`，边界判定反而漏拦）。折的是**比对用的副本**，不改真命令；副作用方向
 * 是「多拦一条不常觊觎的命令」，安全向。
 */
function loosenShellQuoting(value: string): string {
  return value.replaceAll(/["']/g, "").replaceAll("\\ ", " ");
}

/**
 * 把命令串里参数位置的 `~` / `~/` 展开成家目录，给字面量比对用（2026-11-14 随自动化
 * 记录保护补上；此前 sessions/ 也拦不住 `~` 形式——受保护路径都是绝对路径，`~/...`
 * 字面量对不上）。只认前面是行首/空白/引号/`=`/`;`/`&`/`|`/`(`/重定向、后面跟 `/`
 * 或结尾的 `~`；`~user`、`~+`、`$HOME`、`%APPDATA%` 这类展开规则各不相同，不认，
 * 归入「蓄意混淆」的既定边界。只改比对用的副本，不改真命令。
 */
function expandTildeLiterals(command: string, guard: CommandGuardEnv): string {
  // `~用户名` 也展开（2026-11-16 复验：`rm ~guanhongli/Library/…` 在真实例里删成了）；规则见 tildeHome
  return command.replaceAll(/(^|[\s"'=; &|()><])~([A-Za-z0-9._-]*)(?=\/|\s|$)/g, (_match: string, lead: string, user: string) => lead + tildeHome(user, guard));
}

/**
 * 单命令里 `needle` 是否落在路径边界上：`.../automations.json` 后面跟分隔符/引号/空白/
 * 结尾才算命中，`.../automations.jsonx`、`.../automations-json` 这种相邻名字是另一个
 * 文件，不拦。目录与单文件两条清单共用。
 */
function commandMentions(haystack: string, needle: string): boolean {
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    const next = haystack[index + needle.length];
    if (next === undefined || !/[a-z0-9_-]/i.test(next)) return true;
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

/**
 * 本实例的数据目录（命令串闸门的白名单管辖区）：会话账本目录（sessions/、pi-sessions/）的父目录——
 * 它们由主进程按本实例的 userData 拼出，一定在本实例的数据目录里。
 * 受保护文件在这些目录**之外**的（开发实例里的正式实例记录、数据目录外的事件镜像）只按文件保，不整目录管。
 * 没给会话目录（只给了文件）时退回「文件的父目录」。
 */
function ownDataDirs(protectedPaths: readonly string[], protectedFiles: readonly string[]): string[] {
  const dirs = protectedPaths.length > 0 ? protectedPaths.map((dir) => dirname(dir)) : protectedFiles.map((file) => dirname(file));
  return [...new Set(dirs)];
}

/**
 * 会话文件不可变（2026-09-18 立规）：protectedPaths（sessions/ 与 pi-sessions/）
 * 对工具面**全档只读**——这条检查在权限档判定**之前**跑，Skip 也抬不掉。
 * 自动化记录不可变（2026-11-13 用户提出：智能体不该能把自己的自动化记录删掉）：protectedFiles（单文件，目前只有
 * automations.json）同一等级、同一条路。它记的是「智能体定时做过什么」，智能体
 * 删改它 = 丢痕迹；智能体要改自动化走自动化工具（那套工具本来就不能删）。
 *
 * 拦截力度如实说：write / edit 是**路径精确拦**（目录判前缀；单文件判相等与
 * `<file>.` 开头的兄弟——原子写临时文件与坏文件隔离都长这样）；bash / powershell
 * 先过 protected-command.ts 的**数据目录白名单**（碰到本实例数据目录的命令默认拒，只有只读的放行；判定流程见该文件头注释），
 * 再过完整路径字面量拦（受保护路径出现在命令串里就拒；比对前展开参数位置的 `~`、
 * 剥掉引号与反斜杠转义）——拦得住常规引用、引号分段与几十种变形，拦不住刻意混淆（变量间接、
 * 编码变换、写好脚本再执行）。对「防误伤、防顺手」足够；对蓄意对抗不是防线，那是 OS 级沙箱的活。
 * MCP server 是用户显式安装的可信组件，不在本闸管辖内。读不受限——「只能读」
 * 正是这里要保的状态。
 *
 * 命中返回讲给模型听的拒绝理由（改道指引），没命中返回 null。
 */
export function protectedPathRefusal(
  toolName: string,
  input: Record<string, unknown>,
  protectedPaths: readonly string[],
  cwd: string,
  protectedFiles: readonly string[] = [],
  guard: CommandGuardEnv = defaultGuardEnv(),
): string | null {
  if (protectedPaths.length === 0 && protectedFiles.length === 0) return null;

  const paths = writePaths(toolName, input, cwd);
  if (paths !== null) {
    if (paths.length === 0) return null;
    // 字面路径与「跟着符号链接走之后的真实路径」两个都比：链接两步（ln -s 之后 write 链接）躲不过
    const candidates = [...new Set(paths.flatMap((path) => [foldPath(path), foldPath(realpathLoose(path))]))];
    for (const file of protectedFiles) {
      // 单文件命中：文件本身，或它的 `.tmp` / `.bad-` 兄弟（原子写临时文件与坏文件
      // 隔离都以 `<file>.` 开头）——精确圈住 store 的落盘足迹，不外溢到同目录别的文件
      const entries = [...new Set([foldPath(resolve(file)), foldPath(realpathLoose(file))])];
      for (const resolved of candidates) {
        if (entries.some((entry) => resolved === entry || resolved.startsWith(`${entry}.`))) {
          return fileRefusalMessage(file, "path");
        }
      }
    }
    for (const dir of protectedPaths) {
      for (const base of new Set([foldPath(resolve(dir)), foldPath(realpathLoose(dir))])) {
        for (const resolved of candidates) {
          const rel = relative(base, resolved);
          if (!rel.startsWith("..") && !isAbsolute(rel)) return refusalMessage(dir, "path");
        }
      }
    }
    // 字符串对不上的（firmlink、硬链接、/.vol）再按文件身份比一道
    return identityRefusal(paths, protectedPaths, protectedFiles);
  }

  if (PROTECTED_COMMAND_TOOLS.has(toolName)) {
    const command = input["command"];
    if (typeof command !== "string" || command === "") return null;
    // 先过命令串里不带完整路径的写法：文件名本身 / 变量 / 通配 / cd 进数据目录 / 对数据目录或其上级的破坏性命令
    const loose = protectedCommandRefusal(command, { files: protectedFiles, ownDirs: ownDataDirs(protectedPaths, protectedFiles) }, cwd, guard);
    const haystack = loosenShellQuoting(foldPath(stripFirmlinkPrefix(expandTildeLiterals(command, guard))));
    if (loose !== null) {
      return loose.kind === "file" ? fileRefusalMessage(loose.file, "command") : dataDirRefusalMessage(loose, touchedSubject(haystack, protectedPaths, protectedFiles));
    }
    for (const dir of protectedPaths) {
      const needle = loosenShellQuoting(foldPath(dir));
      if (commandMentions(haystack, needle)) return refusalMessage(dir, "command");
    }
    for (const file of protectedFiles) {
      const needle = loosenShellQuoting(foldPath(file));
      if (commandMentions(haystack, needle)) return fileRefusalMessage(file, "command");
    }
    return null;
  }

  return null;
}

/** 受保护目录是哪一类：新内核的会话库目录（`durable/`）与会话账本（sessions/、pi-sessions/）给模型的说法不同 */
function dirSubject(dir: string): "database" | "sessions" {
  return basename(dir) === "durable" ? "database" : "sessions";
}

/**
 * 被数据目录白名单拒掉的命令碰的是什么（拒绝理由按它说）：命令串里出现了哪个受保护目录 / 文件的完整路径；
 * 会话库目录优先于账本、账本优先于自动化记录；都没出现（cd 进数据目录、相对路径、上级目录）= 说整个数据目录。
 */
function touchedSubject(haystack: string, protectedPaths: readonly string[], protectedFiles: readonly string[]): DataDirSubject {
  const mentioned = protectedPaths.filter((dir) => commandMentions(haystack, loosenShellQuoting(foldPath(dir)))).map(dirSubject);
  if (mentioned.includes("database")) return "database";
  if (mentioned.includes("sessions")) return "sessions";
  if (protectedFiles.some((file) => commandMentions(haystack, loosenShellQuoting(foldPath(file))))) return "automation";
  return "dataFolder";
}

/**
 * 拒绝理由分两种讲法。命令串拦是字面量拦，分不出读写——`ls` 一个会话目录也会撞上。
 * 只说「不能写」模型会以为自己在写，原地重试或卡住（实测）；所以命令这一支要
 * 直说「命令里不能出现这个目录，读请换 ls / read / find / grep 工具或 read_task」，
 * 让它第一次撞墙就知道往哪绕。保护强度不变。
 */
function refusalMessage(dir: string, via: "path" | "command"): string {
  if (dirSubject(dir) === "database") return databaseRefusalMessage(dir, via);
  const lead =
    via === "command"
      ? `Session records are immutable: "${dir}" is protected, and shell commands may not reference it ` +
        "in any permission mode — even read-only ones, because the check cannot tell reading from writing. "
      : `Session records are immutable: "${dir}" is protected — no tool may write there in any permission mode. `;
  return (
    lead +
    "To read it, use the ls / read / find / grep tools (not the shell), or read_task for a task's transcript. " +
    "To change it, describe the change to the user instead; only the user can modify session data."
  );
}

/**
 * 会话库目录（`<userData>/durable/`：每棵会话树一个 SQLite 库）的拒绝理由：与账本同一副骨架；改道指引是 read_task
 * （库文件是二进制，读它的原文对模型没有用）。
 */
function databaseRefusalMessage(dir: string, via: "path" | "command"): string {
  const lead =
    via === "command"
      ? `The session database is immutable: its folder "${dir}" is protected, and shell commands may not reference it ` +
        "in any permission mode — even read-only ones, because the check cannot tell reading from writing. "
      : `The session database is immutable: its folder "${dir}" is protected — no tool may write there in any permission mode. `;
  return (
    lead +
    "To read a task's history, use read_task (not the shell). " +
    "To change it, describe the change to the user instead; only the user can modify session data."
  );
}

/**
 * 单文件保护的拒绝理由（目前只有自动化的账本 automations.json）：与目录版同一副骨架、
 * 同一句「命令串分不出读写」的老实话；改道指引不同——自动化有工具面
 * （automation_create / update / cancel，**没有删**），想删记录只能请用户到自动化面板里删。
 */
function fileRefusalMessage(file: string, via: "path" | "command"): string {
  const lead =
    via === "command"
      ? `Automation records are immutable: "${file}" is protected, and shell commands may not reference it ` +
        "in any permission mode — even read-only ones, because the check cannot tell reading from writing. "
      : `Automation records are immutable: "${file}" is protected — no tool may write it in any permission mode. `;
  return (
    lead +
    "To read it, use the read tool or automation_list (not the shell). " +
    "To change automations, use the automation tools (automation_create / automation_update / automation_cancel); " +
    "they cannot delete records — ask the user to do that in the Automations panel."
  );
}

/** pi 扩展 API 里我们用到的钩子。上游类型没导出成可直接消费的形状，这里只声明用得着的部分。 */
export interface PiExtensionApi {
  on(
    event: "tool_call",
    handler: (event: ToolCallLike) => ToolCallGateResult | Promise<ToolCallGateResult>,
  ): void;
  on(
    event: "before_agent_start",
    handler: (event: { systemPrompt: string }) => { systemPrompt: string } | void,
  ): void;
  /** 返回非 undefined 的值替换请求 payload（cc-billing-patch 用）；上游契约 BeforeProviderRequestEventResult = unknown */
  on(
    event: "before_provider_request",
    handler: (event: { payload: unknown }) => unknown,
  ): void;
  /** 每次 LLM 调用前触发（transformContext）：返回 { messages } 替换发往 provider 的那份，
   * 不写回 pi 本子（image-byte-budget 的 wire-only 替换用它）。上游契约 ContextEvent */
  on(
    event: "context",
    handler: (
      event: { type: "context"; messages: ContextBudgetMessage[] },
    ) => { messages: ContextBudgetMessage[] } | undefined | void,
  ): void;
  /** 往 pi 本子追加 custom entry（不进 LLM 上下文）：跨轮持久化扩展自己的状态 */
  appendEntry(customType: string, data?: unknown): void;
}

/** context 事件里的消息形状（AgentMessage 的结构化子集），image-byte-budget 定义 */
export type ContextBudgetMessage = ContextMessage;

/**
 * 生成 `tool_call` 处理器。纯逻辑 + 一个注入的询问函数，可被测试穷尽。
 *
 * 会话文件不可变（2026-09-18）与自动化记录不可变（2026-11-13）：protectedPaths /
 * protectedFiles 缺席（旧测试、或主进程没给）= 不做禁区检查；给了就在权限档判定
 * **之前**拦——Skip 档也拦。
 *
 * 改写入参走 pi 的约定：**原地改 `event.input`**（不是返回新对象）。
 *
 * 顺序上讲一句：参数兜底（`raiseCommandTimeout`）跑在**所有早退之前**，而用户在审批卡片里
 * 改的入参跑在**最后**——两条都是原地改，含义不同：兜底是防模型失手，人工明确填的秒表
 * 是当事人自己的选择，不以兜底覆盖它。
 */
export function createToolCallGate(
  getMode: () => PermissionMode,
  ask: PermissionAsk,
  protectedPaths: readonly string[] = [],
  cwd: string = process.cwd(),
  protectedFiles: readonly string[] = [],
  guard: CommandGuardEnv = defaultGuardEnv(),
) {
  return async (event: ToolCallLike): Promise<ToolCallGateResult> => {
    // **跑在每条早退之前**：放行 / 询问 / 拒绝三条路都不能绕过它，否则默认档（skip 直接
    // 放行）就漏掉了——而那正是模型填小超时的场景。
    raiseCommandTimeout(event.toolName, event.input);
    const refusal = protectedPathRefusal(event.toolName, event.input, protectedPaths, cwd, protectedFiles, guard);
    if (refusal !== null) return { block: true, reason: refusal };
    const decision = decidePermission(getMode(), event.toolName);
    if (decision.behavior === "allow") return {};
    if (decision.behavior === "deny") return { block: true, reason: decision.message };

    const answer = await ask(event);
    if (answer.behavior === "deny") {
      return { block: true, reason: answer.message ?? "Denied by the user." };
    }
    if (answer.input !== undefined && typeof answer.input === "object" && answer.input !== null) {
      // pi 的约定：原地修改，后续 handler 与真正的执行都看到改后的值
      for (const key of Object.keys(event.input)) delete event.input[key];
      Object.assign(event.input, answer.input as Record<string, unknown>);
    }
    return {};
  };
}
