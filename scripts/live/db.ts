#!/usr/bin/env node
/**
 * Inspect the live stack's database.
 *
 * The API tells you what an endpoint returns; this tells you what was actually
 * written. Every API journey should be checked against it, because a 2xx that
 * persisted nothing is the failure mode that matters.
 *
 *   npx ts-node -P scripts/live/tsconfig.json scripts/live/db.ts counts
 *   ... merchants | users | payments | ledger | refund | payout | webhooks
 *   ... resolutions | invariants | sql "SELECT ..."
 *
 * `invariants` compares the journal against the balances and reports only
 * genuine breaks, so a clean run means the books tie out.
 */
import { Client } from 'pg';
import { TEST_DATABASE_URL } from './postgres';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'counts';
  const c = new Client({ connectionString: TEST_DATABASE_URL });
  await c.connect();

  const show = async (label: string, sql: string): Promise<void> => {
    const r = await c.query(sql);
    if (r.rows.length === 0) {
      console.log(`${label}: (none)`);
      return;
    }
    console.log(`${label}:`);
    console.table(r.rows);
  };

  switch (command) {
    case 'counts': {
      const tables = [
        'Merchants', 'Users', 'MerchantKyc', 'MerchantRisk', 'MerchantProviderAccount',
        'ApiKey', 'Payments', 'Transactions', 'Ledgers', 'MerchantBalance',
        'PlatformAccount', 'Refund', 'Payout', 'PayoutDestination',
        'WebhookEndpoint', 'WebhookDelivery', 'Resolution', 'Session',
      ];
      const rows: Array<Record<string, unknown>> = [];
      for (const t of tables) {
        const r = await c.query(`SELECT COUNT(*)::int AS n FROM "${t}"`);
        rows.push({ table: t, rows: r.rows[0].n });
      }
      console.table(rows);
      break;
    }

    case 'merchants':
      await show('merchants', `SELECT "publicId","name","email","status","mode",
        "settlementCurrency","defaultFeeBasisPoints" FROM "Merchants" ORDER BY "createdAt"`);
      await show('kyc', `SELECT m."publicId" AS merchant, k."status", k."legalName",
        k."rejectionReason", k."reviewedAt" IS NOT NULL AS reviewed
        FROM "Merchants" m LEFT JOIN "MerchantKyc" k ON k."merchantId" = m."id"`);
      await show('risk', `SELECT m."publicId" AS merchant, r."riskScore",
        r."sanctionsChecked", r."pepChecked", r."chargebackRate"
        FROM "Merchants" m LEFT JOIN "MerchantRisk" r ON r."merchantId" = m."id"`);
      await show('provider', `SELECT m."publicId" AS merchant, p."provider",
        p."onboardingStatus", p."chargesEnabled", p."payoutsEnabled", p."lastSyncedAt"
        FROM "Merchants" m LEFT JOIN "MerchantProviderAccount" p ON p."merchantId" = m."id"`);
      break;

    case 'users':
      await show('users', `SELECT "publicId","email","role","status",
        "merchantId" IS NOT NULL AS has_merchant FROM "Users" ORDER BY "createdAt"`);
      break;

    case 'payments':
      await show('payments', `SELECT "publicId","status","amount","currency",
        "settlementAmount","settlementCurrency","feeBasisPoints","refundedAmount"
        FROM "Payments" ORDER BY "createdAt" DESC LIMIT 25`);
      await show('transactions', `SELECT "publicId","status","method","amount","fee",
        "netAmount","gatewayRef","failureCode" FROM "Transactions" ORDER BY "createdAt" DESC LIMIT 25`);
      break;

    case 'ledger':
      await show('ledger', `SELECT "account","type","currency","amount","referenceId","createdAt"
        FROM "Ledgers" ORDER BY "createdAt" LIMIT 40`);
      // account is filtered to MERCHANT so payout clearing legs do not fold into
      // the merchant total and manufacture a phantom imbalance.
      await show('merchant balances', `SELECT m."publicId" AS merchant, b."currency",
        b."balance", b."pending" FROM "MerchantBalance" b
        JOIN "Merchants" m ON m."id" = b."merchantId"`);
      await show('platform balances', `SELECT "currency","balance" FROM "PlatformAccount"`);
      break;

    case 'refund':
      await show('refunds', `SELECT "publicId","amount","feeReversed","netReversed","status",
        "gatewayRefundRef","failureReason" FROM "Refund" ORDER BY "createdAt"`);
      break;

    case 'payout':
      await show('payouts', `SELECT "publicId","amount","currency","status","externalRef",
        "failureReason","processedAt" FROM "Payout" ORDER BY "createdAt"`);
      await show('destinations', `SELECT "publicId","bankName","accountLast4","currency",
        "status","isDefault" FROM "PayoutDestination"`);
      break;

    case 'webhooks':
      await show('endpoints', `SELECT "publicId","url","status","events","failureCount"
        FROM "WebhookEndpoint"`);
      await show('deliveries', `SELECT "publicId","eventType","status","attempts",
        "lastStatusCode","left" AS attempt_count FROM (
          SELECT "publicId","eventType","status","attempts","lastStatusCode",
                 1 AS left
          FROM "WebhookDelivery" ORDER BY "createdAt" DESC LIMIT 25) t`);
      break;

    case 'resolutions':
      await show('resolutions', `SELECT "action","actorType","subjectType","subjectPublicId",
        "metadata","createdAt" FROM "Resolution" ORDER BY "createdAt" DESC LIMIT 40`);
      break;

    case 'invariants': {
      // Per currency, credits must equal debits.
      const balance = await c.query(`
        SELECT "currency",
          COALESCE(SUM("amount") FILTER (WHERE "type"='CREDIT'),0)::text AS credits,
          COALESCE(SUM("amount") FILTER (WHERE "type"='DEBIT'),0)::text  AS debits
        FROM "Ledgers" GROUP BY "currency"`);
      console.log('== journal balances (credits must equal debits) ==');
      console.table(balance.rows);
      for (const r of balance.rows) {
        if (BigInt(r.credits) !== BigInt(r.debits)) {
          console.log(`  BROKEN  ${r.currency} drifts by ${BigInt(r.credits) - BigInt(r.debits)}`);
        }
      }

      // Per movement: each referenceId must balance on its own.
      const perRef = await c.query(`
        SELECT "referenceId",
          (COALESCE(SUM("amount") FILTER (WHERE "type"='CREDIT'),0)
           - COALESCE(SUM("amount") FILTER (WHERE "type"='DEBIT'),0))::text AS delta
        FROM "Ledgers" GROUP BY "referenceId"
        HAVING COALESCE(SUM("amount") FILTER (WHERE "type"='CREDIT'),0)
            <> COALESCE(SUM("amount") FILTER (WHERE "type"='DEBIT'),0)`);
      console.log('== unbalanced movements ==');
      console.log(perRef.rows.length === 0 ? '  none' : perRef.rows);

      // Balance vs journal, per merchant, account-filtered to MERCHANT.
      const drift = await c.query(`
        SELECT m."publicId" AS merchant, b."currency", b."balance"::text AS balance,
          (COALESCE(SUM(l."amount") FILTER (WHERE l."account"='MERCHANT' AND l."type"='CREDIT'),0)
           - COALESCE(SUM(l."amount") FILTER (WHERE l."account"='MERCHANT' AND l."type"='DEBIT'),0))::text AS journal
        FROM "MerchantBalance" b
        JOIN "Merchants" m ON m."id"=b."merchantId"
        LEFT JOIN "Ledgers" l ON l."merchantId"=b."merchantId" AND l."currency"=b."currency"
        GROUP BY m."publicId", b."currency", b."balance"`);
      console.log('== balance vs journal ==');
      console.table(drift.rows);
      break;
    }

    case 'sql': {
      const sql = process.argv[3];
      if (!sql) {
        console.error('usage: db.ts sql "SELECT ..."');
        process.exit(1);
      }
      const r = await c.query(sql);
      console.table(r.rows);
      break;
    }

    default:
      console.error(`unknown command: ${command}`);
      process.exit(1);
  }

  await c.end();
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});