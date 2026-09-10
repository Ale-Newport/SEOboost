/**
 * Google integration barrel — one OAuth grant, two products.
 *
 * `oauth` owns the grant (consent URL, code exchange, encrypted token storage, refresh);
 * `search-console` and `analytics` are the two read surfaces built on top of it.
 */

export * from './oauth';
export * from './search-console';
export * from './analytics';
