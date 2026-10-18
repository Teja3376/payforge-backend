import { Test } from '@nestjs/testing';
import type { ActorType, Role } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { BANK_PORT } from '../../src/modules/bank/bank.port';
import { PrismaService } from '../../src/database/prisma.service';
import { SettlementService } from '../../src/modules/webhooks/settlement.service';
import { PayoutExecutor } from '../../src/modules/payouts/payout-executor.service';
import { ReconciliationService } from '../../src/modules/reconciliation/reconciliation.service';
import { WebhookDispatcher } from '../../src/modules/webhooks/webhook-dispatcher.service';
import { AdminService } from '../../src/modules/admin/admin.service';
import { RefundService } from '../../src/modules/refunds/refund.service';
import type { RequestUser } from '../../src/common/auth/request-user';
import { makePrisma, resetDatabase, CountingBankAdapter } from '../helpers';

/**
 * Boots the real application against a real database, with a recording bank.
 *
 * Everything below is the genuine code path: NestJS DI resolves the actual
 * modules, Prisma issues actual SQL, and the bank port is the only thing
 * replaced. That is deliberate — the bugs these scenarios hunt for live in the
 * interaction between application code and database behaviour (unique
 * constraints, row locks, compare-and-set), so a mock of either layer would
 * remove the very thing under test.
 */
export type Harness = {
  prisma: PrismaClient;
  prismaService: PrismaService;
  bank: CountingBankAdapter;
  settlement: SettlementService;
  payouts: PayoutExecutor;
  reconciliation: ReconciliationService;
  webhooks: WebhookDispatcher;
  admin: AdminService;
  refunds: RefundService;
  close: () => Promise<void>;
};

export async function createHarness(): Promise<Harness> {
  const bank = new CountingBankAdapter();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(BANK_PORT)
    .useValue(bank)
    .compile();

  const app = moduleRef.createNestApplication();
  // Match production: the version prefix and the validation pipe both change
  // behaviour, and a test that omits them is not testing the real request path.
  app.enableVersioning({ type: 2 as never, defaultVersion: '1' });
  await app.init();

  const prismaService = app.get(PrismaService);
  const prisma = makePrisma();
  await resetDatabase(prisma);

  // `Payments.userId` and `Transactions.userId` are foreign keys onto Users,
  // so the fixtures below need real rows rather than convenient strings.
  await prisma.users.create({
    data: {
      id: PAYER_USER_ID,
      publicId: 'pf-usr-PAYER00000001',
      email: 'payer@payforge.test',
      passwordHash: 'x',
      countryCode: 'IN',
      role: 'USER',
      status: 'ACTIVE',
    },
  });

  return {
    prisma,
    prismaService,
    bank,
    settlement: app.get(SettlementService),
    payouts: app.get(PayoutExecutor),
    reconciliation: app.get(ReconciliationService),
    webhooks: app.get(WebhookDispatcher),
    admin: app.get(AdminService),
    refunds: app.get(RefundService),
    close: async () => {
      await app.close();
      await prisma.$disconnect();
    },
  };
}

// --- Fixtures --------------------------------------------------------------

/** Fixed user ids so fixtures can reference real foreign keys. */
export const PAYER_USER_ID = 'payer-user-id';
export const MERCHANT_USER_ID = 'merchant-user-id';
export const ADMIN_USER_ID = 'admin-user-id';

export type Merchant = { id: string; publicId: string; currency: string };

/**
 * A merchant that can actually take money: ACTIVE, KYC approved, screened,
 * with a provider that has charging and payouts enabled.
 *
 * Since activation is gated on all of these, a test that omits one and expects
 * a payment to succeed would be testing the wrong thing.
 */
export async function seedMerchant(
  prisma: PrismaClient,
  overrides: { status?: string; mode?: string; providerCharges?: boolean } = {},
): Promise<Merchant> {
  const merchant = await prisma.merchants.create({
    data: {
      publicId: `pf-mer-${Math.random().toString(36).slice(2, 14).toUpperCase()}`,
      name: 'Test Merchant',
      email: `m-${Math.random().toString(36).slice(2)}@payforge.test`,
      countryCode: 'IN',
      settlementCurrency: 'INR',
      // Active unless the scenario is specifically testing refusal.
      status: (overrides.status ?? 'ACTIVE') as never,
      mode: (overrides.mode ?? 'TEST') as never,
      defaultFeeBasisPoints: 200,
    },
  });

  await prisma.merchantKyc.create({
    data: { merchantId: merchant.id, status: 'APPROVED', legalName: 'Test Merchant Ltd' },
  });
  await prisma.merchantRisk.create({
    data: { merchantId: merchant.id, sanctionsChecked: true, pepChecked: true },
  });
  await prisma.merchantProviderAccount.create({
    data: {
      publicId: `pf-ppa-${Math.random().toString(36).slice(2, 14).toUpperCase()}`,
      merchantId: merchant.id,
      provider: 'test',
      onboardingStatus: 'ENABLED',
      chargesEnabled: overrides.providerCharges ?? true,
      payoutsEnabled: true,
    },
  });

  // The operator account for this merchant. `merchant.service.submitKyc` and
  // the self-service routes all resolve the merchant from the principal, so
  // the user has to point at the merchant it owns.
  await prisma.users.create({
    data: {
      id: MERCHANT_USER_ID,
      publicId: `pf-usr-${Math.random().toString(36).slice(2, 14).toUpperCase()}`,
      email: `owner-${merchant.publicId.toLowerCase()}@payforge.test`,
      passwordHash: 'x',
      countryCode: 'IN',
      role: 'MERCHANT',
      status: 'ACTIVE',
      merchantId: merchant.id,
    },
  });

  return { id: merchant.id, publicId: merchant.publicId, currency: 'INR' };
}

export function payer(merchantId: string): RequestUser {
  return {
    actorType: 'USER' as ActorType,
    id: PAYER_USER_ID,
    publicId: 'pf-usr-PAYER00000001',
    email: 'payer@payforge.test',
    role: 'USER' as Role,
    status: 'ACTIVE' as never,
    countryCode: 'IN',
    merchantId,
    scopes: [],
  };
}

export function merchantActor(merchantId: string): RequestUser {
  return {
    actorType: 'USER' as ActorType,
    id: MERCHANT_USER_ID,
    publicId: 'pf-usr-MERCHANT000001',
    email: 'merchant@payforge.test',
    role: 'MERCHANT' as Role,
    status: 'ACTIVE' as never,
    countryCode: 'IN',
    merchantId,
    scopes: [],
  };
}

export function adminActor(): RequestUser {
  return {
    actorType: 'USER' as ActorType,
    id: ADMIN_USER_ID,
    publicId: 'pf-usr-ADMIN000000001',
    email: 'admin@payforge.test',
    role: 'SUPER_ADMIN' as Role,
    status: 'ACTIVE' as never,
    countryCode: 'IN',
    merchantId: null,
    scopes: [],
  };
}

/** A settled payment plus the transaction that settled it. */
export async function seedSettledPayment(
  prisma: PrismaClient,
  merchant: Merchant,
  grossMinor = 10_000n,
  feeBps = 200,
): Promise<{ paymentId: string; transactionId: string; gatewayRef: string; gross: bigint }> {
  const fee = (grossMinor * BigInt(feeBps) + 5000n) / 10000n;
  const net = grossMinor - fee;

  const payment = await prisma.payments.create({
    data: {
      publicId: `pf-pay-${Math.random().toString(36).slice(2, 14).toUpperCase()}`,
      userId: PAYER_USER_ID,
      merchantId: merchant.id,
      amount: grossMinor,
      currency: 'INR',
      settlementAmount: grossMinor,
      fxRateDate: new Date('2026-01-01T00:00:00.000Z'),
      usdRate: 83,
      inrRate: 83,
      settlementCurrency: 'INR',
      feeBasisPoints: feeBps,
      status: 'SUCCESS',
      idempotencyKey: `seed-${Math.random()}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });

  const transaction = await prisma.transactions.create({
    data: {
      publicId: `pf-trx-${Math.random().toString(36).slice(2, 14).toUpperCase()}`,
      userId: PAYER_USER_ID,
      paymentId: payment.id,
      status: 'SUCCESS',
      gatewayRef: `seed_${Math.random().toString(36).slice(2, 10)}`,
      idempotencyKey: `seed-trx-${Math.random()}`,
      payloadHash: `hash-${Math.random()}`,
      currency: 'INR',
      amount: grossMinor,
      fee,
      netAmount: net,
      settledAt: new Date(),
    },
  });

  return {
    paymentId: payment.id,
    transactionId: transaction.id,
    gatewayRef: transaction.gatewayRef,
    gross: grossMinor,
  };
}

/** A webhook body as the bank would send it. */
export function settleBody(gatewayRef: string, status: 'SUCCESS' | 'FAILED', extra = {}) {
  return {
    gatewayRef,
    status,
    timestamp: Math.floor(Date.now() / 1000),
    nonce: `n-${Math.random().toString(36).slice(2)}`,
    ...extra,
  };
}