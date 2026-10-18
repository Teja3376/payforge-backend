import {
  decodeCursor,
  encodeCursor,
  cursorWhere,
  paginate,
  paginatedQuery,
  PaginationQueryDto,
} from './pagination';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

describe('pagination', () => {
  describe('cursor encoding', () => {
    it('round-trips a cursor', () => {
      const row = { id: 'abc', createdAt: new Date('2026-10-18T10:30:00.000Z') };
      expect(decodeCursor(encodeCursor(row))).toEqual({ id: 'abc', createdAt: row.createdAt });
    });

    it('carries the tiebreak id', () => {
      // Without the id in the cursor, two rows created in the same millisecond
      // cause pages to skip or repeat rows.
      const decoded = decodeCursor(encodeCursor({ id: 'tie-1', createdAt: new Date(0) }));
      expect(decoded?.id).toBe('tie-1');
    });

    it('returns null for absent or malformed cursors', () => {
      expect(decodeCursor(undefined)).toBeNull();
      expect(decodeCursor('')).toBeNull();
      expect(decodeCursor('not-base64-json')).toBeNull();
      expect(decodeCursor(Buffer.from('{"id":"a"}').toString('base64url'))).toBeNull();
      expect(decodeCursor(Buffer.from('{"createdAt":"x","id":"a"}').toString('base64url'))).toBeNull();
    });

    it('is opaque — a client cannot meaningfully hand-edit it', () => {
      const cursor = encodeCursor({ id: 'abc', createdAt: new Date('2026-10-18T10:30:00.000Z') });
      expect(cursor).not.toContain('abc');
    });
  });

  describe('cursorWhere', () => {
    it('is empty when there is no cursor', () => {
      expect(cursorWhere(null, 'desc')).toEqual({});
    });

    it('uses lt for descending and gt for ascending', () => {
      const cursor = { createdAt: new Date('2026-10-18T10:00:00.000Z'), id: 'x' };

      const desc = cursorWhere(cursor, 'desc') as { OR: Array<Record<string, any>> };
      expect(desc.OR[0].createdAt.lt).toBeInstanceOf(Date);
      expect(desc.OR[1].id.lt).toBe('x');

      const asc = cursorWhere(cursor, 'asc') as { OR: Array<Record<string, any>> };
      expect(asc.OR[0].createdAt.gt).toBeInstanceOf(Date);
      expect(asc.OR[1].id.gt).toBe('x');
    });
  });

  describe('paginate', () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: `id-${index}`,
      createdAt: new Date(2026, 0, index + 1),
    }));

    it('trims the over-fetched row and reports more pages', () => {
      const result = paginate(rows, 4);
      expect(result.data).toHaveLength(4);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).not.toBeNull();
    });

    it('returns a null cursor on the last page', () => {
      const result = paginate(rows, 5);
      expect(result.data).toHaveLength(5);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it('handles an empty result set', () => {
      const result = paginate([], 25);
      expect(result.data).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });
  });

  describe('paginatedQuery', () => {
    type Row = { id: string; createdAt: Date; name: string };

    const build = (count: number): Row[] =>
      Array.from({ length: count }, (_, index) => ({
        id: `id-${String(index).padStart(3, '0')}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
        name: `row-${index}`,
      }));

    it('enforces a hard limit of 100', async () => {
      const rows = build(200);
      const result = await paginatedQuery<Row, unknown>({
        scope: {},
        query: async (_where, take) => rows.slice(0, take),
        present: (row) => row,
        limit: 5000,
      });
      expect(result.data.length).toBeLessThanOrEqual(100);
    });

    it('passes the tenant scope into the query', async () => {
      let seen: unknown;
      await paginatedQuery<Row, unknown>({
        scope: { merchantId: 'm-1' },
        query: async (where, take) => {
          seen = where;
          return build(take);
        },
        present: (row) => row,
        limit: 10,
      });
      expect(seen).toMatchObject({ AND: [{ merchantId: 'm-1' }] });
    });

    it('pages deterministically through the whole set', async () => {
      // A tiny in-memory keyset implementation stands in for Postgres so the
      // test exercises the real cursor contract: no row is skipped or repeated
      // across pages, including rows sharing a timestamp.
      const rows = build(30).reverse();
      const seen: string[] = [];
      let cursor: string | undefined;
      let guard = 0;

      while (guard < 20) {
        guard += 1;
        const page = await paginatedQuery<Row, string>({
          scope: {},
          query: async (where, take) => {
            const [scope, keyset] = (where as { AND: Array<Record<string, unknown>> }).AND;
            expect(scope).toEqual({});
            let slice = [...rows];

            const predicate = keyset as
              | { OR: Array<Record<string, any>> }
              | undefined;
            if (predicate?.OR) {
              const first = predicate.OR[0];
              const second = predicate.OR[1];
              const boundary = new Date(first.createdAt.lt);
              const boundaryId = String(second.id.lt);
              slice = slice.filter(
                (row) =>
                  row.createdAt < boundary ||
                  (row.createdAt.getTime() === boundary.getTime() && row.id < boundaryId),
              );
            }
            return slice.slice(0, take);
          },
          present: (row) => row.name,
          limit: 7,
          cursor,
        });

        seen.push(...page.data);
        if (!page.hasMore) {
          break;
        }
        cursor = page.nextCursor ?? undefined;
      }

      expect(seen).toHaveLength(30);
      expect(new Set(seen).size).toBe(30);
    });

    it('does not duplicate rows sharing a timestamp', async () => {
      // Six rows sharing one timestamp — the case a timestamp-only cursor
      // silently drops or repeats. Ordered newest-first to match `desc`.
      const sameInstant = Array.from({ length: 6 }, (_, index) => ({
        id: `id-${String(index).padStart(3, '0')}`,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        name: `row-${index}`,
      })).reverse();

      const seen = new Set<string>();
      let cursor: string | undefined;
      let guard = 0;

      while (guard < 10) {
        guard += 1;
        const page = await paginatedQuery<Row, string>({
          scope: {},
          query: async (where, take) => {
            const [, keyset] = (where as { AND: Array<Record<string, any>> }).AND;
            if (!keyset?.OR) {
              return sameInstant.slice(0, take);
            }
            const boundary = new Date(keyset.OR[0].createdAt.lt);
            const boundaryId = String(keyset.OR[1].id.lt);
            return sameInstant
              .filter(
                (row) =>
                  row.createdAt < boundary ||
                  (row.createdAt.getTime() === boundary.getTime() && row.id < boundaryId),
              )
              .slice(0, take);
          },
          present: (row) => row.id,
          limit: 2,
          cursor,
        });

        page.data.forEach((id) => seen.add(id));
        if (!page.hasMore) break;
        cursor = page.nextCursor ?? undefined;
      }

      expect(seen.size).toBe(6);
    });
  });

  describe('PaginationQueryDto', () => {
    const build = (input: Record<string, unknown>) => {
      const instance = plainToInstance(PaginationQueryDto, input);
      const errors = validateSync(instance as object);
      return { instance, errors };
    };

    it('defaults to 25, descending', () => {
      const { instance, errors } = build({});
      expect(errors).toHaveLength(0);
      expect(instance.limit).toBe(25);
      expect(instance.order).toBe('desc');
    });

    it('coerces a numeric string', () => {
      const { instance, errors } = build({ limit: '50' });
      expect(errors).toHaveLength(0);
      expect(instance.limit).toBe(50);
    });

    it('rejects a non-integer limit', () => {
      expect(build({ limit: 10.5 }).errors.length).toBeGreaterThan(0);
    });

    it('rejects a limit above 100', () => {
      const { errors } = build({ limit: 101 });
      expect(errors.some((e) => /100 or fewer/.test(e.constraints?.max ?? ''))).toBe(true);
    });

    it('rejects a limit below 1', () => {
      expect(build({ limit: 0 }).errors.length).toBeGreaterThan(0);
    });

    it('rejects an over-long cursor', () => {
      expect(build({ cursor: 'x'.repeat(513) }).errors.length).toBeGreaterThan(0);
    });

    it('rejects an unknown order value', () => {
      // Regression: the previous API silently ignored unknown query parameters,
      // so `?page=2` returned 200 with different semantics and no warning.
      const { errors } = build({ order: 'sideways' });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('normalizes the order case', () => {
      expect(build({ order: 'ASC' }).instance.order).toBe('asc');
    });
  });
});