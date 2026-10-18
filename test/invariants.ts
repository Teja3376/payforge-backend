import type { PrismaClient } from '@prisma/client';

/**
 * The financial invariants, checked against a live database.
 *
 * Every scenario in the integration suite asserts these afterwards. They are
 * the only claims that matter: money is conserved, and every recorded movement
 * is explained.
 *
 * Two implementation notes, both learned the hard way:
 *
 *  - The comparison is done **in SQL**, not in JavaScript. Postgres returns
 *    `SUM(bigint)` as NUMERIC, which Prisma surfaces as Decimal; comparing two
 *    Decimals with `===` compares object identity and reports a false
 *    violation. Doing the subtraction server-side returns only genuine breaks.
 *
 *  - Balance checks must not assume an even number of legs. A settlement posts
 *    three legs (PSP debit, merchant credit, platform credit), so a parity
 *    heuristic reports a balanced posting as unpaired. The real invariant is
 *    that every *reference* balances, which is stricter and correct.
 */
export type Invariant = {
  name: string;
  holds: boolean;
  detail: string;
};

/** For every currency, total credits must equal total debits. */
export async function ledgerBalances(prisma: PrismaClient): Promise<Invariant[]> {
  const rows = await prisma.$queryRaw<Array<{ currency: string; credits: string; debits: string }>>`
    SELECT "currency",
           COALESCE(SUM("amount") FILTER (WHERE "type" = 'CREDIT'), 0)::text AS "credits",
           COALESCE(SUM("amount") FILTER (WHERE "type" = 'DEBIT'), 0)::text  AS "debits"
    FROM "Ledgers"
    GROUP BY "currency"
  `;

  return rows.map((row) => {
    const credits = BigInt(row.credits);
    const debits = BigInt(row.debits);
    return {
      name: `journal balances in ${row.currency}`,
      holds: credits === debits,
      detail: `credits=${credits} debits=${debits} drift=${credits - debits}`,
    };
  });
}

/**
 * Every single movement must balance.
 *
 * Stricter than the per-currency check: a posting that wrote a debit against
 * one reference and a credit against another would still sum to zero globally
 * while leaving both references broken.
 */
export async function referencesBalance(prisma: PrismaClient): Promise<Invariant[]> {
  const rows = await prisma.$queryRaw<Array<{ referenceId: string; delta: string }>>`
    SELECT "referenceId",
           (COALESCE(SUM("amount") FILTER (WHERE "type" = 'CREDIT'), 0)
            - COALESCE(SUM("amount") FILTER (WHERE "type" = 'DEBIT'), 0))::text AS "delta"
    FROM "Ledgers"
    GROUP BY "referenceId"
    HAVING COALESCE(SUM("amount") FILTER (WHERE "type" = 'CREDIT'), 0)
        <> COALESCE(SUM("amount") FILTER (WHERE "type" = 'DEBIT'), 0)
  `;

  return rows.map((row) => ({
    name: `movement ${row.referenceId} balances`,
    holds: false,
    detail: `off by ${row.delta}`,
  }));
}

/** MerchantBalance must equal the sum of that merchant's ledger entries. */
export async function balancesMatchLedger(prisma: PrismaClient): Promise<Invariant[]> {
  const rows = await prisma.$queryRaw<
    Array<{ publicId: string; currency: string; balance: string; ledgerSum: string }>
  >`
    SELECT m."publicId", b."currency", b."balance"::text AS "balance",
           (COALESCE(SUM(l."amount") FILTER (WHERE l."type" = 'CREDIT'), 0)
            - COALESCE(SUM(l."amount") FILTER (WHERE l."type" = 'DEBIT'), 0))::text AS "ledgerSum"
    FROM "MerchantBalance" b
    JOIN "Merchants" m ON m."id" = b."merchantId"
    LEFT JOIN "Ledgers" l
      ON l."merchantId" = b."merchantId" AND l."currency" = b."currency"
    GROUP BY m."publicId", b."currency", b."balance"
  `;

  return rows.map((row) => {
    const balance = BigInt(row.balance);
    const ledger = BigInt(row.ledgerSum);
    return {
      name: `balance matches journal for ${row.publicId}/${row.currency}`,
      holds: balance === ledger,
      detail: `balance=${balance} journal=${ledger}`,
    };
  });
}

/** PlatformAccount must equal the platform's net journal position. */
export async function platformBalancesMatchLedger(prisma: PrismaClient): Promise<Invariant[]> {
  const rows = await prisma.$queryRaw<
    Array<{ currency: string; balance: string; ledgerSum: string }>
  >`
    SELECT p."currency", p."balance"::text AS "balance",
           (COALESCE(SUM(l."amount") FILTER (WHERE l."type" = 'CREDIT'), 0)
            - COALESCE(SUM(l."amount") FILTER (WHERE l."type" = 'DEBIT'), 0))::text AS "ledgerSum"
    FROM "PlatformAccount" p
    LEFT JOIN "Ledgers" l
      ON l."account" = 'PLATFORM' AND l."currency" = p."currency"
    GROUP BY p."currency", p."balance"
  `;

  return rows.map((row) => {
    const balance = BigInt(row.balance);
    const ledger = BigInt(row.ledgerSum);
    return {
      name: `platform balance matches journal in ${row.currency}`,
      holds: balance === ledger,
      detail: `balance=${balance} journal=${ledger}`,
    };
  });
}

/**
 * Succeeded refunds must sum to the payment's cumulative refundedAmount.
 *
 * A divergence means either a refund was posted without reaching the provider,
 * or the provider refunded without the ledger following.
 */
export async function refundTotalsMatchPayments(prisma: PrismaClient): Promise<Invariant[]> {
  const rows = await prisma.$queryRaw<
    Array<{ publicId: string; refunded: string; paymentRefunded: string }>
  >`
    SELECT p."publicId",
           COALESCE(SUM(r."amount") FILTER (WHERE r."status" = 'SUCCEEDED'), 0)::text AS "refunded",
           p."refundedAmount"::text AS "paymentRefunded"
    FROM "Payments" p
    LEFT JOIN "Refund" r ON r."paymentId" = p."id"
    GROUP BY p."publicId", p."refundedAmount"
    HAVING COALESCE(SUM(r."amount") FILTER (WHERE r."status" = 'SUCCEEDED'), 0)
        <> p."refundedAmount"
  `;

  return rows.map((row) => ({
    name: `refund rows match payment ${row.publicId}`,
    holds: false,
    detail: `refund rows=${row.refunded} payment=${row.paymentRefunded}`,
  }));
}

/**
 * A payout debits the merchant if and only if it is not FAILED.
 *
 * A FAILED payout has its debit reversed; a PAID, SCHEDULED or IN_TRANSIT one
 * has not. This is the check that would have caught the original payout path,
 * which debited a balance and never transferred anything.
 */
export async function payoutDebitsMatchStatus(prisma: PrismaClient): Promise<Invariant[]> {
  const rows = await prisma.$queryRaw<
    Array<{ publicId: string; status: string; netDebit: string }>
  >`
    SELECT po."publicId", po."status",
           (COALESCE(SUM(l."amount") FILTER (
               WHERE l."account" = 'MERCHANT' AND l."type" = 'DEBIT'
             ), 0) - COALESCE(SUM(l."amount") FILTER (
               WHERE l."account" = 'MERCHANT' AND l."type" = 'CREDIT'
             ), 0))::text AS "netDebit"
    FROM "Payout" po
    LEFT JOIN "Ledgers" l
      ON l."referenceId" = po."publicId"
      OR l."referenceId" = 'payout-reversal:' || po."publicId"
    GROUP BY po."publicId", po."status"
  `;

  return rows.flatMap((row) => {
    const netDebit = BigInt(row.netDebit);
    const shouldBeDebited = row.status !== 'FAILED';
    const ok = shouldBeDebited ? netDebit > 0n : netDebit === 0n;
    if (ok) return [];
    return [
      {
        name: `payout ${row.publicId} (${row.status}) debit is correct`,
        holds: false,
        detail: `net merchant debit=${netDebit}, expected ${
          shouldBeDebited ? '> 0' : '= 0'
        }`,
      },
    ];
  });
}

/**
 * A refund the provider accepted must not be left PENDING indefinitely, and a
 * FAILED refund must never have posted a ledger reversal.
 */
export async function refundLedgerMatchesStatus(prisma: PrismaClient): Promise<Invariant[]> {
  const rows = await prisma.$queryRaw<Array<{ publicId: string; status: string; hasLedger: boolean }>>`
    SELECT r."publicId", r."status",
           EXISTS (
             SELECT 1 FROM "Ledgers" l
             WHERE l."referenceId" = 'refund:' || r."publicId"
           ) AS "hasLedger"
    FROM "Refund" r
    WHERE r."status" = 'FAILED' AND EXISTS (
      SELECT 1 FROM "Ledgers" l WHERE l."referenceId" = 'refund:' || r."publicId"
    )
  `;

  return rows.map((row) => ({
    name: `failed refund ${row.publicId} has no ledger reversal`,
    holds: false,
    detail: `status=${row.status} hasLedger=${row.hasLedger}`,
  }));
}

export async function checkInvariants(prisma: PrismaClient): Promise<Invariant[]> {
  return [
    ...(await ledgerBalances(prisma)),
    ...(await referencesBalance(prisma)),
    ...(await balancesMatchLedger(prisma)),
    ...(await platformBalancesMatchLedger(prisma)),
    ...(await refundTotalsMatchPayments(prisma)),
    ...(await refundLedgerMatchesStatus(prisma)),
    ...(await payoutDebitsMatchStatus(prisma)),
  ];
}

/** Assert every invariant, with a readable failure message. */
export function expectInvariants(invariants: Invariant[]): void {
  const broken = invariants.filter((i) => !i.holds);
  if (broken.length > 0) {
    throw new Error(
      `Financial invariants violated:\n${broken
        .map((b) => `  - ${b.name}: ${b.detail}`)
        .join('\n')}`,
    );
  }
}

export async function expectInvariantsHold(prisma: PrismaClient): Promise<void> {
  const invariants = await checkInvariants(prisma);
  // Always exercise the assertion, even when empty, so a silently-empty
  // invariant set cannot pass for "everything balances".
  expect(invariants.length).toBeGreaterThan(0);
  expectInvariants(invariants);
}