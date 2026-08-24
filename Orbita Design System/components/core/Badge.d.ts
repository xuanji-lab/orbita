export interface BadgeProps {
  variant?: "secondary" | "outline" | "muted" | "accent" | "info";
  badgeSize?: "sm" | "md";
  /** Tabular/mono face — for ids, counts, durations and model names. */
  mono?: boolean;
  children?: React.ReactNode;
  title?: string;
  style?: React.CSSProperties;
}
