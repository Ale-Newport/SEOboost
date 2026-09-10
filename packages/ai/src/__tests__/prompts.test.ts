import { NotFoundError } from '@seo/shared';
import { describe, expect, it } from 'vitest';
import {
  PROMPT_IDS,
  contentDraftPrompt,
  getPrompt,
  listPrompts,
  renderKnowledgeBase,
  renderPrompt,
} from '../prompts';

describe('prompt registry', () => {
  it('registers every shipped template exactly once', () => {
    const ids = listPrompts().map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of PROMPT_IDS) expect(ids).toContain(id);
  });

  it('gives every template a non-trivial system prompt and a version', () => {
    for (const template of listPrompts()) {
      expect(template.system.length, `${template.id} system prompt`).toBeGreaterThan(200);
      expect(template.version).toBeGreaterThanOrEqual(1);
      expect(template.description.length).toBeGreaterThan(10);
    }
  });

  it('throws on an unknown id rather than returning a silent fallback', () => {
    expect(() => getPrompt('no-such-prompt')).toThrow(NotFoundError);
  });

  it('renders deterministically — the same vars always produce the same prompt', () => {
    const vars = { targetKeyword: 'headless cms migration', targetWordCount: 1200 };
    const first = contentDraftPrompt.render(vars);
    const second = contentDraftPrompt.render(vars);
    expect(first).toBe(second);
    expect(first).toContain('headless cms migration');
  });

  it('renders by id with the system prompt and version attached', () => {
    const rendered = renderPrompt('meta-description', { targetKeyword: 'crm for agencies' });
    expect(rendered.prompt).toContain('crm for agencies');
    expect(rendered.system).toContain('meta description');
    expect(rendered.version).toBe(1);
  });

  it('omits sections whose data is missing instead of emitting empty headings', () => {
    const rendered = contentDraftPrompt.render({ targetKeyword: 'x' });
    expect(rendered).not.toContain('## Outline to follow');
    expect(rendered).not.toContain('undefined');
    expect(rendered).not.toContain('null');
  });
});

describe('renderKnowledgeBase', () => {
  it('withholds unverified brand facts and states the ground-truth rule', () => {
    const rendered = renderKnowledgeBase(
      { businessDescription: 'We sell widgets.', prohibitedClaims: ['Cures anything'] },
      [
        { fact: 'Founded in 2014', verified: true },
        { fact: 'We have 40,000 customers', verified: false },
      ],
    );
    expect(rendered).toContain('Founded in 2014');
    expect(rendered).not.toContain('40,000');
    expect(rendered).toContain('PROHIBITED CLAIMS');
    expect(rendered).toContain('GROUND TRUTH RULE');
  });

  it('withholds a fact whose verified flag is absent, matching the column default', () => {
    const rendered = renderKnowledgeBase(null, [
      { fact: 'We serve 12 countries' },
      { fact: 'Founded in 2014', verified: true },
    ]);
    expect(rendered).not.toContain('12 countries');
    expect(rendered).toContain('Founded in 2014');
  });

  it('says so explicitly when there is no knowledge base at all', () => {
    const rendered = renderKnowledgeBase(null, null);
    expect(rendered).toContain('No knowledge base');
    expect(rendered).toContain('do not assert anything specific');
  });
});
