/**
 * 取路径尾段做显示名。分隔符 `/` 与 `\` 都认——Windows 的 cwd / 工作区路径是反斜杠，
 * 只切 `/` 会整条漏出来。
 *
 * 老工作区落库的名可能是完整路径（早期创建没截尾），所以凡是**显示**工作区名/路径的
 * 地方（输入框 scope 芯片、左栏工作区行与菜单）都要过这一刀——显示层截尾，
 * 不动落库数据；改名（InlineName / 菜单）仍用原名。
 */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
}
