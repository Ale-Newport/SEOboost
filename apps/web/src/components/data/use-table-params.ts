'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@seo/shared/constants';

export type SortOrder = 'asc' | 'desc';

/**
 * The URL is the single source of truth for list state, so a refresh, a back button and a pasted
 * link all reproduce the same screen — and so server components can read the same values from
 * `searchParams` without a second client round-trip.
 */
export const TABLE_PARAM_KEYS = {
  page: 'page',
  pageSize: 'pageSize',
  sort: 'sort',
  order: 'order',
  search: 'search',
} as const;

/** Params owned by other widgets on the page; never rendered as filter pills. */
const DEFAULT_RESERVED_KEYS = [
  ...Object.values(TABLE_PARAM_KEYS),
  // date-range-picker
  'from',
  'to',
  'days',
  'compare',
  // common layout state
  'tab',
  'view',
  'id',
] as const;

export type ParamValue = string | number | boolean | readonly string[] | null | undefined;

export type ParamPatch = Record<string, ParamValue>;

export interface ActiveFilterEntry {
  key: string;
  values: string[];
}

export interface UseTableParamsOptions {
  defaultPageSize?: number;
  defaultSort?: string | null;
  defaultOrder?: SortOrder;
  /** Extra keys to exclude from `filters` / `activeFilters` on top of the built-in list. */
  reservedKeys?: readonly string[];
  /** Delay before a keystroke reaches the URL. Long enough to not thrash, short enough to feel live. */
  searchDebounceMs?: number;
}

export interface TableParamsApi {
  page: number;
  pageSize: number;
  sort: string | null;
  order: SortOrder;
  /** The committed (in-URL) search term — this is what a server query should use. */
  search: string;
  /** The un-debounced value to bind to the search input. */
  searchInput: string;
  setSearch: (value: string) => void;

  /** Every non-reserved param, multi-valued. */
  filters: Readonly<Record<string, string[]>>;
  activeFilters: ActiveFilterEntry[];
  hasActiveFilters: boolean;

  getParam: (key: string) => string | null;
  getParamList: (key: string) => string[];
  /** Writes params without touching `page`. */
  setParams: (patch: ParamPatch) => void;
  /** Writes one param and resets to page 1 — the behaviour every filter wants. */
  setFilter: (key: string, value: ParamValue) => void;
  /** Writes several params at once and resets to page 1 (a date range is three params). */
  setFilters: (patch: ParamPatch) => void;
  toggleFilterValue: (key: string, value: string) => void;
  clearFilter: (key: string) => void;
  clearFilters: () => void;

  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  setSort: (id: string | null, order?: SortOrder) => void;
  toggleSort: (id: string, initialOrder?: SortOrder) => void;

  /** Drops every table param and every filter, keeping reserved params owned by other widgets. */
  reset: () => void;
  /** Current query string, handy for building export or API URLs. */
  queryString: string;
}

/** `1`, `'2'`, `'abc'` → a page number that is always ≥ 1. */
function parsePage(raw: string | null): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

function parsePageSize(raw: string | null, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), MAX_PAGE_SIZE);
}

function parseOrder(raw: string | null, fallback: SortOrder): SortOrder {
  return raw === 'asc' || raw === 'desc' ? raw : fallback;
}

/** Empty string, null and empty arrays all mean "remove this param". */
function applyPatch(params: URLSearchParams, patch: ParamPatch): void {
  for (const [key, value] of Object.entries(patch)) {
    params.delete(key);
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry !== '') params.append(key, entry);
      }
      continue;
    }
    params.set(key, String(value));
  }
}

/**
 * The query string this hook has written but that `useSearchParams` has not caught up to yet.
 *
 * `router.replace` is asynchronous: nothing observable changes until the navigation commits, which
 * for a server component means a round-trip. Any second write inside that window would re-read the
 * *pre-navigation* params and silently drop the first — ticking two facet checkboxes in a row (the
 * popover deliberately stays open for exactly that), or typing in a text filter while a facet is
 * still settling. State lives at module scope rather than in a ref because the controls are
 * independent components, each with its own `useTableParams`, all describing the same one URL.
 *
 * Browser-only: on the server this module is shared between concurrent requests, so it is never
 * read or written there (and `commit` only ever runs from an event handler anyway).
 */
let pendingWrite: { pathname: string; query: string; written: Set<string> } | null = null;

/** The query string later writes must build on: our own un-landed write, or the real URL. */
function effectiveQuery(pathname: string, actual: string): string {
  if (typeof window === 'undefined') return actual;
  if (pendingWrite === null) return actual;
  if (pendingWrite.pathname !== pathname) {
    // Left the screen the write belonged to; it can never land here.
    pendingWrite = null;
    return actual;
  }
  if (!pendingWrite.written.has(actual)) {
    // The URL moved somewhere we did not put it — external navigation supersedes our write.
    pendingWrite = null;
    return actual;
  }
  if (actual === pendingWrite.query) {
    pendingWrite = null;
    return actual;
  }
  return pendingWrite.query;
}

/**
 * How many un-landed writes to remember. The set only grows while navigations are outstanding, so
 * this is a backstop against a router that never settles rather than a routine limit.
 */
const MAX_PENDING_WRITES = 32;

function recordWrite(pathname: string, base: string, query: string): void {
  if (typeof window === 'undefined') return;
  const written = pendingWrite !== null && pendingWrite.pathname === pathname ? pendingWrite.written : new Set([base]);
  written.add(query);
  while (written.size > MAX_PENDING_WRITES) {
    const oldest = written.values().next();
    if (oldest.done === true) break;
    written.delete(oldest.value);
  }
  pendingWrite = { pathname, query, written };
}

export function useTableParams(options: UseTableParamsOptions = {}): TableParamsApi {
  const {
    defaultPageSize = DEFAULT_PAGE_SIZE,
    defaultSort = null,
    defaultOrder = 'desc',
    reservedKeys,
    searchDebounceMs = 300,
  } = options;

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();

  /**
   * `commit` must stay referentially stable (it is a dependency of the debounce effect and of
   * every filter callback) yet always build on the newest params, including a write that has not
   * landed in the URL yet — hence the ref, kept in step with the shared pending write above.
   */
  const queryRef = useRef(queryString);
  queryRef.current = effectiveQuery(pathname, queryString);

  const commit = useCallback(
    (patch: ParamPatch, resetPage = false): void => {
      const base = queryRef.current;
      const next = new URLSearchParams(base);
      applyPatch(next, patch);
      if (resetPage) next.delete(TABLE_PARAM_KEYS.page);

      const query = next.toString();
      if (query === base) return;

      queryRef.current = query;
      recordWrite(pathname, base, query);
      // `replace` (not `push`) so filtering does not bury the previous page in history, and
      // `scroll: false` so the viewport stays put while the user tweaks a filter.
      router.replace(query.length > 0 ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router],
  );

  const page = parsePage(searchParams.get(TABLE_PARAM_KEYS.page));
  const pageSize = parsePageSize(searchParams.get(TABLE_PARAM_KEYS.pageSize), defaultPageSize);
  const sort = searchParams.get(TABLE_PARAM_KEYS.sort) ?? defaultSort;
  const order = parseOrder(searchParams.get(TABLE_PARAM_KEYS.order), defaultOrder);
  const search = searchParams.get(TABLE_PARAM_KEYS.search) ?? '';

  const [searchInput, setSearchInput] = useState(search);
  /** The last value this hook wrote (or adopted), used to tell our own writes from external ones. */
  const committedSearch = useRef(search);

  // External navigation (back button, a link, a reset elsewhere) wins over the local draft.
  useEffect(() => {
    if (search !== committedSearch.current) {
      committedSearch.current = search;
      setSearchInput(search);
    }
  }, [search]);

  useEffect(() => {
    if (searchInput === committedSearch.current) return;
    const timer = window.setTimeout(() => {
      committedSearch.current = searchInput;
      commit({ [TABLE_PARAM_KEYS.search]: searchInput }, true);
    }, searchDebounceMs);
    return () => window.clearTimeout(timer);
  }, [searchInput, searchDebounceMs, commit]);

  const reserved = useMemo(
    () => new Set<string>([...DEFAULT_RESERVED_KEYS, ...(reservedKeys ?? [])]),
    [reservedKeys],
  );

  const filters = useMemo<Record<string, string[]>>(() => {
    const out: Record<string, string[]> = {};
    for (const key of new Set(searchParams.keys())) {
      if (reserved.has(key)) continue;
      const values = searchParams.getAll(key).filter((value) => value !== '');
      if (values.length > 0) out[key] = values;
    }
    return out;
  }, [searchParams, reserved]);

  const activeFilters = useMemo<ActiveFilterEntry[]>(
    () => Object.entries(filters).map(([key, values]) => ({ key, values })),
    [filters],
  );

  const getParam = useCallback((key: string): string | null => searchParams.get(key), [searchParams]);
  const getParamList = useCallback((key: string): string[] => searchParams.getAll(key), [searchParams]);

  const setParams = useCallback((patch: ParamPatch): void => commit(patch, false), [commit]);
  const setFilter = useCallback(
    (key: string, value: ParamValue): void => commit({ [key]: value }, true),
    [commit],
  );
  const setFilters = useCallback((patch: ParamPatch): void => commit(patch, true), [commit]);

  const toggleFilterValue = useCallback(
    (key: string, value: string): void => {
      const current = new URLSearchParams(queryRef.current).getAll(key);
      const next = current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value];
      commit({ [key]: next }, true);
    },
    [commit],
  );

  const clearFilter = useCallback((key: string): void => commit({ [key]: null }, true), [commit]);

  const clearFilters = useCallback((): void => {
    const patch: ParamPatch = {};
    for (const key of new Set(new URLSearchParams(queryRef.current).keys())) {
      if (!reserved.has(key)) patch[key] = null;
    }
    commit(patch, true);
  }, [commit, reserved]);

  const setPage = useCallback(
    (value: number): void => commit({ [TABLE_PARAM_KEYS.page]: value <= 1 ? null : value }),
    [commit],
  );

  const setPageSize = useCallback(
    (value: number): void =>
      commit({ [TABLE_PARAM_KEYS.pageSize]: value === defaultPageSize ? null : value }, true),
    [commit, defaultPageSize],
  );

  const setSort = useCallback(
    (id: string | null, nextOrder: SortOrder = defaultOrder): void =>
      commit({ [TABLE_PARAM_KEYS.sort]: id, [TABLE_PARAM_KEYS.order]: id === null ? null : nextOrder }, true),
    [commit, defaultOrder],
  );

  const toggleSort = useCallback(
    (id: string, initialOrder: SortOrder = 'desc'): void => {
      const currentSort = new URLSearchParams(queryRef.current).get(TABLE_PARAM_KEYS.sort) ?? defaultSort;
      const currentOrder = parseOrder(
        new URLSearchParams(queryRef.current).get(TABLE_PARAM_KEYS.order),
        defaultOrder,
      );
      const nextOrder: SortOrder = currentSort === id ? (currentOrder === 'asc' ? 'desc' : 'asc') : initialOrder;
      commit({ [TABLE_PARAM_KEYS.sort]: id, [TABLE_PARAM_KEYS.order]: nextOrder }, true);
    },
    [commit, defaultOrder, defaultSort],
  );

  const reset = useCallback((): void => {
    const tableKeys = Object.values(TABLE_PARAM_KEYS) as string[];
    const patch: ParamPatch = {};
    for (const key of new Set(new URLSearchParams(queryRef.current).keys())) {
      if (!reserved.has(key) || tableKeys.includes(key)) patch[key] = null;
    }
    committedSearch.current = '';
    setSearchInput('');
    commit(patch, true);
  }, [commit, reserved]);

  return {
    page,
    pageSize,
    sort,
    order,
    search,
    searchInput,
    setSearch: setSearchInput,
    filters,
    activeFilters,
    hasActiveFilters: activeFilters.length > 0,
    getParam,
    getParamList,
    setParams,
    setFilter,
    setFilters,
    toggleFilterValue,
    clearFilter,
    clearFilters,
    setPage,
    setPageSize,
    setSort,
    toggleSort,
    reset,
    queryString,
  };
}

/**
 * A text input bound to one URL param with the same debounce as the table search box.
 * Returns the live draft plus the setter; the URL catches up `delay` ms after typing stops.
 */
export function useDebouncedParam(key: string, delay = 300): [string, (value: string) => void] {
  const { getParam, setFilter } = useTableParams();
  const committed = getParam(key) ?? '';

  const [draft, setDraft] = useState(committed);
  const lastCommitted = useRef(committed);

  useEffect(() => {
    if (committed !== lastCommitted.current) {
      lastCommitted.current = committed;
      setDraft(committed);
    }
  }, [committed]);

  useEffect(() => {
    if (draft === lastCommitted.current) return;
    const timer = window.setTimeout(() => {
      lastCommitted.current = draft;
      setFilter(key, draft);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [draft, delay, key, setFilter]);

  return [draft, setDraft];
}
