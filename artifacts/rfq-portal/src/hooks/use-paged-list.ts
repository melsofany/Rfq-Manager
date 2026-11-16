import { useInfiniteQuery } from "@tanstack/react-query";

/** Rows per page. Must stay in step with the route default (200). */
export const LIST_PAGE_SIZE = 200;

/**
 * usePagedList — the list routes are bounded so a page open never serializes
 * the whole table, but the bound must not HIDE rows. This pages forward with
 * `offset` until a short page arrives, so every row stays reachable and a
 * bounded list is never mistaken for the whole set.
 */
export function usePagedList<T>({
  queryKey,
  fetchPage,
  pageSize = LIST_PAGE_SIZE,
}: {
  queryKey: readonly unknown[];
  fetchPage: (params: { limit: number; offset: number }) => Promise<T[]>;
  pageSize?: number;
}) {
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => fetchPage({ limit: pageSize, offset: pageParam as number }),
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length < pageSize ? undefined : allPages.reduce((n, p) => n + p.length, 0),
  });

  return {
    rows: query.data ? query.data.pages.flat() : undefined,
    isLoading: query.isLoading,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: () => {
      void query.fetchNextPage();
    },
  };
}
