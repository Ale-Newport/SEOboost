'use client';

import { useMemo, useState } from 'react';
import { BookOpen, Search, Wrench } from 'lucide-react';

import { Badge, SeverityBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn, formatNumber } from '@/lib/utils';
import {
  CATEGORY_LABEL,
  SEVERITY_SEQUENCE,
  categoryLabel,
  type IssueCategoryName,
  type RuleReferenceEntry,
} from './types';

const CATEGORY_SEQUENCE = Object.keys(CATEGORY_LABEL) as IssueCategoryName[];

function severityRank(rule: RuleReferenceEntry): number {
  const index = SEVERITY_SEQUENCE.indexOf(rule.severity);
  return index === -1 ? SEVERITY_SEQUENCE.length : index;
}

export interface RuleReferenceSheetProps {
  rules: readonly RuleReferenceEntry[];
  /** Rules the current site has live findings for, so the reference can mark them. */
  activeRuleIds?: readonly string[];
}

/**
 * The complete rule catalogue, with each rule's category, severity, weight, scope and — the part
 * that matters — the reason it exists at all.
 *
 * The audit is only worth trusting if its rules are inspectable, so this reads straight from the
 * engine's `RULE_LIST`: there is no second, prettier list that can drift from the one that
 * actually runs.
 */
export function RuleReferenceSheet({
  rules,
  activeRuleIds = [],
}: RuleReferenceSheetProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const active = useMemo(() => new Set(activeRuleIds), [activeRuleIds]);

  const groups = useMemo(() => {
    const term = query.trim().toLowerCase();
    const matches = rules.filter((rule) => {
      if (term.length === 0) return true;
      return (
        rule.id.toLowerCase().includes(term) ||
        rule.title.toLowerCase().includes(term) ||
        rule.rationale.toLowerCase().includes(term) ||
        categoryLabel(rule.category).toLowerCase().includes(term)
      );
    });

    return CATEGORY_SEQUENCE.map((category) => ({
      category,
      label: categoryLabel(category),
      rules: matches
        .filter((rule) => rule.category === category)
        .sort((a, b) => severityRank(a) - severityRank(b) || a.id.localeCompare(b.id)),
    })).filter((group) => group.rules.length > 0);
  }, [rules, query]);

  const matchCount = groups.reduce((total, group) => total + group.rules.length, 0);

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <BookOpen aria-hidden="true" />
          Rule reference
        </Button>
      </SheetTrigger>

      <SheetContent className="flex w-full flex-col gap-4 p-5 sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Rule reference</SheetTitle>
          <SheetDescription>
            All {formatNumber(rules.length)} rules the audit runs, with the weight each one carries
            in the health score and why it is checked at all. Nothing here is a black box: this is
            the same catalogue the engine evaluates.
          </SheetDescription>
        </SheetHeader>

        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search rules, categories or rationale…"
            aria-label="Search the rule reference"
            className="h-8 pl-8 text-xs"
          />
        </div>

        <p aria-live="polite" className="text-2xs text-muted-foreground">
          {matchCount === rules.length
            ? `${formatNumber(rules.length)} rules across ${groups.length} categories`
            : `${formatNumber(matchCount)} of ${formatNumber(rules.length)} rules match`}
        </p>

        <SheetBody className="space-y-5">
          {groups.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              No rule matches “{query.trim()}”.
            </p>
          ) : (
            groups.map((group) => (
              <section key={group.category} className="space-y-2">
                <h3 className="sticky top-0 z-10 -mx-5 bg-popover/95 px-5 py-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">
                  {group.label}
                  <span className="tabular ml-1.5 font-normal normal-case tracking-normal">
                    · {group.rules.length}
                  </span>
                </h3>

                <ul className="space-y-2">
                  {group.rules.map((rule) => (
                    <li
                      key={rule.id}
                      className={cn(
                        'rounded-md border border-border bg-card p-3',
                        active.has(rule.id) && 'border-primary/40 bg-primary/[0.04]',
                      )}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-foreground">{rule.title}</p>
                          <p className="font-mono text-2xs text-muted-foreground">{rule.id}</p>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                          <SeverityBadge severity={rule.severity} />
                          <Badge variant="muted">
                            <span className="tabular">×{rule.weight}</span> weight
                          </Badge>
                          <Badge variant="outline">
                            {rule.scope === 'site' ? 'Site-wide' : 'Per page'}
                          </Badge>
                          {rule.autoFixable ? (
                            <Badge variant="info">
                              <Wrench className="size-3" aria-hidden="true" />
                              Auto-fixable
                            </Badge>
                          ) : null}
                        </div>
                      </div>
                      <p className="mt-1.5 text-2xs leading-relaxed text-muted-foreground">
                        {rule.rationale}
                      </p>
                      {active.has(rule.id) ? (
                        <p className="mt-1.5 text-2xs font-medium text-primary">
                          This site has open findings from this rule.
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
