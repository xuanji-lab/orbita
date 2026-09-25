import type { ThemePreference } from "@shared/settings";
import { useT } from "../../locale.ts";
import { heroFace, sloganCells, sloganOf } from "./home-hero.ts";
import { useToday } from "./today.ts";

/**
 * 首页门面：slogan，纸面两档再加一行红笔批语。
 *
 * - 普通主题：品牌衬线一行「璇玑运转，诸事得序」，与以前一样。
 * - Copybook（小学作业）：slogan 一字一格落进红田字格（马善政），下面老师的红笔批语「字迹工整　阅 9.25」。
 * - Typescript：英文 slogan「Set in motion, kept in order.」（Special Elite），左边红页边线、
 *   底下一条蓝横线，下面红笔批语「Neat. — Sept 25」。
 * - 批语的日期是**今天**，过了午夜自己翻篇（today.ts）。
 *
 * 样子全在 CSS（styles.css 的 .home-slogan、paper-themes.css 的纸面两档）；这里只决定
 * 写哪句话、拆不拆格、有没有批语。批语与格子是装饰，读屏只读 slogan 本身。
 */
export function HomeHero(props: { theme?: Exclude<ThemePreference, "system"> }) {
  const t = useT();
  const today = useToday();
  const face = heroFace(props.theme);
  const slogan = sloganOf(face);
  return (
    <div className="home-hero" data-face={face}>
      <h1 className="home-slogan" aria-label={face === "copybook" ? slogan : undefined}>
        {face === "copybook"
          ? sloganCells(slogan).map((cell, index) => (
              <span
                key={index}
                aria-hidden="true"
                className={cell.punct ? "home-slogan-cell punct" : "home-slogan-cell"}
              >
                {cell.char}
              </span>
            ))
          : slogan}
      </h1>
      {face !== "plain" && (
        <p className="home-mark" aria-hidden="true">
          {t.chat.homeMark(today.month, today.day)}
        </p>
      )}
    </div>
  );
}
