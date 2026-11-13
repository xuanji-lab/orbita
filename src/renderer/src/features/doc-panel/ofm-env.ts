/**
 * 阅读视图 / 编辑视图共用的「文档环境」：怎么把文档里的目标解析成真文件、点链接打开什么、找不到怎么说。
 * 一份文档一个环境，由 DocEditPane 建、两个视图读。
 */
import type { OfmResolved } from "../../../../shared/doc.ts";
import type { TargetResolver } from "./ofm-targets.ts";
import type { ImageScope } from "./ofm-images.ts";

export interface OfmEnv {
  resolver: TargetResolver;
  scope: ImageScope;
  /** 点击已解析的双链 / 非图片嵌入：在文件面板里打开 */
  onOpen: (target: NonNullable<OfmResolved>) => void;
  /** 点击找不到的双链：提示「找不到」（参数是显示的名字） */
  onMissing: (name: string) => void;
}
