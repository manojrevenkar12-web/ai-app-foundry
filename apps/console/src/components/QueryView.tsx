import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ErrorState, Skeleton } from "./ui";

/** Loading, error and empty states for one query, so no screen forgets one. */
export function QueryView<T>({
  query,
  children,
  empty,
  isEmpty,
  skeleton,
}: {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  skeleton?: ReactNode;
}) {
  if (query.isPending) return <>{skeleton ?? <Skeleton lines={4} />}</>;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const data = query.data as T;
  const none = isEmpty ? isEmpty(data) : Array.isArray(data) && data.length === 0;
  if (none && empty) return <>{empty}</>;
  return <>{children(data)}</>;
}
