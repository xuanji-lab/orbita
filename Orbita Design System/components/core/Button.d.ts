export interface ButtonProps {
  /** primary = near-black neutral fill; accent = the theme accent (blue on light, yellow on dark), reserved for the one primary action on screen. */
  variant?: "primary" | "secondary" | "danger" | "ghost" | "accent";
  /** sm = 32px, md = 36px. */
  buttonSize?: "sm" | "md";
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  disabled?: boolean;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  title?: string;
}
