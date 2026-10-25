import anthropic from "../../../../../design-system/assets/vendor-logos/anthropic.svg?raw";
import claude from "../../../../../design-system/assets/vendor-logos/claude.svg?raw";
import copilot from "../../../../../design-system/assets/vendor-logos/copilot.svg?raw";
import deepseek from "../../../../../design-system/assets/vendor-logos/deepseek.svg?raw";
import doubao from "../../../../../design-system/assets/vendor-logos/doubao.svg?raw";
import gemini from "../../../../../design-system/assets/vendor-logos/gemini.svg?raw";
import grok from "../../../../../design-system/assets/vendor-logos/grok.svg?raw";
import kimi from "../../../../../design-system/assets/vendor-logos/kimi.svg?raw";
import longcat from "../../../../../design-system/assets/vendor-logos/longcat.svg?raw";
import minimax from "../../../../../design-system/assets/vendor-logos/minimax.svg?raw";
import openai from "../../../../../design-system/assets/vendor-logos/openai.svg?raw";
import opencode from "../../../../../design-system/assets/vendor-logos/opencode.svg?raw";
import openrouter from "../../../../../design-system/assets/vendor-logos/openrouter.svg?raw";
import qwen from "../../../../../design-system/assets/vendor-logos/qwen.svg?raw";
import stepfun from "../../../../../design-system/assets/vendor-logos/stepfun.svg?raw";
import tokenrhythmMark from "../../../../../design-system/assets/vendor-logos/tokenrhythm.png";
import xiaomimimo from "../../../../../design-system/assets/vendor-logos/xiaomimimo.svg?raw";
import zai from "../../../../../design-system/assets/vendor-logos/zai.svg?raw";
import zhipu from "../../../../../design-system/assets/vendor-logos/zhipu.svg?raw";
import type { ModelFamilyLogo } from "@shared/known-models";
import { iconMarkup } from "../../shell/icon-markup.ts";

/**
 * 目录条目 → 厂商 logo（设置 › 模型服务的卡片与详情头）。SVG 来自 lobe-icons（MIT，见
 * vendor-logos/LICENSE）。彩色 logo 自带品牌色——那是厂商的标，不是我们的配色，
 * 不受「禁裸 hex」约束；单色 logo 用 currentColor，跟着主题的文字色走。
 * 同一厂商的几个条目（智谱按量 / 套餐 / 团队版，通义千问按量 / Token Plan…）共用一枚；「兼容」条目用协议方的标。
 */
/**
 * 型号家族图标（ModelAvatar 的第二级，按型号 id 前缀认，见 known-models 的 modelAvatarOf）。
 * 键与 shared 的 ModelFamilyLogo 一一对应，类型保证一枚都不缺。GLM 用 Z.ai 的标
 * （lobe-icons 的 chatglm 是 ChatGLM 时代的旧标）。
 */
const FAMILY_LOGOS: Record<ModelFamilyLogo, string> = {
  kimi,
  zai,
  deepseek,
  qwen,
  minimax,
  stepfun,
  claude,
  openai,
  xiaomimimo,
  "doubao-seed": doubao,
  longcat,
  grok,
};

const LOGOS: Record<string, string> = {
  ...FAMILY_LOGOS,
  deepseek,
  zhipu,
  "zhipu-coding": zhipu,
  zai,
  stepfun,
  "kimi-coding": kimi,
  "opencode-go": opencode,
  // claude 是 Anthropic 官方 OAuth 订阅（Claude Pro / Max）：用 Claude 的橙色标，与
  // 「Anthropic 兼容」网关的 Anthropic 字母标区分开（2026-10-19 用户：「给 claude oauth
  // 的 provider 加个 claude 的 logo（橙色的那个），和 anthropic 兼容的 logo 区分开」）
  claude,
  "anthropic-compatible": anthropic,
  "openai-compatible": openai,
  "openai-responses-compatible": openai,
  anthropic,
  openai,
  google: gemini,
  "kimi-api": kimi,
  minimax,
  xiaomi: xiaomimimo,
  "xiaomi-token-plan": xiaomimimo,
  qwen,
  "qwen-token-plan": qwen,
  openrouter,
  "zhipu-coding-team": zhipu,
  // 浏览器登录订阅：ChatGPT 用 OpenAI 的标，xAI 的订阅产品是 Grok，用 Grok 的标
  "openai-codex": openai,
  "github-copilot": copilot,
  xai: grok,
  /*
   * 基元律动：官网只发 PNG favicon（浅深两版、alpha 相同）——用 CSS mask 把它染成
   * currentColor，跟主题文字色走（与 kimi.svg 的处理同一思路，素材来源见目录里 LICENSE）。
   */
  tokenrhythm: `<span style="display:block;width:100%;height:100%;background-color:currentColor;-webkit-mask:url(${tokenrhythmMark}) center / contain no-repeat;mask:url(${tokenrhythmMark}) center / contain no-repeat"></span>`,
};

/** 没有 logo 的条目（以后新加、还没配图的）显示名字首字，不留空框 */
export function VendorLogo(props: { kindId: string; label: string; size: number }) {
  const svg = LOGOS[props.kindId];
  const box = { width: props.size, height: props.size };
  if (svg === undefined) {
    return (
      <span className="pv-logo pv-logo-text" aria-hidden="true" style={box}>
        {props.label.slice(0, 1)}
      </span>
    );
  }
  return (
    <span
      className="pv-logo"
      aria-hidden="true"
      style={box}
      // 同 Icon：按 key 缓存 { __html }，重渲染不重建 SVG（见 icon-markup.ts）
      dangerouslySetInnerHTML={iconMarkup(`vendor:${props.kindId}`, () => svg.trim())}
    />
  );
}
