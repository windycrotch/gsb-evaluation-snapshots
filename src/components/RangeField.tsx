import { type InputHTMLAttributes, type ReactNode, useId } from 'react';

interface RangeFieldProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'type' | 'value' | 'min' | 'max' | 'onChange'
  > {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  hint?: string;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
}

export function RangeField({
  label,
  value,
  min,
  max,
  hint,
  onChange,
  onCommit,
  className,
  id,
  'aria-describedby': ariaDescribedBy,
  ...props
}: RangeFieldProps) {
  const generatedId = useId();
  const inputId = id ?? `range-${generatedId}`;
  const hintId = `${inputId}-hint`;
  const descriptions = [ariaDescribedBy, hint ? hintId : null]
    .filter(Boolean)
    .join(' ');
  const commitValue = (next: number) => {
    onCommit?.(next);
  };

  return (
    <div className={className}>
      <div className="flex items-center justify-between text-xs text-slate-400">
        <label htmlFor={inputId}>{label}</label>
        <output htmlFor={inputId} className="font-medium text-slate-200">
          {value}
        </output>
      </div>
      <input
        id={inputId}
        className="app-control mt-1 min-h-10 w-full accent-sky-400"
        type="range"
        min={min}
        max={max}
        value={value}
        aria-describedby={descriptions || undefined}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerUp={(event) => commitValue(Number(event.currentTarget.value))}
        onPointerCancel={(event) =>
          commitValue(Number(event.currentTarget.value))
        }
        onKeyUp={(event) =>
          commitValue(Number((event.currentTarget as HTMLInputElement).value))
        }
        onBlur={(event) => commitValue(Number(event.currentTarget.value))}
        {...props}
      />
      {hint ? (
        <p id={hintId} className="mt-1 text-[11px] leading-4 text-slate-400">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
