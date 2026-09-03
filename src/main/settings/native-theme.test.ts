import { deepStrictEqual, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { THEME_PREFERENCES } from "../../shared/settings.ts";
import { resolveNativeThemeSource } from "./native-theme.ts";

describe("resolveNativeThemeSource", () => {
  it("black 映射成 dark——nativeTheme 只认三档", () => {
    deepStrictEqual(resolveNativeThemeSource("black"), "dark");
  });

  it("其余档原样透传", () => {
    for (const theme of THEME_PREFERENCES.filter((t) => t !== "black")) {
      deepStrictEqual(resolveNativeThemeSource(theme), theme);
    }
  });

  it("任何档位进来的返回值都落在 nativeTheme 认的三档里", () => {
    for (const theme of THEME_PREFERENCES) {
      ok(["system", "light", "dark"].includes(resolveNativeThemeSource(theme)));
    }
  });
});
