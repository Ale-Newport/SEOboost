import Link from 'next/link';
import { AlertTriangle, Info, Lightbulb, TrendingDown, TrendingUp, Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';
import type { DashboardData } from '@/server/queries/dashboard';

const ICONS = {
  STRONGEST_GROWTH: TrendingUp,
  NEEDS_ATTENTION: TrendingDown,
  HIGHEST_OPPORTUNITY: Lightbulb,
  THEME_OVERLAP: Users,
  INTERNAL_COMPETITION: AlertTriangle,
  STALE_DATA: Info,
  CROSS_LINK_CANDIDATE: Info,
} as const;

const TONE = {
  critical: 'border-destructive/30 bg-destructive/5 text-destructive',
  warning: 'border-warning/30 bg-warning/5 text-warning',
  info: 'border-border bg-muted/40 text-muted-foreground',
} as const;

export function InsightsPanel({ insights }: { insights: DashboardData['insights'] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Portfolio intelligence</CardTitle>
      </CardHeader>
      <CardContent>
        {insights.length === 0 ? (
          <EmptyState
            size="sm"
            icon={Lightbulb}
            title="Nothing notable across the portfolio"
            description="Cross-site insights appear once there is enough performance history to compare."
          />
        ) : (
          <ul className="space-y-2.5">
            {insights.slice(0, 6).map((insight, index) => {
              const Icon = ICONS[insight.type] ?? Info;
              return (
                <li key={`${insight.type}-${index}`} className="flex gap-3">
                  <span
                    className={cn('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border', TONE[insight.severity])}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{insight.title}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{insight.detail}</p>
                    {insight.websiteIds.length === 1 && (
                      <Link
                        href={`/sites/${insight.websiteIds[0]}`}
                        className="mt-1 inline-block text-xs font-medium text-primary hover:underline"
                      >
                        Open site
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
