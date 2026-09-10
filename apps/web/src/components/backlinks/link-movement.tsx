'use client';

import { useMemo } from 'react';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DataTable } from '@/components/data/data-table';
import { useTableParams } from '@/components/data/use-table-params';
import { linkColumns } from '@/components/backlinks/links-table';
import { formatNumber } from '@/lib/utils';
import type { BacklinkRowView } from '@/server/queries/backlinks';

/**
 * What changed in the window: links first seen inside it, and links reported lost inside it.
 *
 * "Lost" means the source that last reported this link stopped reporting it. That is evidence the
 * link is gone, not proof — a crawl gap in the provider's data looks identical — so the copy says
 * "reported lost" rather than "removed".
 */

const WINDOW_OPTIONS = [7, 30, 90, 180, 365] as const;

export function LinkMovement({
  newLinks,
  lostLinks,
  windowDays,
}: {
  newLinks: readonly BacklinkRowView[];
  lostLinks: readonly BacklinkRowView[];
  windowDays: number;
}): React.JSX.Element {
  const { setFilters } = useTableParams();
  const columns = useMemo(() => linkColumns(), []);

  return (
    <Tabs defaultValue="new" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabsList variant="pill">
          <TabsTrigger value="new">
            <ArrowUpRight aria-hidden="true" />
            New
            <Badge variant="muted">{formatNumber(newLinks.length)}</Badge>
          </TabsTrigger>
          <TabsTrigger value="lost">
            <ArrowDownRight aria-hidden="true" />
            Lost
            <Badge variant="muted">{formatNumber(lostLinks.length)}</Badge>
          </TabsTrigger>
        </TabsList>

        <Select
          value={String(windowDays)}
          onValueChange={(next) => setFilters({ days: next })}
        >
          <SelectTrigger className="h-8 w-auto min-w-[9rem] gap-1.5 text-xs" aria-label="Comparison window">
            <span className="text-muted-foreground">Window:</span>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOW_OPTIONS.map((days) => (
              <SelectItem key={days} value={String(days)} className="text-xs">
                Last {days} days
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <TabsContent value="new">
        <DataTable
          data={newLinks}
          columns={columns}
          getRowId={(row) => row.id}
          caption={`Links first seen in the last ${windowDays} days`}
          defaultSort="firstSeenAt"
          defaultOrder="desc"
          itemLabel="new links"
          exportFilename="backlinks-new"
          stickyHeader
          maxHeight={420}
          emptyTitle="No new links in this window"
          emptyDescription="Nothing was first seen in the period. Widen the window, or import a more recent export."
        />
      </TabsContent>

      <TabsContent value="lost">
        <DataTable
          data={lostLinks}
          columns={columns}
          getRowId={(row) => row.id}
          caption={`Links reported lost in the last ${windowDays} days`}
          defaultSort="lastSeenAt"
          defaultOrder="desc"
          itemLabel="lost links"
          exportFilename="backlinks-lost"
          stickyHeader
          maxHeight={420}
          emptyTitle="No links reported lost in this window"
          emptyDescription="A link counts as lost only once a source that used to report it stops. With one import there is nothing to compare against yet."
        />
      </TabsContent>
    </Tabs>
  );
}
