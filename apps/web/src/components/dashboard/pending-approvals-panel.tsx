import Link from 'next/link';
import { CheckCircle2, CheckSquare } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import type { DashboardData } from '@/server/queries/dashboard';

const RISK_VARIANT = { SAFE: 'success', MEDIUM: 'warning', HIGH: 'destructive' } as const;

export function PendingApprovalsPanel({
  approvals,
  total,
}: {
  approvals: DashboardData['pendingApprovals'];
  total: number;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2">
          <CheckSquare className="h-4 w-4" />
          Pending approvals
          {total > 0 && <span className="tabular text-sm font-normal text-muted-foreground">({total})</span>}
        </CardTitle>
        {total > 0 && (
          <Button asChild variant="outline" size="sm">
            <Link href="/approvals">Review all</Link>
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {approvals.length === 0 ? (
          <EmptyState
            size="sm"
            icon={CheckCircle2}
            title="Nothing waiting on you"
            description="When an agent proposes a change that needs sign-off, it appears here."
          />
        ) : (
          <ul className="space-y-1">
            {approvals.map((approval) => (
              <li key={approval.id}>
                <Link
                  href={`/approvals?focus=${approval.id}`}
                  className="flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent"
                >
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-1 text-sm">{approval.title}</p>
                    <p className="text-2xs text-muted-foreground">
                      {approval.website.name} · {approval.kind.replace(/_/g, ' ').toLowerCase()}
                    </p>
                  </div>
                  <Badge variant={RISK_VARIANT[approval.risk] ?? 'secondary'} className="shrink-0 text-2xs">
                    {approval.risk.toLowerCase()}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
