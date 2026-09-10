/**
 * Website adapters — the layer that deploys approved SEO changes to a customer's site.
 *
 * Import order matters only for readability: contracts first, then the shared HTTP/parsing
 * plumbing, then one module per platform, then the resolution and execution layers that
 * sit on top of them. `applyChange` in `./apply` is the only entry point callers outside
 * this folder should need for writes.
 */

export * from './types';
export * from './http';
export * from './frontmatter';
export * from './wordpress';
export * from './git';
export * from './webhook';
export * from './shopify';
export * from './webflow';
export * from './registry';
export * from './apply';
