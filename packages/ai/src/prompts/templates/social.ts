import { registerPrompt } from '../registry';
import {
  ANALYSIS_RULES,
  OUTPUT_CONTRACT,
  QUALITY_RULES,
  bullets,
  clip,
  jsonBlock,
  lines,
  renderKnowledgeBase,
  section,
} from '../shared';
import type { PromptBrandFact, PromptKnowledgeBase } from '../shared';

/**
 * Social listening and publishing prompts.
 *
 * The four templates share one stance, stated once below: the platform helps an operator take
 * part in communities where their product is genuinely relevant, as themselves, with disclosure.
 * It never astroturfs (fake users, fake reviews, sock puppets, undisclosed affiliation), never
 * mass-posts, and refusing to reply is a normal, frequent output — not a failure.
 */

export const COMMUNITY_RULES = [
  'COMMUNITY PARTICIPATION RULES (non-negotiable):',
  '1. Write as the operator, a real person who builds the product, never as a "happy customer",',
  '   a neutral bystander or a fake persona. Never invent personal anecdotes, usage history,',
  '   results or testimonials.',
  '2. Whenever the product is named or linked, disclose the affiliation in plain words in the',
  '   same reply (e.g. "Disclosure: I build X"). No disclosure, no mention.',
  '3. Answer the person\'s actual question first, completely, in a way that would be useful even',
  '   if they never click anything. The product is at most one option among others, mentioned',
  '   only if it genuinely fits their situation — including its limitations.',
  '4. Respect the community: match its tone, never use marketing language, hype, emojis-as-',
  '   decoration, hashtags (on Reddit/HN), urgency, discounts or calls to action like "sign up".',
  '5. If the community rules forbid promotion, help without naming the product at all. If a',
  '   link is not allowed, do not include one or work around it (no "DM me", no "Google X").',
  '6. When the product is not a good answer, or the thread does not need us, return SKIP. A',
  '   skipped thread costs nothing; a pushy reply costs the account and the brand.',
].join('\n');

export interface SocialStrategyVars {
  siteName: string;
  domain: string;
  brandName: string | null;
  businessCategory: string | null;
  targetAudience: string | null;
  language: string;
  knowledgeBase?: PromptKnowledgeBase | null;
  brandFacts?: readonly PromptBrandFact[] | null;
  topQueries: readonly string[];
  topPages: ReadonlyArray<{ url: string; title: string | null }>;
  competitors: readonly string[];
  existingTopics: readonly string[];
  availablePlatforms: readonly string[];
}

export const socialStrategyPrompt = registerPrompt<SocialStrategyVars>({
  id: 'social-strategy',
  version: 1,
  description: 'Propose listening topics, communities and content pillars for social visibility.',
  defaultRole: 'reasoning',
  system: lines(
    'You plan how a small product team can become visible in the online communities where their',
    'audience already discusses the problem the product solves.',
    '',
    'Produce three things:',
    '- listeningTopics: 4-10 search phrases written the way the AUDIENCE describes the PROBLEM',
    '  (not marketing terms, not the brand name) — e.g. "how do I track my macros" rather than',
    '  "AI nutrition platform". Include 1-2 comparison/alternative phrases naming competitors',
    '  when competitors are given (kind "competitor"). Each topic lists the platforms where that',
    '  phrasing is likely to appear (only from availablePlatforms), optional extra keywords, and',
    '  negative keywords that filter obvious false positives (jobs, unrelated meanings).',
    '- communities: subreddits (as r/name) and other communities where these conversations',
    '  happen. Only name communities you are confident exist; prefer specific, mid-sized ones over',
    '  r/all-style giants. Give your expectation of their self-promotion stance; it will be',
    '  verified against the real rules before anything is posted.',
    '- contentPillars: 3-5 recurring themes for the brand\'s OWN channels, each tied to real',
    '  pages of the site when possible, plus a sustainable cadence. Daily posting is fine on',
    '  owned channels; replies in other communities are capped at a handful per day.',
    'Write topics in the site\'s language unless the audience clearly speaks another one.',
    '',
    COMMUNITY_RULES,
    '',
    ANALYSIS_RULES,
    '',
    OUTPUT_CONTRACT,
  ),
  render: (vars) =>
    lines(
      section(
        'Site',
        lines(
          `${vars.siteName} (${vars.domain})`,
          vars.brandName ? `Brand: ${vars.brandName}` : '',
          vars.businessCategory ? `Category: ${vars.businessCategory}` : '',
          vars.targetAudience ? `Audience: ${vars.targetAudience}` : '',
          `Language: ${vars.language}`,
        ),
      ),
      renderKnowledgeBase(vars.knowledgeBase, vars.brandFacts),
      section('Top search queries that already bring visitors', bullets(vars.topQueries.slice(0, 30))),
      section('Important pages', bullets(vars.topPages.slice(0, 20).map((page) => `${page.url}${page.title ? ` — ${page.title}` : ''}`))),
      section('Competitors', bullets(vars.competitors.slice(0, 10))),
      section('Topics already being tracked (do not repeat)', bullets(vars.existingTopics)),
      section('availablePlatforms', vars.availablePlatforms.join(', ')),
    ),
});

export interface SocialTriageConversation {
  id: string;
  platform: string;
  community: string | null;
  title: string | null;
  body: string | null;
  intent: string;
  relevanceScore: number;
  ageHours: number | null;
  communityPolicy: string;
}

export interface SocialTriageVars {
  brandName: string;
  domain: string;
  productSummary: string;
  knowledgeBase?: PromptKnowledgeBase | null;
  conversations: readonly SocialTriageConversation[];
}

export const socialTriagePrompt = registerPrompt<SocialTriageVars>({
  id: 'social-conversation-triage',
  version: 1,
  description: 'Decide which listened conversations deserve a reply, and how.',
  defaultRole: 'fast',
  system: lines(
    'You review public threads found by social listening and decide, for each one, whether the',
    'brand\'s maker should take part, and how.',
    '',
    'For each conversation return:',
    '- fit: 0-1, how directly the product addresses what THIS person needs (not the topic in',
    '  general). Be strict: most threads are a 0-0.3.',
    '- approach: REPLY_WITH_PRODUCT (product is a strong, direct answer and the community allows',
    '  it), HELPFUL_NO_PRODUCT (we can genuinely help but naming the product would be out of place),',
    '  ENGAGE_BRAND_MENTION (they are talking about us — thank, answer or correct), or SKIP.',
    '- reason: one sentence a reviewer can check against the thread.',
    '- angle: if not SKIP, the single most useful thing a reply could say (no product pitch).',
    'Skip threads that are jokes, rants, memes, job posts, homework, flame wars, already solved,',
    'or where a maker showing up would be unwelcome.',
    '',
    COMMUNITY_RULES,
    '',
    ANALYSIS_RULES,
    '',
    OUTPUT_CONTRACT,
  ),
  render: (vars) =>
    lines(
      section('Brand', lines(`${vars.brandName} (${vars.domain})`, vars.productSummary)),
      renderKnowledgeBase(vars.knowledgeBase, null),
      section(
        'Conversations',
        jsonBlock(
          vars.conversations.map((conversation) => ({
            ...conversation,
            body: clip(conversation.body, 1_200),
          })),
        ),
      ),
    ),
});

export interface SocialReplyDraftVars {
  platform: string;
  community: string | null;
  communityRulesSummary: string | null;
  threadTitle: string | null;
  threadText: string;
  threadUrl: string;
  intent: string;
  angle: string | null;
  brandName: string;
  operatorDisclosure: string | null;
  /** The best page to point to, when a link is allowed. */
  suggestedLink: { url: string; title: string | null; summary: string | null } | null;
  linkAllowed: boolean;
  mentionAllowed: boolean;
  maxLength: number;
  language: string | null;
  knowledgeBase?: PromptKnowledgeBase | null;
  brandFacts?: readonly PromptBrandFact[] | null;
}

export const socialReplyDraftPrompt = registerPrompt<SocialReplyDraftVars>({
  id: 'social-reply-draft',
  version: 1,
  description: 'Draft one helpful, disclosed reply to a public thread, for human review.',
  defaultRole: 'writing',
  system: lines(
    'You draft ONE reply to ONE public thread, for the operator to review, edit and approve.',
    'Nothing you write is posted without a human reading it first.',
    '',
    'Craft:',
    '- Reply in the thread\'s language and register. Short paragraphs; plain text or the',
    '  platform\'s light markdown. No headings, no bullet-list walls unless steps are needed.',
    '- Lead with the direct, practical answer to their question, specific to their details.',
    '- Mention the product only if mentionAllowed is true AND it genuinely fits, as one option,',
    '  with its honest limitation, and with the disclosure sentence. If linkAllowed is false, no',
    '  URL at all. If a link is allowed, use only the suggestedLink URL exactly as given.',
    '- Stay under maxLength characters.',
    '',
    'Return: decision (REPLY or SKIP), skipReason, body, mentionsProduct, includesLink,',
    'disclosureIncluded, and reviewerNotes (what the human should double-check: claims, tone,',
    'rules). Use SKIP whenever a reply would not be welcome or useful.',
    '',
    COMMUNITY_RULES,
    '',
    QUALITY_RULES,
    '',
    OUTPUT_CONTRACT,
  ),
  render: (vars) =>
    lines(
      renderKnowledgeBase(vars.knowledgeBase, vars.brandFacts),
      section(
        'Where',
        lines(
          `Platform: ${vars.platform}`,
          vars.community ? `Community: ${vars.community}` : '',
          vars.communityRulesSummary ? `Community rules: ${vars.communityRulesSummary}` : '',
          `Thread: ${vars.threadUrl}`,
        ),
      ),
      section('Thread', lines(vars.threadTitle ? `Title: ${vars.threadTitle}` : '', clip(vars.threadText, 6_000))),
      section('What they want', lines(`Detected intent: ${vars.intent}`, vars.angle ? `Most useful angle: ${vars.angle}` : '')),
      section(
        'Constraints',
        lines(
          `Brand: ${vars.brandName}`,
          `mentionAllowed: ${vars.mentionAllowed}`,
          `linkAllowed: ${vars.linkAllowed}`,
          `Disclosure sentence to use when the product is mentioned: ${vars.operatorDisclosure ?? `"Disclosure: I build ${vars.brandName}."`}`,
          `maxLength: ${vars.maxLength}`,
          vars.language ? `Preferred language: ${vars.language} (but match the thread)` : '',
        ),
      ),
      vars.suggestedLink && vars.linkAllowed
        ? section(
            'suggestedLink',
            lines(vars.suggestedLink.url, vars.suggestedLink.title ?? '', clip(vars.suggestedLink.summary, 600)),
          )
        : '',
    ),
});

export interface SocialPostDraftVars {
  platform: string;
  maxLength: number;
  needsTitle: boolean;
  allowsHashtags: boolean;
  brandName: string;
  language: string;
  page: { url: string; title: string | null; summary: string | null; excerpt: string | null };
  reason: string;
  recentPosts: readonly string[];
  knowledgeBase?: PromptKnowledgeBase | null;
  brandFacts?: readonly PromptBrandFact[] | null;
}

export const socialPostDraftPrompt = registerPrompt<SocialPostDraftVars>({
  id: 'social-post-draft',
  version: 1,
  description: 'Write one post for the brand\'s own channel that shares a page of the site.',
  defaultRole: 'writing',
  system: lines(
    'You write ONE post for the brand\'s OWN account on one platform, sharing one page of its',
    'site. The goal is a post people on that platform would genuinely want to read — a useful',
    'insight, a concrete takeaway or a clear "what\'s new" — with the link as the place to go',
    'deeper. It is not an ad.',
    '',
    'Craft:',
    '- Open with the most useful or surprising concrete point from the page (only from the',
    '  material given — never invent numbers, results or quotes).',
    '- Platform register: X/Bluesky/Mastodon short and direct; LinkedIn a few short paragraphs',
    '  with a takeaway; Reddit (own community) a self-contained text post with a descriptive',
    '  title; Dev.to a full markdown article adapted from the page excerpt, with a short intro',
    '  and a closing line pointing to the original; Telegram/Discord a concise announcement.',
    '- Hashtags only where allowsHashtags is true, at most 2, relevant, at the end.',
    '- Do not repeat the angle or wording of the recent posts listed.',
    '- Do not include the URL in the body; it is appended separately. Stay under maxLength',
    '  characters minus 30 for the link.',
    '',
    'Return: title (or null when needsTitle is false), body, hashtags, and reviewerNotes.',
    '',
    QUALITY_RULES,
    '',
    OUTPUT_CONTRACT,
  ),
  render: (vars) =>
    lines(
      renderKnowledgeBase(vars.knowledgeBase, vars.brandFacts),
      section(
        'Post',
        lines(
          `Platform: ${vars.platform}`,
          `maxLength: ${vars.maxLength}`,
          `needsTitle: ${vars.needsTitle}`,
          `allowsHashtags: ${vars.allowsHashtags}`,
          `Brand: ${vars.brandName}`,
          `Language: ${vars.language}`,
          `Why this page today: ${vars.reason}`,
        ),
      ),
      section(
        'Page to share',
        lines(
          `URL: ${vars.page.url}`,
          vars.page.title ? `Title: ${vars.page.title}` : '',
          vars.page.summary ? `Summary: ${vars.page.summary}` : '',
          vars.page.excerpt ? `Content excerpt:\n${clip(vars.page.excerpt, 6_000)}` : '',
        ),
      ),
      section('Recent posts on this account (avoid repeating)', bullets(vars.recentPosts.slice(0, 10))),
    ),
});
