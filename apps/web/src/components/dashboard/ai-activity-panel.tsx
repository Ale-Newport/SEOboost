import Link from 'next/link';
import {
  AlertTriangle, Braces, FileText, Link2, MousePointerClick, RefreshCw, Sparkles, Target, Users,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { formatNumber } from '@/lib/utils';
import type { DashboardData } from '@/server/queries/dashboard';

const ACTION_ICONS: Record<string, typeof Sparkles> = {
  FIX_TECHNICAL_ISSUE: AlertTriangle,
  UPDATE_TITLE: MousePointerClick,
  UPDATE_META_DESCRIPTION: MousePointerClick,
  UPDATE_CONTENT: FileText,
  PUBLISH_CONTENT: FileText,
  CREATE_CONTENT_BRIEF: FileText,
  ADD_INTERNAL_LINKS: Link2,
  ADD_STRUCTURED_DATA: Braces,
  REFRESH_CONTENT: RefreshCw,
  GEO_IMPROVEMENT: Sparkles,
  CONSOLIDATE_PAGES: Users,
};

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline'> = {
  COMPLETED: 'success',
  EXECUTING: 'default',
  AWAITING_APPROVAL: 'warning',
  PROPOSED: 'secondary',
  FAILED: 'destructive',
  REJECTED: 'outline',
  MEASURING: 'default',
  EVALUATED: 'success',
};

export function AiActivityPanel({
  counts,
  recentActions,
}: {
  counts: DashboardData['counts'];
  recentActions: DashboardData['recentActions'];
}) {
  const summary = [
    { label: 'content opportunities discovered', value: counts.opportunities, href: '/opportunities', icon: Target },
    { label: 'pages losing rankings', value: counts.decliningPages, href: '/opportunities?type=decay', icon: RefreshCw },
    { label: 'technical problems detected', value: counts.openIssues, href: '/sites', icon: AlertTriangle },
    { label: 'actions completed this week', value: counts.actionsThisWeek, href: '/actions?status=COMPLETED', icon: Sparkles },
  ].filter((row) => row.value > 0);

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          AI activity
        </CardTitle>
        <Link href="/actions" className="text-xs font-medium text-primary hover:underline">
          All actions
        </Link>
      </CardHeader>
      <CardContent className="flex-1 space-y-4">
        {summary.length > 0 ? (
          <ul className="space-y-1.5">
            {summary.map((row) => (
              <li key={row.label}>
                <Link
                  href={row.href}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
                >
                  <row.icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="tabular font-semibold">{formatNumber(row.value)}</span>
                  <span className="truncate text-muted-foreground">{row.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-2 text-sm text-muted-foreground">
            No findings yet. Run a crawl and the analysis agents to populate this panel.
          </p>
        )}

        <div>
          <p className="mb-2 px-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            Recent actions
          </p>
          {recentActions.length === 0 ? (
            <EmptyState
              size="sm"
              title="No actions yet"
              description="Once the AI SEO Manager runs, its proposals appear here."
            />
          ) : (
            <ul className="space-y-1">
              {recentActions.map((action) => {
                const Icon = ACTION_ICONS[action.type] ?? Sparkles;
                return (
                  <li key={action.id}>
                    <Link
                      href={`/actions/${action.id}`}
                      className="flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent"
                    >
                      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-1 text-sm">{action.title}</p>
                        <p className="text-2xs text-muted-foreground">{action.website.name}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span className="tabular text-2xs font-semibold text-muted-foreground">
                          {Math.round(action.priorityScore)}
                        </span>
                        <Badge variant={STATUS_VARIANT[action.status] ?? 'secondary'} className="text-2xs">
                          {action.status.replace(/_/g, ' ').toLowerCase()}
                        </Badge>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
