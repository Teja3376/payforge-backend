import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Base cursor-pagination query.
 *
 * Offset pagination breaks on concurrent inserts: a row inserted while a
 * caller is paging shifts every subsequent page and silently duplicates or
 * skips records. A keyset cursor on `(createdAt, id)` is stable under writes,
 * which matters because merchants reconcile against these lists.
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    default: 25,
    description: 'Page size. Hard-capped at 100.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be a whole number.' })
  @Min(1, { message: 'limit must be at least 1.' })
  @Max(100, { message: 'limit must be 100 or fewer.' })
  limit: number = 25;

  @ApiPropertyOptional({
    description: 'Opaque cursor from a previous response `nextCursor`. Do not construct it by hand.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512, { message: 'cursor must be 512 characters or fewer.' })
  cursor?: string;

  @ApiPropertyOptional({
    enum: ['asc', 'desc'],
    default: 'desc',
    description: 'Sort order on creation time.',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsIn(['asc', 'desc'], { message: 'order must be asc or desc.' })
  order: 'asc' | 'desc' = 'desc';
}

export type Cursor = { createdAt: Date; id: string };

/**
 * Decode the opaque cursor into a keyset predicate.
 *
 * The cursor is base64url JSON rather than a bare timestamp so it can carry
 * the tiebreak id. Without the tiebreak, two rows created in the same
 * millisecond cause pages to skip or repeat rows.
 */
export function decodeCursor(cursor: string | undefined): Cursor | null {
  if (!cursor) {
    return null;
  }
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as { createdAt?: string; id?: string };
    if (!parsed.createdAt || !parsed.id) {
      return null;
    }
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      return null;
    }
    return { createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

export function encodeCursor(row: { id: string; createdAt: Date }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id }),
    'utf8',
  ).toString('base64url');
}

/**
 * Prisma keyset predicate for "strictly after this cursor".
 *
 * `(createdAt, id)` is compared lexicographically so the boundary row is
 * never returned twice.
 */
export function cursorWhere(
  cursor: Cursor | null,
  order: 'asc' | 'desc',
  idField = 'id',
): { OR: Array<Record<string, unknown>> } | Record<string, never> {
  if (!cursor) {
    return {};
  }
  const comparator = order === 'asc' ? 'gt' : 'lt';
  return {
    OR: [
      { createdAt: { [comparator]: cursor.createdAt } },
      { createdAt: cursor.createdAt, [idField]: { [comparator]: cursor.id } },
    ],
  };
}

/**
 * Wrap a page of rows in the standard list envelope.
 *
 * We always over-fetch by one to detect whether more rows exist, then trim,
 * so `hasMore` is accurate without a second COUNT query.
 */
export function paginate<T extends { id: string; createdAt: Date }>(
  rows: T[],
  limit: number,
): { data: T[]; hasMore: boolean; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    data: page,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  };
}

export type ListEnvelope<T> = { data: T[]; hasMore: boolean; nextCursor: string | null };

/**
 * Run a keyset-paginated query and wrap it in the standard list envelope.
 *
 * Shared by every list endpoint so cursor semantics, ordering and the
 * `hasMore` contract are identical across the API. Callers supply only the
 * tenant/filter scope and a presenter.
 *
 * `TModel` is inferred from `query`'s return type. `present` is typed over
 * `NoInfer` so that inference has exactly one source and does not collapse to
 * the constraint when a caller supplies an untyped lambda.
 */
export async function paginatedQuery<
  TModel extends { id: string; createdAt: Date },
  TResult,
>(input: {
  scope: Record<string, unknown>;
  query: (
    where: Record<string, unknown>,
    take: number,
    orderBy: Array<Record<string, unknown>>,
  ) => Promise<TModel[]>;
  present: (row: NoInfer<TModel>) => TResult;
  limit: number;
  cursor?: string;
  order?: 'asc' | 'desc';
}): Promise<ListEnvelope<TResult>> {
  const order = input.order ?? 'desc';
  // Clamp again here as defence in depth: the DTO already bounds this, but a
  // caller that bypasses the DTO must not be able to request an unbounded page.
  const limit = Math.min(Math.max(Math.trunc(input.limit) || 25, 1), 100);
  const decoded = decodeCursor(input.cursor);
  // Drop the empty predicate when there is no cursor: `AND: [scope, {}]` is
  // tolerated by Prisma but reads badly in query logs and in tests.
  const cursorPredicate = cursorWhere(decoded, order);
  const where = {
    AND: Object.keys(cursorPredicate).length > 0 ? [input.scope, cursorPredicate] : [input.scope],
  };
  const rows = await input.query(
    where as never,
    limit + 1,
    [{ createdAt: order }, { id: order }],
  );
  const page = paginate(rows, limit);
  return {
    data: page.data.map((row) => input.present(row)),
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  };
}