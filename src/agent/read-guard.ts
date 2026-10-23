/**
 * read-before-write 守卫：改一个**已存在**的文件之前，本会话必须先读过它。
 *
 * 为什么：模型会凭猜测改写文件——凭记忆写 `oldText`、凭想象整文件重写——把它没看过的
 * 内容冲掉。这一层不判断「改得对不对」（那是模型的事），只保证一个事实：动手前看过盘上的原文。
 *
 * 调研结论（2026-10-18，pi 0.84.3）：**pi 没有**这个机制。它的 read / write / edit 三个工具
 * 各管各的——write 直接覆盖、edit 直接改，谁都不记「这个路径读过没有」；system prompt 里也
 * 只有一句「Use read to examine files instead of cat or sed」（工具选型引导，不是闸门）。
 * 官方扩展面给的两个钩子正好够用，不用打 patch：
 *   - `tool_call`（可 block）：拦在动手之前；
 *   - `tool_result`（执行后，带 isError）：知道一次 read 到底成没成。
 *
 * 账本「本会话读过哪些路径」**不在 pi 对象上**：agent 进程每轮 open 重建 pi 对象
 * （见 runtime.ts 的跨轮账本说明），所以集合挂在 runtime 的 LedgerNote 上，跨轮活着，
 * 会话删除（dispose）时随账本一起销账。
 *
 * 落账只认工具调用**成功**（tool_result 且 isError === false）：
 *   - read 成功 = 看过；
 *   - write / edit 成功 = 这个路径是本会话自己造的、自己改的，后续再改它不必重读一遍
 *     （否则模型新建一个文件、再改一次就被自己的守卫拦住）。
 *
 * **刻意不做**（都是取舍，不是漏）：
 *   - **新鲜度**：读过之后文件被外部改了（别的进程、用户手动编辑）不再拦。判它得记 read
 *     时刻的内容哈希，代价与收益不成比例：认不出来就误报，而误报会把守卫变成噪声——
 *     被模型学会的噪声等于没有守卫。
 *   - **bash 写入不在范围**：`echo x > f`、`sed -i`、`git checkout` 都能改文件，我们看不见。
 *     bash 是万能后门，字面量拦不住（编码变换、变量间接），装作能拦只会让边界更模糊。
 *     提示词层已有工具选型引导（pi 自己的 write / edit 指引 + runtime 的 TOOL_GUIDELINES）。
 *   - **部分读也算读过**：read 带 offset / limit 只读了一段，同样进账本。要判「读全了」
 *     得知道文件行数与每次读的区间；先把闸门立住，这一层需要时再加。
 *   - **进程重启即忘**：账本在内存里（与 runtime 的其它跨轮状态同命）。重启后模型被要求
 *     重读一遍——方向是保守的（多读一次 > 覆盖没看过的内容）。
 *   - **同一批并行调用里「先读后写」也不算数**：pi 先把一批的 tool_call 钩子顺序跑完、
 *     再并行执行工具（tool_result 才记账），所以「同一条 assistant 消息里先 read 再 edit
 *     同一个文件」会被拦。这是对的——那种调用里模型根本没看到 read 的结果，只是按上面的
 *     报错重试一次就能过（那时 read 已落账），代价小、方向对。
 *   - **只有 read 工具算「看过」**：对话里的附件、bash 的 `cat`、read_task / read_pdf 读过的
 *     内容都不算。一律要求走 read，规则才说得清、模型也学得会。
 */
import { existsSync } from "node:fs";
import { resolveToCwd } from "@earendil-works/pi-coding-agent";
import { PATH_MUTATING_TOOLS } from "./permission.ts";

/**
 * 平台是否折叠路径（Windows 文件系统大小写不敏感、分隔符两种写法等价）。
 * posix **不折**：`a\b` 在那里是一个合法文件名，折了会把两个不同的文件当成一个。
 */
const PLATFORM_FOLDS = process.platform === "win32";

/** 一次路径解析的两副面孔：`resolved` 给人看（报错文案），`key` 给账本比对。 */
export interface GuardPath {
  resolved: string;
  key: string;
}

/**
 * 解析 + 归一化工具入参里的路径。
 *
 * 解析用 pi 自己的 `resolveToCwd`（与它 write / edit 工具算绝对路径用的是同一个函数，
 * 见 file-tracker.ts 的同一处理由）：手抄一份会漏掉 `~` 展开、`@` 前缀、file:// URL
 * 与 Windows 的 MSYS 路径折算，于是「读 A、写 B」两边对不上，守卫静默失效。
 *
 * @param fold 是否折叠大小写与斜杠；默认按平台，测试显式传以免结果随平台漂。
 */
export function guardPath(target: string, cwd: string, fold: boolean = PLATFORM_FOLDS): GuardPath {
  const resolved = resolveToCwd(target, cwd);
  if (!fold) return { resolved, key: resolved };
  return {
    resolved,
    // 反斜杠转正斜杠（JSON 里 `\\` 与 `/` 是同一个文件）、收拢连续斜杠、小写化
    key: resolved.replaceAll("\\", "/").replace(/\/{2,}/g, "/").toLowerCase(),
  };
}

/** 查盘：目标存在吗。测试注入假文件系统（同 file-tracker 的 PathReader 手法）。 */
export type PathExists = (path: string) => boolean;

const diskExists: PathExists = (path) => existsSync(path);

export interface ReadGuardOptions {
  cwd: string;
  /** 本会话已读账本：key 是 `guardPath().key`。runtime 传 LedgerNote.readPaths.has */
  hasRead: (key: string) => boolean;
  /** 目标是否存在；默认查盘 */
  exists?: PathExists;
  /** 见 guardPath 的 fold */
  fold?: boolean;
}

/**
 * 拦截面：write / edit 的目标路径参数（与 permission.ts 的禁区检查同一张表）。
 *
 * 返回给模型的拒绝理由，或 null（放行）。语义：
 *   - 目标**不存在**（write 新建）→ 放行；
 *   - 目标存在、账本里有 → 放行；
 *   - 目标存在、账本里没有 → 拦下，让它先 read。
 */
export function readBeforeWriteRefusal(
  event: { toolName: string; input: Record<string, unknown> },
  options: ReadGuardOptions,
): string | null {
  if (!PATH_MUTATING_TOOLS.has(event.toolName)) return null;
  const target = event.input["path"];
  if (typeof target !== "string" || target === "") return null;
  const { resolved, key } = guardPath(target, options.cwd, options.fold);
  if (options.hasRead(key)) return null;
  const exists = options.exists ?? diskExists;
  if (!exists(resolved)) return null;
  return (
    `Blocked by the read-before-write guard: "${resolved}" already exists but has not been read ` +
    "in this session. Read it with the read tool first, then apply the change — editing a file " +
    "you have not read risks overwriting content you never saw. (If you meant to create a new " +
    "file, use a path that does not exist yet.)"
  );
}

/**
 * 一次工具调用成功落定后，该记进已读账本的 key；不记账的工具返回 null。
 * 账本面 = read + write + edit（理由见文件头「落账只认工具调用成功」）。
 */
export function recordedGuardKey(
  event: { toolName: string; input: Record<string, unknown> },
  cwd: string,
  fold: boolean = PLATFORM_FOLDS,
): string | null {
  if (event.toolName !== "read" && !PATH_MUTATING_TOOLS.has(event.toolName)) return null;
  const target = event.input["path"];
  if (typeof target !== "string" || target === "") return null;
  return guardPath(target, cwd, fold).key;
}
