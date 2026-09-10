'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import { Label } from './label';

interface FormFieldContextValue {
  controlId: string;
  labelId: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}

const FormFieldContext = React.createContext<FormFieldContextValue | null>(null);

interface FormControlOwnProps {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: React.AriaAttributes['aria-invalid'];
  required?: boolean;
}

/**
 * Lets every control in this library pick up the id, description and error
 * wiring from an enclosing `FormField` without the consumer repeating
 * `aria-describedby` by hand. Props passed explicitly always win, and the hook
 * is a no-op outside a `FormField` so controls stay usable standalone.
 */
export function useFormControl(own: FormControlOwnProps): FormControlOwnProps {
  const field = React.useContext(FormFieldContext);
  if (!field) return own;

  const describedBy = [field.describedBy, own['aria-describedby']].filter(Boolean).join(' ');

  return {
    id: own.id ?? field.controlId,
    'aria-describedby': describedBy.length > 0 ? describedBy : undefined,
    'aria-invalid': own['aria-invalid'] ?? (field.invalid ? true : undefined),
    required: own.required ?? (field.required || undefined),
  };
}

interface FormGroupAria {
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: React.AriaAttributes['aria-invalid'];
}

/**
 * The group equivalent of `useFormControl`, for composite controls such as a
 * radio group where a `<label for>` cannot point at a single element — the
 * group is labelled by reference instead.
 */
export function useFormGroup(own: FormGroupAria): FormGroupAria {
  const field = React.useContext(FormFieldContext);
  if (!field) return own;

  const describedBy = [field.describedBy, own['aria-describedby']].filter(Boolean).join(' ');

  return {
    'aria-labelledby': own['aria-labelledby'] ?? field.labelId,
    'aria-describedby': describedBy.length > 0 ? describedBy : undefined,
    'aria-invalid': own['aria-invalid'] ?? (field.invalid ? true : undefined),
  };
}

export interface FormFieldProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  label: React.ReactNode;
  /** Supply when the control renders its own id (e.g. a radio group). */
  htmlFor?: string;
  description?: React.ReactNode;
  /** Presence of an error marks the control `aria-invalid` and announces it. */
  error?: React.ReactNode;
  required?: boolean;
  /** Keeps the label for screen readers only — for toolbars and dense filters. */
  hideLabel?: boolean;
  children: React.ReactNode;
}

/**
 * Label + description + error wrapper. Owns the ids so the control it wraps is
 * always correctly associated, which is the part hand-rolled forms get wrong.
 */
const FormField = React.forwardRef<HTMLDivElement, FormFieldProps>(function FormField(
  { label, htmlFor, description, error, required = false, hideLabel = false, className, children, ...props },
  ref,
) {
  const reactId = React.useId();
  const controlId = htmlFor ?? `${reactId}-control`;
  const labelId = `${reactId}-label`;
  const descriptionId = `${reactId}-description`;
  const errorId = `${reactId}-error`;

  const describedBy = [description ? descriptionId : null, error ? errorId : null].filter(Boolean).join(' ');

  const context = React.useMemo<FormFieldContextValue>(
    () => ({
      controlId,
      labelId,
      describedBy: describedBy.length > 0 ? describedBy : undefined,
      invalid: Boolean(error),
      required,
    }),
    [controlId, labelId, describedBy, error, required],
  );

  return (
    <div ref={ref} className={cn('space-y-1.5', className)} {...props}>
      <Label id={labelId} htmlFor={controlId} className={cn(hideLabel && 'sr-only')}>
        {label}
        {required ? (
          <span className="ml-0.5 text-destructive" aria-hidden="true">
            *
          </span>
        ) : null}
      </Label>

      {description ? (
        <p id={descriptionId} className="text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}

      <FormFieldContext.Provider value={context}>{children}</FormFieldContext.Provider>

      {error ? (
        <p id={errorId} role="alert" className="text-xs font-medium leading-relaxed text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
});

export { FormField };
