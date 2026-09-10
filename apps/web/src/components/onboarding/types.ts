/**
 * Shared shapes for the onboarding wizard.
 *
 * They live outside `actions.ts` because a `'use server'` module may only export async
 * functions — types exported from there would be a build error even though they are erased.
 */

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

/** The persisted site, flattened for the client. Empty strings, never null, so inputs stay controlled. */
export interface OnboardingWebsite {
  id: string;
  name: string;
  domain: string;
  protocol: 'https' | 'http';
  primaryLanguage: string;
  targetCountry: string;
  businessCategory: string;
  description: string;
  targetAudience: string;
  conversionGoal: string;
  brandName: string;
  competitors: string[];
  /** True once a Search Console integration for this site is in the CONNECTED state. */
  searchConsoleConnected: boolean;
}

export interface AiProviderOption {
  /** Registry key: `openai` | `anthropic` | `gemini`. */
  name: string;
  label: string;
  configured: boolean;
  /** The environment variable an operator must set to light this provider up. */
  envVar: string;
}

export interface GoogleSetup {
  configured: boolean;
  /** Exactly which variables are missing, so the step can name them. */
  missingEnvVars: string[];
}

export interface CrawlProgress {
  jobStatus: string | null;
  jobProgress: number;
  jobMessage: string | null;
  jobError: string | null;
  crawl: {
    id: string;
    status: string;
    pagesCrawled: number;
    pagesDiscovered: number;
    pagesFailed: number;
    issuesFound: number;
    progressMessage: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
  } | null;
}

export interface StartCrawlResult {
  /** Null when the durable row could not be identified — the UI then polls the site's crawls. */
  jobRecordId: string | null;
  /** False means no worker will pick this up; the message says exactly why. */
  enqueued: boolean;
  message: string;
}
