import type { ReactNode } from "react";

/**
 * 首页门面：品牌衬线 slogan，全产品唯一一句抒情的话。
 *
 * 星系首页（原型 proto/home-galaxy）：`galaxy` 是星系名（= 工作区名，可点开选新任务放在哪），
 * 它当标题；slogan 退成下面一行轻一级的品牌衬线——像 Claude Projects 页面里项目名下的那句说明。
 * 不给 `galaxy` 就只有 slogan 一句。
 *
 * 样子全在 CSS（styles.css 的 .home-slogan / .home-galaxy-*）；这里只决定标题写不写星系名。
 * 纸面两档主题（小学作业 / 打字稿）已随主题一起删掉：门面不再按主题换脸，没有红笔批语。
 */
export function HomeHero(props: { galaxy?: ReactNode }) {
  if (props.galaxy !== undefined) {
    return (
      <div className="home-hero" data-galaxy="true">
        <h1 className="home-galaxy-head">{props.galaxy}</h1>
        <p className="home-slogan">璇玑运转，诸事得序</p>
      </div>
    );
  }
  return (
    <div className="home-hero">
      <h1 className="home-slogan">璇玑运转，诸事得序</h1>
    </div>
  );
}
