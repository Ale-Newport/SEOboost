import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './constants';

/** Shared Zod schemas used by API routes, forms and AI structured outputs. */

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().trim().max(200).optional(),
});
export type PaginationInput = z.infer<typeof paginationSchema>;

export const dateRangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  days: z.coerce.number().int().min(1).max(480).optional(),
  compare: z.coerce.boolean().optional(),
});

const domainRegex = /^(?!:\/\/)([a-zA-Z0-9-_]+\.)+[a-zA-Z]{2,}$/;

export const domainSchema = z
  .string()
  .trim()
  .min(3)
  .max(253)
  .transform((v) =>
    v
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/\/.*$/, '')
      .toLowerCase(),
  )
  .refine((v) => domainRegex.test(v), { message: 'Enter a valid domain, e.g. example.com' });

export const urlSchema = z.string().trim().url().max(2048);

export const emailSchema = z.string().trim().toLowerCase().email().max(320);

export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200)
  .refine((v) => /[a-zA-Z]/.test(v) && /[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(v), {
    message: 'Include at least one letter and one number or symbol',
  });

export const createWebsiteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  domain: domainSchema,
  protocol: z.enum(['https', 'http']).default('https'),
  description: z.string().trim().max(2000).optional().or(z.literal('')),
  businessCategory: z.string().trim().max(120).optional().or(z.literal('')),
  targetAudience: z.string().trim().max(500).optional().or(z.literal('')),
  conversionGoal: z.string().trim().max(500).optional().or(z.literal('')),
  brandName: z.string().trim().max(120).optional().or(z.literal('')),
  primaryLanguage: z.string().trim().min(2).max(10).default('en'),
  targetLocales: z.array(z.string().min(2).max(10)).default(['en-US']),
  targetCountry: z.string().trim().min(2).max(3).default('USA'),
  cmsType: z
    .enum(['UNKNOWN','WORDPRESS','SHOPIFY','WEBFLOW','NEXTJS','ASTRO','HUGO','GHOST','SQUARESPACE','WIX','CUSTOM','GIT'])
    .default('UNKNOWN'),
  competitors: z.array(domainSchema).max(20).default([]),
  startCrawl: z.boolean().default(true),
});
export type CreateWebsiteInput = z.infer<typeof createWebsiteSchema>;

export const updateWebsiteSchema = createWebsiteSchema
  .partial()
  .omit({ competitors: true, startCrawl: true })
  .extend({
    status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']).optional(),
  });

export const websiteSettingsSchema = z.object({
  crawlMaxPages: z.coerce.number().int().min(1).max(500_000).optional(),
  crawlMaxDepth: z.coerce.number().int().min(1).max(30).optional(),
  crawlConcurrency: z.coerce.number().int().min(1).max(16).optional(),
  crawlDelayMs: z.coerce.number().int().min(0).max(10_000).optional(),
  crawlUserAgent: z.string().trim().min(3).max(200).optional(),
  crawlRespectRobots: z.boolean().optional(),
  crawlRenderJs: z.boolean().optional(),
  crawlIncludePatterns: z.array(z.string().max(500)).max(100).optional(),
  crawlExcludePatterns: z.array(z.string().max(500)).max(100).optional(),
  crawlTimeoutMs: z.coerce.number().int().min(1000).max(120_000).optional(),
  autonomyLevel: z
    .enum(['L0_INSIGHTS_ONLY', 'L1_DRAFTS_ONLY', 'L2_SAFE_TECHNICAL', 'L3_MOST_REVERSIBLE', 'L4_HIGH_AUTONOMY'])
    .optional(),
  autoApproveSafe: z.boolean().optional(),
  aiProvider: z.string().max(40).nullable().optional(),
  reasoningModel: z.string().max(80).nullable().optional(),
  fastModel: z.string().max(80).nullable().optional(),
  writingModel: z.string().max(80).nullable().optional(),
  embeddingModel: z.string().max(80).nullable().optional(),
  monthlyAiBudgetUsd: z.coerce.number().min(0).max(100_000).nullable().optional(),
  scheduleCrawl: z.string().max(60).nullable().optional(),
  scheduleGscSync: z.string().max(60).nullable().optional(),
  scheduleAnalysis: z.string().max(60).nullable().optional(),
  scheduleAiVisibility: z.string().max(60).nullable().optional(),
  scheduleReport: z.string().max(60).nullable().optional(),
  thinContentWords: z.coerce.number().int().min(50).max(3000).optional(),
  ctrOpportunityMinImpressions: z.coerce.number().int().min(1).max(1_000_000).optional(),
  strikingDistanceMin: z.coerce.number().min(1).max(100).optional(),
  strikingDistanceMax: z.coerce.number().min(1).max(100).optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(200),
});

export const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(120).optional(),
});

export const startCrawlSchema = z.object({
  maxPages: z.coerce.number().int().min(1).max(500_000).optional(),
  maxDepth: z.coerce.number().int().min(1).max(30).optional(),
  renderJs: z.boolean().optional(),
});

export const keywordImportSchema = z.object({
  keywords: z
    .array(
      z.object({
        keyword: z.string().trim().min(1).max(300),
        searchVolume: z.coerce.number().int().min(0).optional(),
        difficulty: z.coerce.number().min(0).max(100).optional(),
        cpc: z.coerce.number().min(0).optional(),
        locale: z.string().max(10).optional(),
        intent: z
          .enum(['INFORMATIONAL', 'NAVIGATIONAL', 'COMMERCIAL', 'TRANSACTIONAL', 'LOCAL', 'UNKNOWN'])
          .optional(),
      }),
    )
    .min(1)
    .max(10_000),
  source: z.enum(['MANUAL', 'CSV_IMPORT', 'COMPETITOR', 'AI_EXPANSION']).default('MANUAL'),
});

export const approvalDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  note: z.string().trim().max(1000).optional(),
  editedPayload: z.record(z.string(), z.unknown()).optional(),
});

export const knowledgeBaseSchema = z.object({
  businessDescription: z.string().max(5000).optional().nullable(),
  audience: z.string().max(2000).optional().nullable(),
  toneOfVoice: z.string().max(2000).optional().nullable(),
  brandStyle: z.string().max(2000).optional().nullable(),
  preferredCta: z.string().max(500).optional().nullable(),
  writingGuidelines: z.string().max(5000).optional().nullable(),
  prohibitedClaims: z.array(z.string().max(300)).max(100).optional(),
  uniqueValueProps: z.array(z.string().max(300)).max(50).optional(),
  products: z
    .array(z.object({ name: z.string().max(200), description: z.string().max(1000).optional(), url: z.string().max(500).optional() }))
    .max(100)
    .optional(),
  terminology: z
    .array(z.object({ term: z.string().max(120), definition: z.string().max(1000) }))
    .max(200)
    .optional(),
  authorBios: z
    .array(
      z.object({
        name: z.string().max(120),
        title: z.string().max(200).optional(),
        bio: z.string().max(2000).optional(),
        url: z.string().max(500).optional(),
      }),
    )
    .max(50)
    .optional(),
});

export const brandFactSchema = z.object({
  fact: z.string().trim().min(3).max(1000),
  category: z.string().trim().max(80).optional(),
  source: z.string().trim().max(120).default('internal'),
  sourceUrl: z.string().trim().max(2048).optional().or(z.literal('')),
  verified: z.boolean().default(false),
});

/** Parse a query-string style object with a Zod schema, returning typed data or throwing ValidationError. */
export function parseSearchParams<T extends z.ZodTypeAny>(
  schema: T,
  params: URLSearchParams | Record<string, string | string[] | undefined>,
): z.infer<T> {
  const obj: Record<string, unknown> = {};
  if (params instanceof URLSearchParams) {
    for (const [key, value] of params.entries()) {
      if (key in obj) {
        const existing = obj[key];
        obj[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
      } else {
        obj[key] = value;
      }
    }
  } else {
    Object.assign(obj, params);
  }
  return schema.parse(obj);
}
