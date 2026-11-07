import { primeChatGptConnection } from '@seo/ai';

/** Node-only start-up work, imported by `instrumentation.ts`. */
export async function registerNode(): Promise<void> {
  try {
    await primeChatGptConnection();
  } catch (err) {
    // The app still boots without it; the state loads lazily on the first AI call instead.
    console.warn('[instrumentation] could not load the ChatGPT connection state:', err instanceof Error ? err.message : err);
  }
}
