import { COMMAND_TIMEOUT_HARD_MAX_SECONDS } from "./permission.ts";

/**
 * 「命令自述的等待时长」——给超时闸门用的纯函数。
 *
 * 要解决的边界：有人就是想 `sleep 2000`。它既不吐字也不吃 CPU，到 1800 秒默认上限时
 * 没有任何「进展证据」，会被当成挂死的探针砍掉；可它其实把答案写在自己命令里了——
 * 它说要等 2000 秒。
 *
 * **为什么不按命令名豁免**（看到 `sleep` 就放行）：`bash -c 'sleep …'`、变量
 * （`S=2000; sleep $S`）、`;` / `&` 拼接都能绕过去，而且**挂死的探针伪装成 sleep 太容易**——
 * 豁免的命令名一旦能被拼进复合命令，豁免就不再有边界。反过来，只认「整条命令就是一个
 * 简单命令」是**可判定**的：命不中就退回默认上限，宁可少豁免，也不乱猜。
 *
 * **为什么只认裸词、不认全路径**（`/usr/bin/sleep`）：白名单越简单越难被利用。
 * 多认一条路径就多一处「看起来在睡觉、实际在干别的」的伪装面，而 `/usr/bin/sleep 2000`
 * 这种写法在真实会话里几乎不出现（模型写的是裸 `sleep`）。漏认的代价只是一条命令
 * 按默认上限跑，不是错误。
 *
 * **为什么限定这几个形态**：`sleep N` 与 coreutils 的 `timeout N …` 是唯一两种「命令
 * 字面量里写着我要跑多久」的常见写法。别的写法（脚本、`until`、后台等待）自述的时长
 * 都不是它能保证的，认了就是替模型猜。
 */

/**
 * 复合命令的元字符：出现任何一个就判 null。
 *
 * 这些字符让「整条命令的时长」不再是某个简单命令的时长——`sleep 30; retry` 可能是
 * 30 秒也可能是永远；`$S` 的时长要执行时才知道。**不在这里做 shell 解析**：认不全的
 * 解析器比不解析更危险，这里只做「显然不是单一简单命令」的排除。
 *
 * 反引号、`(`、`)` 同样能嵌套命令；`\n` / `\r` 是多行命令的分隔符。引号本身不在名单里：
 * 带引号的字面量（`sleep "30"`）会在下面的 token 校验里自然失配（数字 token 必须是纯数字）。
 */
const COMPOUND_METACHARS = /[;&|><()`$\n\r]/;

/** 裸词白名单——只这两个，且只认它们的裸写法。 */
const NAME_SLEEP = "sleep";
const NAME_TIMEOUT = "timeout";

/**
 * 数字 token 的合法形状：纯十进制整数，可带一个 `s` 后缀（`sleep 30s`）。
 *
 * **只认秒**：`sleep 1m` 必须不认——`Number.parseInt("1m")` 会得到 1，当 1 秒处理会把
 * 71 秒的等待设成 61 秒上限（比默认值还短），比不认更糟。所以先卡形状再 parse，
 * 而不是拿 `parseInt` 当宽松解析器。
 */
const SECONDS_TOKEN = /^(\d+)s?$/;

/**
 * 命令自身声明的秒数；不是「单一简单命令」或形态不合规时返回 `null`。
 *
 * 命中：
 * - `sleep 30` / `sleep 2000` / `sleep 30s`（恰好一个参数，纯秒数）
 * - `timeout 2000 some-cmd …`（coreutils 的 timeout，第二个词是秒数；后面跟什么不解析）
 *
 * 不命中（回 null）：复合命令（`cd x && sleep 2000`、`sleep 30; echo ok`、`sleep 30 & …`、
 * `sleep 30 | cat`、`S=2000; sleep $S`）、被包一层（`bash -c 'sleep 2000'`）、
 * 全路径（`/usr/bin/sleep 30`）、只提名字（`echo sleep 2000`）、缺参数 / 参数不是秒
 * （`sleep`、`sleep abc`、`sleep 1m`、`timeout`）、非正数（`sleep 0`、`sleep -5`）。
 */
/** 自述时长换算时留给命令收尾的余量（秒）。 */
export const COMMAND_DECLARED_GRACE_SECONDS = 60;

/**
 * 命令自述时长换算成的超时秒数：`min(N + 60, HARD_MAX)`。
 *
 * **一处真源、两个消费者**：agent 的超时闸门（真正写进入参）与 renderer 的「上限」显示。
 * 之前只有闸门知道这条规则，界面于是把 `sleep 2000` 显示成默认的 30:00、实际跑在 34:20 上——
 * 正是 shared/permission.ts 注释里警告的「界面对用户撒谎」。
 *
 * +60 是给命令自身收尾留的余量（`sleep 2000` 到 2000 秒整才返回，两边都按整秒计数，
 * 贴边会差一个采样周期）；封顶走 `hardMaxSeconds`（由调用方传入策略上限，
 * 缺省是出厂常量）——否则「声明一个巨大的 sleep」就成了绕过上限的后门。
 */
export function declaredCommandTimeout(
  command: unknown,
  hardMaxSeconds: number = COMMAND_TIMEOUT_HARD_MAX_SECONDS,
): number | null {
  if (typeof command !== "string") return null;
  const seconds = declaredCommandSeconds(command);
  if (seconds === null) return null;
  return Math.min(seconds + COMMAND_DECLARED_GRACE_SECONDS, hardMaxSeconds);
}

export function declaredCommandSeconds(command: string): number | null {
  if (COMPOUND_METACHARS.test(command)) return null;
  const tokens = command.trim().split(/\s+/);
  if (tokens.length < 2) return null;

  const name = tokens[0];
  let secondsToken: string | undefined;
  if (name === NAME_SLEEP) {
    // 必须恰好一个参数：`sleep 30 40` 的真实时长是 70，不是任何一个 token
    if (tokens.length !== 2) return null;
    secondsToken = tokens[1];
  } else if (name === NAME_TIMEOUT) {
    // `timeout 2000 cmd` 至少三个词；`timeout 2000`（没有要跑的命令）是无效调用
    if (tokens.length < 3) return null;
    secondsToken = tokens[1];
  } else {
    return null;
  }

  if (secondsToken === undefined) return null;
  const match = SECONDS_TOKEN.exec(secondsToken);
  if (match === null) return null;
  const digits = match[1];
  if (digits === undefined) return null;
  const seconds = Number.parseInt(digits, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds;
}
