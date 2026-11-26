/**
 * 本机可绑地址的枚举——设置页「绑在哪」的候选清单。
 *
 * 规矩（规格 2.1）：Tailscale 的（100.64.0.0/10）排最前，其后私网（10/8、172.16/12、192.168/16），
 * 最后回环（只用于开发）。公网地址不列——这个服务只给用户自己的手机用。分类的口径在
 * `classifyBindAddress`（契约），这里只做枚举与去重。
 *
 * 只认 IPv4：理由写在契约里（IPv6 链路本地要带网卡序号、ULA 前缀各家不一，第一版不列）。
 */
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { classifyBindAddress, sortBindCandidates, type MobileBindCandidate } from "../../shared/mobile.ts";

/** 从网卡表挑出可绑的 IPv4 地址，去重、按 Tailscale → 私网 → 回环排序 */
export function bindCandidatesOf(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): MobileBindCandidate[] {
  const seen = new Set<string>();
  const candidates: MobileBindCandidate[] = [];
  for (const [interfaceName, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      // family 在新 Node 上是 "IPv4" / "IPv6" 字符串，旧的是 4 / 6——两种都认
      const isV4 = info.family === "IPv4" || (info.family as unknown) === 4;
      if (!isV4) continue;
      const kind = classifyBindAddress(info.address);
      if (kind === null || seen.has(info.address)) continue;
      seen.add(info.address);
      candidates.push({ address: info.address, kind, interfaceName });
    }
  }
  return sortBindCandidates(candidates);
}

/** 生产环境的那一份：现读网卡表 */
export function bindCandidates(): MobileBindCandidate[] {
  return bindCandidatesOf(networkInterfaces());
}
