import { useSystemTheme } from "./useSystemTheme";

/**
 * 应用外壳。骨架阶段只证明三件事：窗口起得来、设计系统 token 生效、深浅主题跟随系统。
 * 五屏（首页 / 任务 / 审批 / 设置+模型 / 窄窗+暗色）随功能 PR 逐屏落地。
 */
export function App() {
  useSystemTheme();

  return (
    <main
      style={{
        height: "100%",
        display: "grid",
        placeContent: "center",
        justifyItems: "center",
        gap: "var(--space-4)",
        padding: "var(--space-8)",
        textAlign: "center",
      }}
    >
      <h1
        style={{
          margin: 0,
          fontFamily: "var(--font-family-brand)",
          fontSize: "var(--font-size-logo)",
          fontWeight: "var(--weight-regular)",
          letterSpacing: "-0.01em",
        }}
      >
        orbita
      </h1>

      {/* 品牌标语保持中文，其余界面文案一律英文（设计系统内容规范） */}
      <p
        style={{
          margin: 0,
          fontFamily: "var(--text-slogan-family)",
          fontSize: "var(--font-size-brand)",
          letterSpacing: "var(--tracking-slogan)",
          color: "var(--color-text-secondary)",
        }}
      >
        璇玑运转，诸事得序
      </p>

      <p
        style={{
          margin: 0,
          maxWidth: "44ch",
          fontSize: "var(--font-size-caption)",
          lineHeight: "var(--line-height-caption)",
          color: "var(--color-text-tertiary)",
        }}
      >
        Shell only. The agent runtime, provider settings and the five screens land one pull request at
        a time.
      </p>
    </main>
  );
}
