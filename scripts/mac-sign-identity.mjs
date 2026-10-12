/**
 * macOS 打包签名身份的纯逻辑，供 scripts/dist-mac.mjs 使用；测试见 mac-sign-identity.test.mjs。
 *
 * 解析规则与 app-builder-lib 的身份发现（out/codeSign/macCodeSign.js）保持一致，避免
 * 前置校验和 electron-builder 实际行为说两套话：
 * - 名字匹配是子串匹配（_findIdentity 里 line.includes(qualifier)）；
 * - electron-builder 查身份用的是 `security find-identity -v -p codesigning`，-v 只列「有效」
 *   身份——缺 codeSigning 扩展（输出里标 (Missing required extension)）或不受系统信任的
 *   证书都不会出现（实测 macOS 25：openssl 手搓的自签名证书导入后标 CSSMERR_TP_NOT_TRUSTED，
 *   electron-builder 的 findIdentity 与 codesign 本体都找不到它）；
 * - "N valid identities found" 汇总行、iPhone / Apple IDMS 证书不是本流程的目标。
 */

/** 从环境变量解析签名身份：未设置或全空白返回 null（= 保持 ad-hoc 默认行为）。 */
export function resolveSignIdentity(env) {
  const raw = env.ORBITA_MAC_SIGN_IDENTITY;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** security find-identity 输出里不代表可用代码签名证书的行。 */
const UNUSABLE_LINE_MARKERS = [
  "(Missing required extension)",
  "valid identities found",
  "iPhone ",
  "com.apple.idms.appleid.prd.",
];

/** `  1) ABCDEF12 "证书名" (状态)` 形态的证书行，取引号内的名字。 */
const IDENTITY_LINE = /^\s*\d+\)\s+[0-9A-Fa-f]+\s+"([^"]*)"/;

/** 解析 `security find-identity -v -p codesigning` 的输出，返回可用证书名列表（去重）。 */export function parseCodesigningIdentities(findIdentityOutput) {
  const names = new Set();
  for (const line of findIdentityOutput.split("\n")) {
    if (UNUSABLE_LINE_MARKERS.some((marker) => line.includes(marker))) continue;
    const match = IDENTITY_LINE.exec(line);
    if (match == null || match[1].length === 0) continue;
    names.add(match[1]);
  }
  return [...names];
}

/** 与 electron-builder 相同的子串匹配，返回所有命中的证书名。 */
export function selectIdentityMatches(names, identity) {
  return names.filter((name) => name.includes(identity));
}

/** 生成 electron-builder 的 CLI 覆盖参数；null 或显式 "-" 时返回空（走 package.json 的 ad-hoc 配置）。 */
export function electronBuilderMacIdentityArgs(identity) {
  if (identity == null || identity === "-") return [];
  // 必须用点号形式的单 token：`--config 值` 会把值当配置文件路径。
  return [`--config.mac.identity=${identity}`];
}
