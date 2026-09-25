import { deepStrictEqual, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { THEME_PREFERENCES } from "../../shared/settings.ts";
import { resolveNativeThemeSource } from "./native-theme.ts";

describe("resolveNativeThemeSource", () => {
  it("black 映射成 dark——nativeTheme 只认三档", () => {
    deepStrictEqual(resolveNativeThemeSource("black"), "dark");
  });

  it("稿纸两档映射成 light——它们只有明", () => {
    deepStrictEqual(resolveNativeThemeSource("manuscript"), "light");
    deepStrictEqual(resolveNativeThemeSource("typescript"), "light");
  });

  it("其余档原样透传", () => {
    for (const theme of ["system", "light", "dark"] as const) {
      deepStrictEqual(resolveNativeThemeSource(theme), theme);
    }
  });

  it("任何档位进来的返回值都落在 nativeTheme 认的三档里", () => {
    for (const theme of THEME_PREFERENCES) {
      ok(["system", "light", "dark"].includes(resolveNativeThemeSource(theme)));
    }
  });
});
