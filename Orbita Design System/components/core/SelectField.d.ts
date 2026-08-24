export interface SelectFieldOption {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
}

export interface SelectFieldProps {
  label?: React.ReactNode;
  value: string;
  options: SelectFieldOption[];
  onChange?: (value: string) => void;
  description?: React.ReactNode;
  disabled?: boolean;
  style?: React.CSSProperties;
}
