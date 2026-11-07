import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_RULES,
  socialPostDraftPrompt,
  socialReplyDraftPrompt,
  socialStrategyPrompt,
  socialTriagePrompt,
} from '../prompts';

const replyVars = {
  platform: 'REDDIT',
  community: 'r/MealPrepSunday',
  communityRulesSummary: 'Self-promotion is restricted.',
  threadTitle: 'Any app that builds a grocery list from my meal plan?',
  threadText: 'I plan meals on Sunday and keep forgetting things at the store.',
  threadUrl: 'https://www.reddit.com/r/MealPrepSunday/comments/abc/x/',
  intent: 'seeking-recommendation',
  angle: 'Batch the list by store aisle',
  brandName: 'Mealwise',
  operatorDisclosure: 'Disclosure: I build Mealwise.',
  suggestedLink: { url: 'https://mealwise.app/grocery?utm_source=reddit', title: 'Grocery lists', summary: 'How it works' },
  linkAllowed: false,
  mentionAllowed: true,
  maxLength: 1500,
  language: 'en',
};

describe('social prompts', () => {
  it('embed the community participation rules in every system prompt', () => {
    for (const template of [socialStrategyPrompt, socialTriagePrompt, socialReplyDraftPrompt]) {
      expect(template.system).toContain(COMMUNITY_RULES);
    }
    expect(COMMUNITY_RULES).toMatch(/disclose the affiliation/);
    expect(COMMUNITY_RULES).toMatch(/return SKIP/);
  });

  it('never hands the reply drafter a link it is not allowed to use', () => {
    const rendered = socialReplyDraftPrompt.render(replyVars);
    expect(rendered).toContain('linkAllowed: false');
    expect(rendered).not.toContain('mealwise.app/grocery');
    expect(rendered).toContain('Disclosure: I build Mealwise.');
    const withLink = socialReplyDraftPrompt.render({ ...replyVars, linkAllowed: true });
    expect(withLink).toContain('https://mealwise.app/grocery?utm_source=reddit');
  });

  it('falls back to a plain disclosure sentence when the operator has not set one', () => {
    expect(socialReplyDraftPrompt.render({ ...replyVars, operatorDisclosure: null })).toContain('"Disclosure: I build Mealwise."');
  });

  it('renders the daily post deterministically and keeps the URL out of the body instructions', () => {
    const vars = {
      platform: 'BLUESKY',
      maxLength: 300,
      needsTitle: false,
      allowsHashtags: true,
      brandName: 'Mealwise',
      language: 'en',
      page: { url: 'https://mealwise.app/guide', title: 'Guide', summary: 'Plan a week in 10 minutes', excerpt: null },
      reason: 'Recently published.',
      recentPosts: ['Last week we shipped aisle sorting.'],
    };
    expect(socialPostDraftPrompt.render(vars)).toBe(socialPostDraftPrompt.render(vars));
    expect(socialPostDraftPrompt.system).toMatch(/Do not include the URL in the body/);
  });
});
