export interface IconButtonProps {
  /** Required accessible name; also the default tooltip. */
  label: string;
  variant?: "ghost" | "outline" | "soft";
  /** sm = 32px square, md = 36px square. */
  buttonSize?: "sm" | "md";
  /** Pressed / expanded state for toggles. */
  active?: boolean;
  disabled?: boolean;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children?: React.ReactNode;
  title?: string;
  style?: React.CSSProperties;
}
