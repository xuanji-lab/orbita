import type { ModelAvatarKey } from "@shared/known-models";
import { modelAvatarOf } from "@shared/known-models";
import claudeFable from "../../../../../design-system/assets/model-avatars/claude-fable.svg";
import claudeHaiku from "../../../../../design-system/assets/model-avatars/claude-haiku.svg";
import claudeOpus from "../../../../../design-system/assets/model-avatars/claude-opus.svg";
import claudeSonnet from "../../../../../design-system/assets/model-avatars/claude-sonnet.svg";
import deepseekV41Flash from "../../../../../design-system/assets/model-avatars/deepseek-v4.1-flash.png";
import deepseekV4Pro from "../../../../../design-system/assets/model-avatars/deepseek-v4-pro.png";
import glm53Flash from "../../../../../design-system/assets/model-avatars/glm-5.3-flash.png";
import glm53 from "../../../../../design-system/assets/model-avatars/glm-5.3.png";
import gptAstra from "../../../../../design-system/assets/model-avatars/gpt-astra.png";
import gptLuna from "../../../../../design-system/assets/model-avatars/gpt-luna.png";
import gptSol from "../../../../../design-system/assets/model-avatars/gpt-sol.png";
import kimiK3 from "../../../../../design-system/assets/model-avatars/kimi-k3.png";
import kimiK31 from "../../../../../design-system/assets/model-avatars/kimi-k3.1.png";
import minimaxM31Flash from "../../../../../design-system/assets/model-avatars/minimax-m3.1-flash.png";
import mimoFlash from "../../../../../design-system/assets/model-avatars/mimo-v2.6-flash.png";
import mimoPro from "../../../../../design-system/assets/model-avatars/mimo-v2.6-pro.png";
import qwen38Flash from "../../../../../design-system/assets/model-avatars/qwen3.8-flash.png";
import qwen3827b from "../../../../../design-system/assets/model-avatars/qwen3.8-27b.png";
import qwen38Max from "../../../../../design-system/assets/model-avatars/qwen3.8-max.png";
import step5Preview from "../../../../../design-system/assets/model-avatars/step-5-preview.png";
import { VendorLogo } from "./VendorLogo";

/**
 * 型号专属头像的素材（design-system/assets/model-avatars/）。哪个型号用哪一枚在 shared 的
 * known-models.ts（`modelAvatarOf`）；这里只把键接到文件上，类型保证一枚都不缺。
 *
 * 来源（2026-10-24 用户拍板，登记在本地头像登记页 docs/model-avatars/registry.json）：
 * - kimi-k3.1：月之暗面 K3.1 博客头图与书法图层合成后裁方（官方宣传素材，用于标识它自家型号）；
 * - claude-*：platform.claude.com 文档页的四枚产品线线稿（/images/dashboard-discovery/），
 *   底色参照 Proma 截图配、烧进 SVG 里（界面代码不写颜色）；
 * - 公众号封面（推文在微信列表里显示的封面图，不是正文里的图；原件与裁切脚本在本地登记页
 *   docs/model-avatars/tools/）：kimi-k3（磁感线）、glm-5.3（数字三角）、glm-5.3-flash（光锥）、
 *   deepseek-v4.1-flash（抹掉封面上的字，鲸鱼标放进金色光环）、deepseek-v4-pro（标题下的
 *   橙紫波浪 + 同一枚鲸鱼标）、step-5-preview（大「5」）、mimo-v2.6-*（两只蝴蝶，不写字——2026-10-25 用户：「上一版的作为 pro，
 *   当前版的作为 flash，然后把 pro 和 flash 的字体移除掉」：Pro 用 V2.6 横幅里的正面蝴蝶（橙色翼尖），抹掉压在左翼的
 *   「v2.6」；Flash 用 V2.6 推文封面的侧面蓝翼蝴蝶。两枚靠颜色与姿态区分，16px 下也分得开，原来的 Pro / Flash
 *   字样在 20px 以下读不出）。
 * - gpt-astra / gpt-sol / gpt-luna：developers.openai.com 模型页三张旗舰横幅的无字底图（/images/api/models/
 *   <id>-texture.webp）——把星系、太阳、月亮抠出来缩到方图约三分之一，放在同图取样的星空底上；
 *   月亮在原图里被右缘切掉一截，按左半镜像补成整轮（2026-10-25 用户：「月亮和太阳的占比放小一点」）；
 * - qwen3.8-max / qwen3.8-flash：千问 AI 平台模型市场（qianwenai.com/models）顶部轮播的两张封面
 *   （绿草几何体、彩色羽流）裁方，正中贴白色千问标（与 DeepSeek 两枚贴鲸鱼同一做法；标宽约方图的 74%——46% 时用户嫌太小、比过 58 / 66 / 74% 后选了 74%，
 *   下方一层柔和投影——Flash 的底是浅色，纯白标会糊进去）；
 * - qwen3.8-27b：千问公众号「Qwen3.8-27B 开源」正文头图（2048×1152，推文封面是 2.35:1 裁过的、会切掉设备上下沿），
 *   裁出完整的三台设备与地平线（避开右边的标题字）；
 * - minimax-m3.1-flash：MiniMax 公众号「M3.1 Flash 开源」封面，背景是虚化的花，把压在上面的白字按周边
 *   像素扩散抹掉再裁花心。
 * 位图按 96px 存：菜单 20px、设置页 18px，Retina 下也有富余。
 */
const OWN_AVATARS: Record<ModelAvatarKey, string> = {
  "kimi-k3.1": kimiK31,
  "kimi-k3": kimiK3,
  "glm-5.3": glm53,
  "glm-5.3-flash": glm53Flash,
  "deepseek-v4-pro": deepseekV4Pro,
  "deepseek-v4.1-flash": deepseekV41Flash,
  "step-5-preview": step5Preview,
  "claude-fable": claudeFable,
  "claude-opus": claudeOpus,
  "claude-sonnet": claudeSonnet,
  "claude-haiku": claudeHaiku,
  "mimo-v2.6-pro": mimoPro,
  "mimo-v2.6-flash": mimoFlash,
  "gpt-astra": gptAstra,
  "gpt-sol": gptSol,
  "gpt-luna": gptLuna,
  "qwen3.8-max": qwen38Max,
  "qwen3.8-flash": qwen38Flash,
  "qwen3.8-27b": qwen3827b,
  "minimax-m3.1-flash": minimaxM31Flash,
};

/**
 * 型号头像，三级先到先得：专属头像 > 家族图标（按 id 前缀）> 服务商图标。
 * 第三级要看服务商条目，由调用方给（`provider`：railVendorCell 那一套 kindId / label）——
 * 每个服务商都有图标，所以这一级必有结果，不需要「首字」兜底。
 * 只看（服务商条目, 型号 id），不联网。
 */
export function ModelAvatar(props: {
  modelId: string;
  provider: { kindId: string; label: string };
  size: number;
}): React.ReactNode {
  const ref = modelAvatarOf(props.modelId);
  const box = { width: props.size, height: props.size };
  if (ref?.kind === "own") {
    return (
      <span className="model-avatar own" aria-hidden="true" style={box}>
        <img src={OWN_AVATARS[ref.key]} alt="" draggable={false} />
      </span>
    );
  }
  const kindId = ref?.kind === "family" ? ref.logo : props.provider.kindId;
  return (
    <span className="model-avatar" aria-hidden="true" style={box}>
      {/* 标在方块里留出边距：70% 与原型 20px 方块里 14px 的标同比例 */}
      <VendorLogo kindId={kindId} label={props.provider.label} size={Math.round(props.size * 0.7)} />
    </span>
  );
}
