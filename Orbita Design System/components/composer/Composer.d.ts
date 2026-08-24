export interface ComposerProps {
  value?: string;
  onChange?: (value: string) => void;
  /** Fired on Enter (Shift+Enter inserts a newline) and on the send button. */
  onSubmit?: (value: string) => void;
  placeholder?: string;
  /** Chips above the text area — scope / project. */
  topSlot?: React.ReactNode;
  /** Chips below the text area — permission, model, effort. */
  bottomSlot?: React.ReactNode;
  rows?: number;
  disabled?: boolean;
  /** Swaps the accent send button for the quiet stop button. */
  running?: boolean;
  style?: React.CSSProperties;
}
