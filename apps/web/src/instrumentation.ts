/**
 * Next.js server start hook.
 *
 * AI availability (`isAiAvailable()`) is answered synchronously, so the "Sign in with ChatGPT"
 * connection state is loaded once when the server starts and then refreshed in the background.
 * The work lives in a separate module imported only under the Node runtime check — Next's
 * documented pattern — because the edge compilation of this file must never see `@seo/ai`
 * (Prisma and `node:crypto`).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNode } = await import('./instrumentation-node');
    await registerNode();
  }
}
