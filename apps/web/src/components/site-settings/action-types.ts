/**
 * Result shape for the settings server actions.
 *
 * It lives outside `actions.ts` because a `'use server'` module may only export async functions —
 * a type exported from there is a build error even though it is erased at runtime.
 */
export type SettingsActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };
