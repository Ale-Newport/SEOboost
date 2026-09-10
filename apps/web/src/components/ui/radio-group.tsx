'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import { useFormGroup } from './form-field';

/*
 * `@radix-ui/react-radio-group` is not a dependency of this app, so this is built
 * on native `<input type="radio">`. That is a feature, not a fallback: native
 * radios already give us roving arrow-key navigation, form participation and
 * correct screen-reader semantics for free — we only restyle the control.
 */

interface RadioGroupContextValue {
  name: string;
  value: string | undefined;
  onValueChange: ((value: string) => void) | undefined;
  disabled: boolean;
  required: boolean;
}

const RadioGroupContext = React.createContext<RadioGroupContextValue | null>(null);

function useRadioGroup(component: string): RadioGroupContextValue {
  const context = React.useContext(RadioGroupContext);
  if (!context) throw new Error(`${component} must be rendered inside a <RadioGroup>`);
  return context;
}

export interface RadioGroupProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange' | 'defaultValue'> {
  /** Shared radio `name`; generated when omitted so two groups never collide. */
  name?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  orientation?: 'vertical' | 'horizontal';
}

const RadioGroup = React.forwardRef<HTMLDivElement, RadioGroupProps>(function RadioGroup(
  {
    className,
    name,
    value: valueProp,
    defaultValue,
    onValueChange,
    disabled = false,
    required = false,
    orientation = 'vertical',
    ...props
  },
  ref,
) {
  const generatedName = React.useId();
  const [uncontrolled, setUncontrolled] = React.useState<string | undefined>(defaultValue);
  const isControlled = valueProp !== undefined;
  const value = isControlled ? valueProp : uncontrolled;

  const handleChange = React.useCallback(
    (next: string) => {
      if (!isControlled) setUncontrolled(next);
      onValueChange?.(next);
    },
    [isControlled, onValueChange],
  );

  const context = React.useMemo<RadioGroupContextValue>(
    () => ({ name: name ?? generatedName, value, onValueChange: handleChange, disabled, required }),
    [name, generatedName, value, handleChange, disabled, required],
  );

  // A `<label for>` cannot address a radiogroup, so an enclosing FormField
  // labels it by reference instead.
  const group = useFormGroup(props);

  return (
    <RadioGroupContext.Provider value={context}>
      <div
        {...props}
        {...group}
        ref={ref}
        role="radiogroup"
        aria-orientation={orientation}
        aria-required={required || undefined}
        className={cn(orientation === 'horizontal' ? 'flex flex-wrap items-center gap-4' : 'grid gap-2', className)}
      />
    </RadioGroupContext.Provider>
  );
});

export interface RadioGroupItemProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'name' | 'checked' | 'value' | 'onChange'> {
  value: string;
}

const RadioGroupItem = React.forwardRef<HTMLInputElement, RadioGroupItemProps>(function RadioGroupItem(
  { className, value, disabled, ...props },
  ref,
) {
  const group = useRadioGroup('RadioGroupItem');

  return (
    <input
      {...props}
      ref={ref}
      type="radio"
      name={group.name}
      value={value}
      checked={group.value === value}
      disabled={disabled ?? group.disabled}
      required={group.required || undefined}
      onChange={(event) => {
        if (event.currentTarget.checked) group.onValueChange?.(value);
      }}
      className={cn(
        'peer size-4 shrink-0 cursor-pointer appearance-none rounded-full border border-input bg-background shadow-xs',
        'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'disabled:cursor-not-allowed disabled:opacity-50',
        // Inset ring in the surface colour turns the filled circle into a dot.
        'checked:border-primary checked:bg-primary checked:shadow-[inset_0_0_0_3px_hsl(var(--background))]',
        'aria-[invalid=true]:border-destructive',
        className,
      )}
    />
  );
});

/** Convenience row: control + label + optional helper copy, all click-targetable. */
export interface RadioGroupOptionProps extends Omit<RadioGroupItemProps, 'children'> {
  label: React.ReactNode;
  description?: React.ReactNode;
}

const RadioGroupOption = React.forwardRef<HTMLInputElement, RadioGroupOptionProps>(function RadioGroupOption(
  { label, description, className, id, ...props },
  ref,
) {
  const generatedId = React.useId();
  const controlId = id ?? generatedId;
  const descriptionId = description ? `${controlId}-description` : undefined;

  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <RadioGroupItem ref={ref} id={controlId} aria-describedby={descriptionId} className="mt-0.5" {...props} />
      <div className="grid gap-0.5">
        <label htmlFor={controlId} className="cursor-pointer text-sm font-medium leading-tight text-foreground">
          {label}
        </label>
        {description ? (
          <p id={descriptionId} className="text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
});

export { RadioGroup, RadioGroupItem, RadioGroupOption };
