/**
 * Claude 订阅车道的最小改写（参照 pi 生态的 pi-cc-patch 1.0.3，MIT，作者 picassio；
 * 用户 2026-10 拍板采用——「偶尔用 OAuth，大部分时候 sub2api」）。
 *
 * 背景：Anthropic 按 system prompt 内容与路由标把请求分进「订阅限流桶」或「第三方
 * extra usage 桶」。pi 原生形状的带工具请求一律被分进后者（pi#3372，我们实测同报错：
 * "Third-party apps now draw from your extra usage"）。这个模块做被验证过的最小四件事：
 *
 * 1. system 首块加 `x-anthropic-billing-header`（cc_version + cc_entrypoint）——进订阅桶
 *    的钥匙；版本须 ≥ Anthropic 对最新型号的最小值（opus-5-5 曾拒绝 2.1.261 以下，
 *    报 claude_code_version_too_old）。
 * 2. 删掉 pi 给 OAuth 请求加的独立 "You are Claude Code" 块——它本身是检测触发器
 *    （真 CC 不把身份句当独立 system 块发）。
 * 3. 洗掉 system prompt 里的 pi 自称——分类器按关键词 grep（"operating inside pi"、
 *    "pi packages"…）。注意 <project_instructions>（AGENTS.md）也在 system 里，一并过洗。
 * 4. 补 metadata.user_id（真 CC 恒带；占位值，不带任何真实标识）。
 *
 * **刻意不做**（红线，与 sub2api 的深水区分界）：不改工具 schema、不伪造 X-Stainless
 * 遥测、不做多账号。只对 OAuth 请求生效——判定标志是 payload.system 里 pi 的身份块
 * （pi 只对 sk-ant-oat 令牌加它），API key / Bedrock / OpenRouter / 智谱 / 自建网关
 * 的请求没有这个块，原样通过。
 */

/** 与 pi-cc-patch 1.0.3 同源：Anthropic 对最新 OAuth 型号的最小接受版本 */
const CC_VERSION = "2.1.280";

const BILLING_PREFIX = "x-anthropic-billing-header";

/** pi 的 OAuth 身份块开头（buildParams 的 OAuth 分支）。它同时是我们的车道判定标志。 */
function isIdentityBlock(text: string): boolean {
  return text.startsWith("You are Claude Code") && text.includes("official CLI");
}

/** 这是带 pi OAuth 身份块的请求吗（= 走订阅车道的 Claude 直连） */
export function isAnthropicOauthPayload(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const system = (payload as { system?: unknown }).system;
  if (!Array.isArray(system)) return false;
  return system.some(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string" &&
      isIdentityBlock((block as { text: string }).text),
  );
}

/**
 * 洗掉 prompt 里的 pi 自称。映射表对齐我们钉的 pi 0.84.3 基础 prompt 的实际措辞
 * （system-prompt.js:82 起），并保留 pi-cc-patch 的兜底规则（独立的 "pi" 一词）。
 * 只改模型看到的 wire 文案，会话落盘的 prompt 不动。
 */
export function sanitizeSystemPrompt(text: string): string {
  return (
    text
      .replace(/operating inside pi, a coding agent harness\./g, "operating as a coding assistant.")
      .replace(/Pi documentation/g, "Documentation")
      .replace(/pi itself,/g, "the tool itself,")
      .replace(/pi packages/g, "packages")
      .replace(/read pi \.md/g, "read .md")
      // 包名与路径段（readmePath 等指向 …/pi-coding-agent/…）
      .replace(/pi-coding-agent/g, "coding-agent")
      .replace(/@earendil-works\/pi-ai/g, "@anthropic/ai")
      .replace(/about pi\b/g, "about this tool")
      .replace(/pi update\b/g, "update")
      // 兜底：剩下的独立 "pi" 一词（后随空白/句读）。连字符形式（pi-sessions、pi-ai）不匹配
      .replace(/\bpi\b([\s,.])/g, "the assistant$1")
  );
}

/** 改写后的 system 块序列：路由标打头，身份块删除，其余文本过洗（cache_control 等保留） */
function rewriteSystem(system: readonly unknown[]): unknown[] {
  const blocks: unknown[] = [
    {
      type: "text",
      text: `${BILLING_PREFIX}: cc_version=${CC_VERSION}.000; cc_entrypoint=cli;`,
    },
  ];
  for (const block of system) {
    if (typeof block !== "object" || block === null) {
      blocks.push(block);
      continue;
    }
    const entry = block as Record<string, unknown>;
    if (entry.type !== "text" || typeof entry.text !== "string") {
      blocks.push(block);
      continue;
    }
    // 旧的路由标与本模块加过的都不重复（幂等：扩展被触发两次也不堆块）
    if (entry.text.startsWith(BILLING_PREFIX)) continue;
    if (isIdentityBlock(entry.text)) continue;
    blocks.push({ ...entry, text: sanitizeSystemPrompt(entry.text) });
  }
  return blocks;
}

/**
 * OAuth 请求的 payload 改写。不是 OAuth 请求（或形状不符）原样返回 undefined——
 * 调用方据此不替换。返回的是新对象，不就地改入参。
 */
export function ccBillingPatch(payload: unknown): unknown {
  if (!isAnthropicOauthPayload(payload)) return undefined;
  const next: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  next.system = rewriteSystem((payload as { system: unknown[] }).system);
  if (next.metadata === undefined) {
    next.metadata = { user_id: JSON.stringify({ device_id: "0", account_uuid: "", session_id: "0" }) };
  }
  return next;
}
