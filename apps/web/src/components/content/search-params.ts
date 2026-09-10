/**
 * Reading list state out of `searchParams`.
 *
 * The content screens keep filters, sort and pagination in the URL (see `useTableParams`), so the
 * server has to parse exactly the same shape the client writes: a repeated param arrives as an
 * array, a single one as a string, an absent one as `undefined`.
 */

export type RawSearchParams = Record<string, string | string[] | undefined>;

export function paramList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.filter((entry) => entry.length > 0);
  return value === undefined || value.length === 0 ? [] : [value];
}

export function paramValue(value: string | string[] | undefined): string | undefined {
  const [first] = paramList(value);
  return first;
}

export function paramInt(value: string | string[] | undefined, fallback: number): number {
  const parsed = Number(paramValue(value));
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

export function paramNumber(value: string | string[] | undefined): number | undefined {
  const raw = paramValue(value);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Keeps only the values that are members of `allowed`; returns `undefined` when none survive. */
export function paramEnums<T extends string>(
  value: string | string[] | undefined,
  allowed: readonly T[],
): T[] | undefined {
  const wanted = paramList(value).filter((entry): entry is T => (allowed as readonly string[]).includes(entry));
  return wanted.length > 0 ? wanted : undefined;
}
