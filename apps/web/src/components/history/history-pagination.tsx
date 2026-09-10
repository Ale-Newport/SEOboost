'use client';

import { Pagination, useTableParams } from '@/components/data';

/**
 * Pager for the timeline. It owns no state — `useTableParams` keeps the position in the URL, so
 * a linked entry is still a linked entry after a refresh.
 */
export function HistoryPagination({
  page,
  pageSize,
  total,
}: {
  page: number;
  pageSize: number;
  total: number;
}): React.JSX.Element {
  const { setPage, setPageSize } = useTableParams({ defaultPageSize: pageSize });

  return (
    <Pagination
      page={page}
      pageSize={pageSize}
      total={total}
      onPageChange={setPage}
      onPageSizeChange={setPageSize}
      itemLabel="changes"
    />
  );
}
