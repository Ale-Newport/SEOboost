import { ShieldAlert } from 'lucide-react';

import { Badge, SeverityBadge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { formatNumber } from '@/lib/utils';
import type { SuspiciousDomainView } from '@/server/queries/backlinks';

/**
 * Domains flagged by the link heuristics, each with the evidence that fired.
 *
 * A flag means "look at this", never "disavow this". The heuristics count observable things —
 * exact-match commercial anchors, abuse-heavy TLDs, spam-shaped hostnames, sitewide placements,
 * sudden bursts — and every finding carries what was counted so a human can overrule it. No
 * purchased "toxicity" number is used anywhere, and nothing here is disavowed automatically.
 */
export function SuspiciousLinks({
  domains,
  totalLinks,
}: {
  domains: readonly SuspiciousDomainView[];
  totalLinks: number;
}): React.JSX.Element {
  const flaggedLinks = domains.reduce((sum, domain) => sum + domain.links, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert aria-hidden="true" className="size-4 text-muted-foreground" />
          Links worth a second look
        </CardTitle>
        <CardDescription>
          {domains.length === 0
            ? 'Every heuristic ran and nothing fired.'
            : `${formatNumber(domains.length)} domain(s) covering ${formatNumber(flaggedLinks)} of ${formatNumber(
                totalLinks,
              )} stored links. A flag is a prompt to review, not a verdict — the disavow decision is always yours.`}
        </CardDescription>
      </CardHeader>

      <CardContent>
        {domains.length === 0 ? (
          <EmptyState
            size="sm"
            title="No domain tripped a heuristic"
            description="Nothing in the stored profile shows the anchor, hostname, placement or burst patterns the heuristics look for. Re-check after your next import."
          />
        ) : (
          <ul className="divide-y divide-border">
            {domains.map((domain) => (
              <li key={domain.referringDomain} className="space-y-1.5 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={domain.severity} />
                  <span className="truncate text-xs font-medium text-foreground">{domain.referringDomain}</span>
                  <span className="text-2xs text-muted-foreground">
                    {formatNumber(domain.links)} link{domain.links === 1 ? '' : 's'}
                  </span>
                </div>

                <ul className="flex flex-wrap gap-1.5">
                  {domain.reasons.map((reason) => (
                    <li key={reason}>
                      <Badge variant="outline">{reason}</Badge>
                    </li>
                  ))}
                </ul>

                {domain.evidence.length > 0 ? (
                  <ul className="space-y-0.5">
                    {domain.evidence.map((line) => (
                      <li key={line} className="text-2xs leading-relaxed text-muted-foreground">
                        {line}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
