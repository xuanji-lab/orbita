/**
 * 出站请求固定走 IPv4 —— 陷阱史 #2 的网络版（2026-09-03 实测定案）。
 *
 * 症状：StepFun 的 `/models` 在应用里间歇性 `fetch failed (ETIMEDOUT)`，
 * 同一时刻终端里 curl 又是通的；不同 Node 版本、不同时段表现不同。
 *
 * 三步取证：
 *   1. `api.stepfun.com` 解析到火山引擎 WAF，**A / AAAA 双记录都在**；
 *   2. 本机**没有任何全局 IPv6 地址**（只有链路本地）——v6 必然不通；
 *      `curl -6` 8ms 内返回 000（no route），`curl -4` 正常 401；
 *   3. undici 按 DNS 顺序先试 v6；本机多条 utun 默认路由会把 v6 连接引进
 *      黑洞（SYN 无回应，耗到超时），而不是立刻报错——所以是「间歇超时」
 *      而不是「必然失败」，取决于当时 DNS 给出的顺序与回退行为。
 *
 * 修法对比（都实测过）：
 *   `dns.setDefaultResultOrder("ipv4first")`   系统 Node 25 有效，
 *                                               **Electron 38 的 Node 22 无效**——
 *                                               autoSelectFamily 的拨号不认这个序
 *   `Agent({ connect: { family: 4 } })` 挂全局  两个栈都立通
 *
 * 只影响我们自己发起的出站连接（discover / test / pi-ai 的模型调用都走全局
 * fetch）；本地回环（127.0.0.1）不受影响。哪天用户网络真有可用的 v6 了，
 * 这里也只是少走一条路，不会坏。
 */
import { Agent, setGlobalDispatcher } from "undici";

export function preferIPv4(): void {
  setGlobalDispatcher(new Agent({ connect: { family: 4 } }));
}
