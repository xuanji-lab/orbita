// 生成 mobile/src/theme/tokens.gen.ts（在 mobile/ 下跑：`bun run gen`）
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { metrics, renderTokensModule, themeColors } from "./tokens.ts";

export const TOKENS_DIR = join(import.meta.dirname, "..", "..", "design-system", "tokens");
export const TOKENS_OUT = join(import.meta.dirname, "..", "src", "theme", "tokens.gen.ts");

export function buildTokensModule(): string {
  const read = (name: string): string => readFileSync(join(TOKENS_DIR, name), "utf8");
  return renderTokensModule({
    colors: themeColors(read("colors.css"), read("glass.css")),
    metrics: metrics([read("spacing.css"), read("typography.css")]),
  });
}

if (process.argv[1] === import.meta.filename) {
  writeFileSync(TOKENS_OUT, buildTokensModule());
  console.log(`写好了 ${TOKENS_OUT}`);
}
