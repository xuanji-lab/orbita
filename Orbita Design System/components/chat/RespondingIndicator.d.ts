export interface RespondingIndicatorProps {
  /** Status words — the signal is the wording, not the colour. */
  label?: string;
  tone?: "running" | "waiting" | "error";
  style?: React.CSSProperties;
}
