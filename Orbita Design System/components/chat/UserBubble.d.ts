export interface UserBubbleProps {
  /** Message text; newlines are preserved. */
  children?: React.ReactNode;
  /** Timestamp shown under the bubble in the tabular face. */
  time?: string;
  /** Delivery mode label — "steer" reads accent, "follow-up" reads info blue. */
  delivery?: "steer" | "follow-up";
  /** Image attachment srcs, rendered as 64px thumbnails above the bubble. */
  attachments?: string[];
  style?: React.CSSProperties;
}
