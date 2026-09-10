import { z, type ZodTypeAny } from 'zod';

/**
 * Query-string coercion helpers shared by the list endpoints.
 *
 * `z.coerce.boolean()` is deliberately not used anywhere in this codebase: it follows JS
 * truthiness, so the string `"false"` becomes `true` and every "show only indexable pages"
 * filter would silently invert. These helpers parse the wire format the UI actually sends.
 */

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

/** `?orphan=true` / `?orphan=0`. Anything else is a validation error, never a silent default. */
export const booleanParam = z
  .union([z.boolean(), z.string()])
  .transform((value, ctx) => {
    if (typeof value === 'boolean') return value;
    const normalized = value.trim().toLowerCase();
    if (TRUE_VALUES.has(normalized)) return true;
    if (FALSE_VALUES.has(normalized)) return false;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected true or false' });
    return z.NEVER;
  });

/**
 * Accepts `?severity=HIGH&severity=LOW`, `?severity=HIGH,LOW` or a single value, and validates
 * every entry against `item`. Empty strings are dropped rather than failing the request, so a
 * cleared filter chip behaves like no filter at all.
 */
export function listParam<T extends ZodTypeAny>(item: T) {
  return z
    .union([z.string(), z.array(z.string())])
    .transform((value) =>
      (Array.isArray(value) ? value : value.split(','))
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    )
    .pipe(z.array(item));
}

/** A positive integer from the query string, e.g. `?minWordCount=300`. */
export const intParam = z.coerce.number().int();

/** A finite number from the query string, e.g. `?positionMax=20.5`. */
export const floatParam = z.coerce.number().finite();

/** `?format=csv` on any list endpoint switches it to a download. */
export const formatParam = z.enum(['json', 'csv']).default('json');
