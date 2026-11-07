/**
 * Wire types for the Social screen.
 *
 * Declared here, not imported from the server packages, because client components must not
 * pull `@seo/db`, `@seo/integrations` or `@seo/seo-engine` into the browser bundle. The server
 * query builds exactly these shapes, and every date crosses as an ISO string so the same type is
 * true both for server-component props and for `GET /api/social` responses.
 */

export const SOCIAL_PLATFORMS = [
  'REDDIT',
  'HACKER_NEWS',
  'X',
  'BLUESKY',
  'MASTODON',
  'LINKEDIN',
  'DEVTO',
  'TELEGRAM',
  'DISCORD',
  'YOUTUBE',
  'GITHUB',
  'FACEBOOK',
  'INSTAGRAM',
  'V2EX',
] as const;

export type SocialPlatformValue = (typeof SOCIAL_PLATFORMS)[number];

export type ConversationStatusValue = 'NEW' | 'SHORTLISTED' | 'DRAFTED' | 'REPLIED' | 'DISMISSED' | 'EXPIRED';

export type PostStatusValue =
  | 'DRAFT'
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'SCHEDULED'
  | 'PUBLISHING'
  | 'PUBLISHED'
  | 'MANUAL_PENDING'
  | 'FAILED'
  | 'REJECTED'
  | 'CANCELLED';

export type PolicyValue = 'ALLOWED' | 'RESTRICTED' | 'FORBIDDEN' | 'UNKNOWN';

export type AccountStatusValue = 'NOT_CONFIGURED' | 'CONNECTED' | 'ERROR' | 'EXPIRED' | 'DISABLED';

export type TopicKindValue = 'problem' | 'brand' | 'competitor';

/** Inbox filter chips. `open` is everything still actionable. */
export const CONVERSATION_FILTERS = ['open', 'replied', 'dismissed', 'expired', 'all'] as const;
export type ConversationFilter = (typeof CONVERSATION_FILTERS)[number];

export const SOCIAL_TABS = ['inbox', 'posts', 'topics', 'accounts', 'settings'] as const;
export type SocialTab = (typeof SOCIAL_TABS)[number];

export interface ScoreFactorWire {
  key: string;
  label: string;
  value: number;
  weight: number;
  contribution: number;
  explanation: string;
}

export interface TriageWire {
  fit: number | null;
  approach: string | null;
  reason: string | null;
  angle: string | null;
  draftSkipReason: string | null;
}

export interface SocialConversationRow {
  id: string;
  platform: SocialPlatformValue;
  url: string;
  title: string | null;
  body: string | null;
  author: string | null;
  community: string | null;
  communityPolicy: PolicyValue | null;
  communityRulesSummary: string | null;
  publishedAt: string | null;
  discoveredAt: string;
  score: number | null;
  commentCount: number | null;
  isLocked: boolean;
  intent: string;
  relevanceScore: number;
  relevanceSummary: string | null;
  relevanceFactors: ScoreFactorWire[];
  triage: TriageWire | null;
  status: ConversationStatusValue;
  backend: string;
  topicName: string | null;
  /** The newest post tied to this thread, if any. */
  post: { id: string; status: PostStatusValue; externalUrl: string | null } | null;
}

export interface SocialPostRow {
  id: string;
  kind: 'REPLY' | 'ORIGINAL';
  platform: SocialPlatformValue;
  status: PostStatusValue;
  community: string | null;
  title: string | null;
  body: string;
  linkUrl: string | null;
  includesLink: boolean;
  generatedBy: string | null;
  scheduledFor: string | null;
  publishedAt: string | null;
  externalUrl: string | null;
  error: string | null;
  metrics: Record<string, number | boolean>;
  metricsCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
  accountId: string | null;
  accountHandle: string | null;
  conversation: { id: string; title: string | null; url: string } | null;
  actionId: string | null;
  pendingApprovalId: string | null;
  /** Prefilled link for posting by hand, when this post cannot (or will not) go out through an API. */
  manualPostUrl: string | null;
}

export interface SocialTopicRow {
  id: string;
  name: string;
  query: string;
  keywords: string[];
  negativeKeywords: string[];
  platforms: SocialPlatformValue[];
  communities: string[];
  kind: TopicKindValue;
  isActive: boolean;
  source: string;
  lastRunAt: string | null;
  lastResultCount: number | null;
  lastError: string | null;
  conversationCount: number;
}

export interface SocialCommunityRow {
  id: string;
  platform: SocialPlatformValue;
  name: string;
  title: string | null;
  subscribers: number | null;
  promotionPolicy: PolicyValue;
  rulesSummary: string | null;
  isBlocked: boolean;
  notes: string | null;
  lastCheckedAt: string | null;
}

export interface SocialAccountRow {
  id: string;
  platform: SocialPlatformValue;
  status: AccountStatusValue;
  handle: string | null;
  displayName: string | null;
  /** Non-secret settings only. Credentials never leave the server. */
  config: Record<string, string | number | boolean>;
  hasCredentials: boolean;
  /** False for listening-only connections (a Reddit app stored without its owner's login). */
  canPost: boolean;
  /** `oauth` for one-click connections, `keys` for pasted credentials, null when none are stored. */
  authType: 'oauth' | 'keys' | null;
  /** When the current token stops working, for tokens that expire. */
  expiresAt: string | null;
  /** True when the platform gave a refresh token, so expiry is handled automatically. */
  refreshable: boolean;
  lastPostAt: string | null;
  lastError: string | null;
  lastTestedAt: string | null;
}

export interface PublisherFieldInfo {
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
  placeholder?: string;
  help?: string;
}

export interface PublisherInfoWire {
  platform: SocialPlatformValue;
  label: string;
  setupHelp: string;
  credentialFields: PublisherFieldInfo[];
  configFields: PublisherFieldInfo[];
  capabilities: { original: boolean; reply: boolean; title: boolean; metrics: boolean; remove: boolean };
}

/** How an account on a platform gets connected from this screen. */
export interface OAuthPlatformWire {
  platform: SocialPlatformValue;
  /** `oauth`: one click. `oauth-instance`: one click after naming the server. `form`: a short form. */
  mode: 'oauth' | 'oauth-instance' | 'form';
  /** False when the one-time developer app has not been set up yet. */
  ready: boolean;
}

export interface DeveloperAppWire {
  platform: SocialPlatformValue;
  label: string;
  configured: boolean;
  source: 'settings' | 'env' | null;
  clientIdPreview: string | null;
  hasSecret: boolean;
  redirectUri: string;
  createUrl: string;
  steps: string[];
}

export interface PlatformTextRulesWire {
  bodyLimit: number;
  titleLimit: number | null;
  urlWeight: number | null;
  utmSource: string;
}

export interface SocialScheduleRow {
  id: string;
  name: string;
  jobName: string;
  cron: string;
  isEnabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  nextRunAt: string | null;
}

export interface SocialAgentRunRow {
  key: string;
  label: string;
  status: string | null;
  summary: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SocialCounts {
  newConversations: number;
  shortlisted: number;
  awaitingApproval: number;
  scheduled: number;
  published7d: number;
  manualPending: number;
  failed: number;
}

export interface SocialSettingsWire {
  autonomyLevel: string;
  socialDailyPostLimit: number;
  socialDailyReplyLimit: number;
  socialMaxPromoRatio: number;
  socialDisclosure: string | null;
  socialUtmCampaign: string;
}

export interface SocialOverview {
  website: {
    id: string;
    name: string;
    domain: string;
    brandName: string | null;
    /** Brand name, site name and domain — a draft mentioning any of them needs a disclosure. */
    brandTerms: string[];
  };
  settings: SocialSettingsWire;
  counts: SocialCounts;
  conversationFilter: ConversationFilter;
  conversationFilterCounts: Record<ConversationFilter, number>;
  conversations: SocialConversationRow[];
  posts: SocialPostRow[];
  topics: SocialTopicRow[];
  communities: SocialCommunityRow[];
  accounts: SocialAccountRow[];
  publishers: PublisherInfoWire[];
  oauth: { platforms: OAuthPlatformWire[]; developerApps: DeveloperAppWire[] };
  /** Platforms listening can search, and which of them need agent-reach. */
  listeningPlatforms: Array<{ platform: SocialPlatformValue; needsAgentReach: boolean }>;
  manualOnlyPlatforms: SocialPlatformValue[];
  agentReach: { available: boolean; version: string | null; bin: string; message: string; installHint: string };
  aiConfigured: boolean;
  textRules: Record<SocialPlatformValue, PlatformTextRulesWire>;
  hardLimits: { dailyReplies: number; dailyPostsPerAccount: number; maxPromoRatio: number };
  schedules: SocialScheduleRow[];
  agentRuns: SocialAgentRunRow[];
}

/** The five schedules the automation switch manages. */
export const SOCIAL_SCHEDULE_LABELS: Record<string, { label: string; description: string }> = {
  'social-listening': { label: 'Listening', description: 'Searches every active topic every four hours.' },
  'social-engagement': { label: 'Reply drafts', description: 'Drafts replies for shortlisted threads; each waits for approval.' },
  'social-content': { label: 'Daily posts', description: "Plans today's posts for your own accounts each morning." },
  'social-dispatch': { label: 'Publisher', description: 'Publishes approved posts when they fall due (every 15 minutes).' },
  'social-metrics': { label: 'Engagement', description: 'Reads likes, comments and score back twice a day.' },
};

/** One cell of the portfolio accounts matrix. Never carries a secret. */
export interface MatrixAccountCell {
  status: AccountStatusValue;
  handle: string | null;
  authType: 'oauth' | 'keys' | null;
  expiresAt: string | null;
  refreshable: boolean;
  canPost: boolean;
  lastError: string | null;
  lastPostAt: string | null;
}

/** Every site × every publishing platform, for operators running many accounts. */
export interface SocialAccountsMatrix {
  platforms: Array<{ platform: SocialPlatformValue; label: string; mode: OAuthPlatformWire['mode']; ready: boolean }>;
  sites: Array<{
    id: string;
    name: string;
    domain: string;
    accounts: Partial<Record<SocialPlatformValue, MatrixAccountCell>>;
  }>;
  developerApps: { configured: number; total: number };
  totals: { connected: number; needsAttention: number };
}
