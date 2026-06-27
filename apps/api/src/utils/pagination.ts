import { Prisma } from '@aura/database';

export function getCursorWhereClause(cursorCreatedAt?: string, cursorId?: string): Prisma.JobWhereInput {
  if (!cursorCreatedAt || !cursorId) {
    return {};
  }
  return {
    OR: [
      { createdAt: { lt: new Date(cursorCreatedAt) } },
      { AND: [{ createdAt: new Date(cursorCreatedAt) }, { id: { lt: cursorId } }] }
    ]
  };
}

export function buildPaginatedResponse<T extends { id: string, createdAt: Date }>(
  jobs: T[],
  limit: number,
  total: number
) {
  const hasMore = jobs.length > limit;
  const items = hasMore ? jobs.slice(0, limit) : jobs;
  const last = items[items.length - 1];

  return {
    items,
    total,
    nextCursor: hasMore && last ? {
      cursorCreatedAt: last.createdAt.toISOString(),
      cursorId: last.id
    } : null
  };
}
