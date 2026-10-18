# PayForge — Production Readiness Audit

**Repository:** `/Users/apple/Projects/payforge-backend`
**Commit:** `e1e7978` (branch `main`)
**Date:** 2026-10-18
**Scope:** Ledger correctness, payment lifecycle, refunds, payouts, merchant onboarding, webhooks, FX, SDK packages, operations, testing.

**Verdict: NOT PRODUCTION-READY.** Four defects are independently capable of losing or stranding real money. None of them is fixed by connecting a real payment provider.

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Method and confidence](#2-method-and-confidence)
3. [As-built architecture](#3-as-built-architecture)
4. [End-to-end logic](#4-end-to-end-logic)
   - [Flow A — Merchant onboarding](#flow-a--merchant-onboarding-registration--approval--api-key)
   - [Flow B — Payment and settlement](#flow-b--payment-creation--charge--bank-callback--settlement)
   - [Flow C — Refund](#flow-c--refund)
   - [Flow D — Payout](#flow-d--payout)
   - [Flow E — Outbound webhook delivery](#flow-e--outbound-webhook-delivery)
   - [Flow F — FX quote](#flow-f--fx-quote)
   - [Flow G — Authentication](#flow-g--authentication)
5. [Verdict matrix](#5-verdict-matrix)
6. [Critical defects and fixes](#6-critical-defects-and-fixes)
7. [High-severity defects](#7-high-severity-defects)
8. [Medium and low severity](#8-medium-and-low-severity)
9. [Release gate](#9-release-gate)
10. [Remediation roadmap](#10-remediation-roadmap)

---

## 1. Executive summary

### The headline finding

The original architectural assessment placed the ledger at the top of the risk list, describing it as "multiple flows modify balances" requiring "atomic, double-entry postings."

**That diagnosis is inverted.** The ledger's concurrency and integrity work is the *strongest* engineering in this repository. What actually exists:

- `BigInt` minor units on every money column; `decimal.js` confined to the boundary
- `SELECT … FOR UPDATE` row locks with consistent merchant-then-platform ordering
- Atomic `increment`/`decrement` rather than read-modify-write
- Compare-and-set on the money field itself (`refundedAmount`)
- A database-level **append-only trigger** on the ledger table
- `CHECK` constraints on balances, amounts and refund bounds
- A **partial unique index** (`Transactions_one_open_per_payment`) that structurally prevents double-charging

**154 tests pass across 9 suites.** This is not a scaffold. It is a mature codebase with specific, locatable defects.

### Where the money actually goes

| Rank | Defect | Loss mode |
|---|---|---|
| **1** | Payouts debit the merchant and never execute, while emitting `PAYOUT_PAID` | Money destroyed; merchant told it succeeded |
| **2** | `splitProRata` is truncating division, not largest-remainder | Fee leaked on every partial refund; final refund can become impossible |
| **3** | A merchant-settable 100% fee produces `net = 0`, violating `CHECK (amount > 0)` | Settlement wedges permanently; payment un-chargeable forever |
| **4** | `Merchants.mode` is never written; KYC `APPROVED` is unreachable | No live mode exists; unvetted merchants take money |

All four are **reachable today** with the mock adapter, in a sandbox, with no external dependency.

### What is genuinely finished

Stated plainly, because a report that only lists defects misrepresents the codebase:

- Append-only ledger enforced at the database, not just by convention
- Exact fee split with a property-based test asserting `fee + net === gross`
- HMAC-SHA256 outbound signing with timestamp, event-id-as-nonce, and `timing-safe` comparison — contract-tested against the SDK
- API keys: SHA-256 hashed, shown once, scope allowlist, 404-not-403 on cross-tenant reads
- JWT with explicit algorithm allowlist; bcrypt cost 12; single-use refresh rotation
- PCI chokepoint where `SanitizedCard` structurally cannot carry a PAN
- Pino structured logging with key-name redaction and `AsyncLocalStorage` request correlation

---

## 2. Method and confidence

Every critical and high finding below was verified by direct file read or executable simulation. Findings marked **[verified]** were confirmed by running code. Findings marked **[reported]** come from delegated analysis and should be spot-checked before remediation.

The simulated results in §6.2 were produced by executing the extracted algorithm against concrete inputs.

---

## 3. As-built architecture

### Module map

```
src/
├── common/
│   ├── auth/request-user.ts          Principal shape (user | apiKey)
│   ├── config/                      Env validation, rate-limit buckets
│   ├── crypto/crypto.ts             API-key + token generation
│   ├── guards/
│   │   ├── auth.guard.ts            Global. JWT or x-api-key → RequestUser
│   │   ├── authorization.guard.ts   @Roles / @Scopes enforcement
│   │   └── jwt-token-verifier.ts    Verifier interface seam
│   ├── idempotency/                 stableHash, key assertions (helpers only)
│   ├── money/money.ts               Minor-unit conversion, splitFee
│   ├── webhooks/signing.ts          Outbound HMAC
│   └── filters/, logger/, scopes/, pagination/, validation/
├── database/                        PrismaService, shutdown hooks
└── modules/
    ├── auth/          Register, login, refresh, logout, sessions
    ├── merchants/     Profile, KYC submit, fee schedule
    ├── payments/      Payment creation (quote), cancel, client-session
    ├── transactions/  Charge attempt (bank call), card validation
    ├── webhooks/      Inbound bank callback → settlement; outbound dispatch
    │                  └── settlement.service.ts  ← all ledger writes
    ├── payouts/       Payout creation, markPaid/markFailed (dead)
    ├── refunds/       Refund controller → delegates to settlement
    ├── fx/            Daily rate cron, quoteSettlement
    ├── apikeys/       Issue / list / revoke
    ├── admin/         Merchant + user administration
    ├── bank/          BankPort interface + MockBankAdapter
    ├── health/        Liveness + readiness
    └── dev/           Opt-in mock bank settle endpoint
```

### Bank port — the seam is correct

`src/modules/bank/bank.port.ts` defines the right contract, including documentation that anticipates exactly the defects found later:

```typescript
export interface BankPort {
  createCharge(input: {...}): Promise<{ gatewayRef: string }>;
  voidCharge(input: { gatewayRef: string; reason: string }): Promise<{ voided: boolean }>;
  refund(input: {...}): Promise<{ refundRef: string }>;
  createPayout(input: {...}): Promise<{ externalRef: string }>;
  createTokenizationSession(input: {...}): Promise<{ sessionId: string }>;
}
```

The interface comment at `bank.port.ts:33-38` states:

> Reverse settled funds at the bank. **Without this, a refund only moves the internal ledger: the customer's card is never actually credited back.**

The seam was designed correctly. **It was never wired.**

### Bank port call sites **[verified]**

```
$ grep -rn "this\.bank\." src/ --include="*.ts"
src/modules/transactions/transaction.service.ts:154:      createCharge   ✓ wired
src/modules/transactions/transaction.service.ts:253:      voidCharge     ✓ wired
```

`BankPort.refund` and `BankPort.createPayout` have **zero call sites**. `MockBankAdapter` implements them (`mock-bank.adapter.ts:51,61`) and nothing invokes them.

### Database money invariants **[verified]**

From `prisma/migrations/20260401000000_baseline/migration.sql`:

```sql
:790  CHECK ("Ledgers"."amount" > 0)
:793  CHECK ("MerchantBalance"."balance" >= 0 AND "pending" >= 0)
:794  CHECK ("PlatformAccount"."balance" >= 0)
:786  CHECK ("Payments"."refundedAmount" <= "settlementAmount")
:807  CREATE UNIQUE INDEX "Transactions_one_open_per_payment"
         ON "Transactions" ("paymentId")
         WHERE "status" IN ('PENDING','SUCCESS');

:817  CREATE TRIGGER "Ledgers_append_only"
         BEFORE UPDATE OR DELETE ON "Ledgers"
         FOR EACH ROW EXECUTE FUNCTION payforge_forbid_mutation();
```

These are production-grade. The append-only trigger makes ledger mutation physically impossible at the database level — not merely discouraged.

### The journal is not double-entry **[verified]**

`prisma/schema.prisma:277-297` — the ledger model:

```prisma
// Append-only money journal. Exactly two rows per movement (MERCHANT + PLATFORM).
model Ledgers {
  id           String        @id @default(uuid())
  account      LedgerAccount   // MERCHANT | PLATFORM
  accountKey   String
  currency     String
  amount       BigInt
  type         LedgerType      // CREDIT | DEBIT
  referenceId  String
  balanceAfter BigInt?
  ...
  @@unique([account, accountKey, referenceId, type])
}
```

The comment implies double-entry. The implementation does not deliver it.

**Settlement posts two CREDIT legs** — `settlement.service.ts:314-333`:

```typescript
await writeLedger(tx, { account: LedgerAccount.MERCHANT, ..., type: LedgerType.CREDIT, ... });
await writeLedger(tx, { account: LedgerAccount.PLATFORM, ..., type: LedgerType.CREDIT, ... });
```

Both legs are `CREDIT`. There is no customer or PSP-clearing account, so `Σ debits ≠ Σ credits` for every settlement in the system. Total credits equal gross revenue; total debits are zero.

**Payouts post one unpaired DEBIT** — `payout.service.ts:111-125`:

```typescript
// A payout moves money, so it gets ledger rows like any other
// movement. The merchant leg is a debit; the platform leg is a debit
// against the merchant's own funds leaving the platform.
await tx.ledgers.create({
  data: {
    account: 'MERCHANT',
    type: 'DEBIT',
    referenceId: created.publicId,
  },
});
```

The comment describes two legs. **One is written.** Money leaves the merchant's ledger and appears nowhere else.

Additionally, `Ledgers.referenceId` is a bare string with no foreign key and no journal identifier. The two rows are paired only by convention — `grep 'journalId|entrySet|groupId'` returns nothing.

---

## 4. End-to-end logic

### Flow A — Merchant onboarding: registration → approval → API key

```
POST /auth/register/merchant
  │
  ├─ ensureEmailAvailable()                        auth.service.ts:76
  ├─ bcrypt.hash(password, 12)                     auth.service.ts:77
  └─ prisma.$transaction
       ├─ Merchants.create {
       │    status: 'PENDING_REVIEW',
       │    mode:   'TEST',        ← default, NEVER WRITTEN ELSEWHERE
       │    settlementDelayDays: 2 ← NEVER READ BY ANY LOGIC
       │ }
       ├─ MerchantKyc.create { status: 'NOT_STARTED' }
       └─ Users.create { role: 'MERCHANT', merchantId }

POST /merchants/me/kyc                              merchant.service.ts:118
  └─ merchantKyc.upsert { status: 'SUBMITTED' }     ← HARD-CODED
     reviewedAt / reviewedById: NEVER WRITTEN

POST /admin/merchants/:publicId/approve             admin.service.ts:300
  └─ setMerchantStatus(actorId, publicId, 'ACTIVE', 'APPROVE_MERCHANT')
       └─ merchants.update { status: 'ACTIVE' }     ← UNCONDITIONAL
          No KYC read. No sanctions check. No provider check.
          No `mode` write. No transition validation.

POST /api-keys                                       api-key.service.ts:43
  └─ generateApiKey(mode)                            crypto.ts:76
       raw = `pf_${mode}_${prefix}_${secret}`       24-byte prefix, 32-byte secret
       stored = SHA-256(raw)                        ← never stored plaintext
       returned once, never re-displayed
```

**Defect.** `Merchants.mode` has no write site anywhere in the repository **[verified]**:

```
$ grep -rn "mode:" src/modules/{merchants,admin,auth}/ --include="*.ts"
src/modules/merchants/merchant.service.ts:18:   mode: true,      ← Prisma select
src/modules/merchants/merchant.service.ts:193:  mode: merchant.mode,  ← read
src/modules/admin/admin.service.ts:263:          mode: true,      ← Prisma select
src/modules/admin/admin.service.ts:276:          mode: merchant.mode,  ← read
```

Every occurrence is a `select` or a read. Therefore `livemode: payment.merchant.mode === 'LIVE'` (`transaction.service.ts:122`) is **permanently false**, and the test-BIN block at `card-validation.ts:99` is unreachable. A merchant in "live" mode accepts test cards; a merchant can never be promoted to live even by hand.

**Defect.** `KycStatus.APPROVED` and `.REJECTED` are unreachable. The only write to `merchantKyc` in the codebase is `merchant.service.ts:118-122`, hardcoded to `'SUBMITTED'`. There is no admin KYC review endpoint — `AdminController` has no KYC route at all. Consequently `reviewedAt` and `reviewedById` are read-only columns.

---

### Flow B — Payment creation → charge → bank callback → settlement

```
POST /payments                                      @Roles(Role.USER)
  │
  ├─ assertIdempotencyKey()                         payment.service.ts:59
  ├─ user.status !== ACTIVE → ACCOUNT_SUSPENDED     :61
  ├─ stableHash({merchant, amount, currency})       :65
  ├─ replay check on (userId, idempotencyKey)      :71
  ├─ merchant lookup; status !== ACTIVE            :84-92
  │     → MERCHANT_CANNOT_RECEIVE
  ├─ fx.ratesForToday()                             :94
  ├─ quoteSettlement() → freezes rate onto row      :95-101
  ├─ feeBasisPointsFor(merchantId)                  :103
  └─ payments.create {
        amount:            quote.chargedMinor,       ← PAYER currency
        settlementAmount:  quote.settlementMinor,    ← MERCHANT currency
        feeBasisPoints,                              ← snapshotted here
        expiresAt: now + 30 min,
        status: 'CREATED'
      }
     P2002 → re-read, return replayed               :129-137


POST /transactions                                  @Roles(Role.USER)
  │
  ├─ payment.expiresAt <= now → PAYMENT_EXPIRED     transaction.service.ts:71
  ├─ payment.merchant.status !== ACTIVE              :68
  │
  ├─ details = token ? tokenDetails()
  │          : savedMethod ? fromSavedMethod()
  │          : sanitizeDetails({ livemode: mode==='LIVE' })   :108-123
  ├─ payloadHash({payment, method, details})         :125
  ├─ replay check (userId, idempotencyKey)          :132
  ├─ open-attempt check (PENDING|SUCCESS)            :141
  │
  ├─ ⚠ bank.createCharge({                          :154
  │      amountMinor: payment.settlementAmount,     ← SETTLEMENT currency
  │      currency:    payment.settlementCurrency,
  │      idempotencyKey  ← RAW caller header, un-namespaced
  │    })
  │
  └─ prisma.$transaction
       ├─ SELECT id FROM Payments WHERE id=… FOR UPDATE   :184
       ├─ re-check open attempt inside the lock           :186
       ├─ transactions.create { status: PENDING }         :210
       └─ payments.update { status: PENDING }             :215
     catch P2002 → re-read, decide (replay or 409)  :226-238
     catch other → voidOrphanedCharge()              :242-247
```

```
POST /webhooks/bank                                  @Public, HMAC-verified
  │
  └─ SettlementService.settle(body)                  settlement.service.ts:41
       ├─ lookup by gatewayRef                       :42
       ├─ already SUCCESS/FAILED → replay or 409     :49-60
       ├─ VOIDED/EXPIRED → TRANSACTION_FINALIZED     :61-66
       ├─ splitFee(amount, {basisPoints})            :72
       │
       └─ prisma.$transaction
            ├─ CAS transactions PENDING → body.status        :76
            ├─ if SUCCESS: CAS payments → SUCCESS            :100
            │     count === 0 → return 'payment_not_payable' :114
            │        ⚠ TRANSACTION IS ALREADY SUCCESS. NO MONEY MOVED.
            ├─ post() → applyBalance + applyPlatform
            │           + 2 ledger rows (both CREDIT)         :314-333
            └─ return 'applied'
       
       ⚠ dispatchPaymentEvent() runs AFTER COMMIT      :152-157
          If it throws → 500 to bank → bank retries
          → settle() returns { replayed: true } → NEVER RE-DISPATCHES
```

**Defect — settlement currency charged to the card.** `transaction.service.ts:154-155` charges the bank `payment.settlementAmount` in `payment.settlementCurrency`. But `payment.service.ts:111-112` persists `amount` in the *payer's* currency. For an INR merchant quoting a USD payer $100.00, the card is debited `x INR` — a different amount in a different currency than the payer authorised, with no disclosure at the point of charge. `fx-math.ts:20-25` argues the *prior* bug was that "the merchant absorbed the FX risk"; this implementation moves that risk silently onto the customer.

**Defect — stranded settlement.** When `paid.count === 0` (`settlement.service.ts:107-114`), the transaction has already been flipped to `SUCCESS` at `:76-86`, but `post()` at `:126-137` is skipped entirely. Customer's money is captured at the bank, merchant is credited nothing, platform takes no fee, **zero ledger rows exist**. Only a `log.error`. Reachable via `cancelPayment`, which cancels `PENDING` payments without checking for an open transaction (`payment.service.ts:178-184`) — while `transaction.service.ts:215-218` sets a payment to `PENDING` the moment a transaction is created.

---

### Flow C — Refund

```
POST /payments/:publicId/refund                      @Scopes(REFUNDS_WRITE)
  │
  └─ SettlementService.refund()                     settlement.service.ts:170
       ├─ payment must be SUCCESS or PARTIALLY_REFUNDED  :187-192
       ├─ transaction = first SUCCESS transaction        :194
       ├─ alreadyRefunded = payment.refundedAmount       :199
       ├─ requested = input.amountMinor ?? remaining     :201
       │
       └─ prisma.$transaction
            ├─ CAS payments.refundedAmount = alreadyRefunded  :226
            ├─ pull() → applyBalance -net
            │         applyPlatform -fee
            │         + 2 DEBIT ledger rows                 :341-363
            ├─ Refund.create                             :257
            └─ Resolution.create

     ⚠ NO call to bank.refund() — the cardholder is never credited.
     ⚠ NO pre-check of an existing Refund by idempotency key.
```

**Defect — refunds never reach the bank.** `SettlementService`'s constructor (`settlement.service.ts:25-28`) injects only `PrismaService` and `WebhookDispatcher`. There is no `@Inject(BANK_PORT)`. The refund credits the merchant's internal balance while the customer's card is never charged back — **the merchant absorbs the real cost of every refund.**

**Defect — refund ledger `referenceId` collides.** `settlement.service.ts:246-252`:

```typescript
referenceId: `${transaction.publicId}:${requested.toString()}`,
```

The unique index is `[account, accountKey, referenceId, type]` (`schema.prisma:293`). Two partial refunds **of the same amount** on the same transaction produce an identical `referenceId`. `writeLedger` retries three times with fresh public IDs (`:487-504`), all of which fail the same composite unique, then rolls back. **Refunding ₹100 twice as two separate partial refunds is impossible.**

---

### Flow D — Payout — **WHERE MONEY IS LOST**

```
POST /payouts                                       @Scopes(PAYOUTS_WRITE)
  │
  └─ PayoutService.create()                         payout.service.ts
       ├─ destination lookup + currency check        :45-63
       ├─ amountMinor > 0                            :64
       │
       └─ prisma.$transaction
            ├─ SELECT … FROM MerchantBalance FOR UPDATE     :71
            ├─ balance < amount → INSUFFICIENT_BALANCE       :80
            ├─ Payout.create { status: 'SCHEDULED' }         :93
            ├─ merchantBalance.decrement(amount)             :106
            ├─ Ledgers.create { MERCHANT, DEBIT }  ← 1 row   :114
            └─ Resolution.create { PAYOUT_CREATED }          :127

       ⚠ dispatchPayoutEvent({ type: 'PAYOUT_PAID' })        :144
          └─ status is still SCHEDULED. NO MONEY HAS MOVED.

       ═══════════════════════════════════════════════════
       NOTHING FURTHER HAPPENS. EVER.
       ═══════════════════════════════════════════════════
```

**Verified dead code:**

```
$ grep -rn "markPaid\|markFailed" src/ --include="*.ts"
src/modules/payouts/payout.service.ts:182:  async markPaid(...)     ← definition
src/modules/payouts/payout.service.ts:208:  async markFailed(...)   ← definition
```

**Zero callers.** `BankPort.createPayout` is never invoked. There is no scheduled payout job. There is no admin route to drive a payout manually.

**Net effect:** the merchant's balance is debited, one unpaired ledger row is written, a `PAYOUT_PAID` webhook fires telling the merchant's integration the money was sent — and then nothing. The money has been destroyed in the ledger, never transferred, never reconciled, and never reported as failed.

---

### Flow E — Outbound webhook delivery

```
dispatchPayoutEvent / dispatchPaymentEvent
  │
  └─ enqueue()                                      webhook-dispatcher.service.ts:153
       ├─ filter endpoints status = 'ACTIVE'         :153-154
       ├─ eventId = evt_<32 hex>                     :17-19
       ├─ payload = canonical(timestamp, eventId, body)
       └─ WebhookDelivery.create { status: 'PENDING', nextAttemptAt: now }

setInterval(60s)                                     webhook.module.ts:24
  └─ deliverDue()                                    :202
       ├─ findMany { status: 'PENDING', nextAttemptAt <= now }, take 50
       ├─ ⚠ NO endpoint status filter — disabled endpoints still receive
       ├─ CAS claim: PENDING → FAILED, attempts++    :209-219
       └─ attempt()
            ├─ attemptNumber = delivery.attempts + 1  :230
            ├─ POST with 10s AbortController
            ├─ response.ok → status DELIVERED          :258
            ├─ !response.ok → scheduleRetry(backoff)   :270
            └─ attemptNumber >= 8 → markDead()        :289
```

Backoff is correct — full-jitter exponential, capped at 6h (`:22-29`). `DEAD` is persisted and queryable, and a manual `redeliver` endpoint exists (`webhook-endpoint.service.ts:132-149`). The mechanism is sound.

**Defect — crashed deliveries strand forever.** The claim flips the row to `FAILED` at `:212` *before* the HTTP call, and it is only moved back by `scheduleRetry` (`:302`) or the success write (`:259-267`). The sweep query at `:203` reads only `status: 'PENDING'`. A process kill, OOM, or pod eviction between the claim and the terminal write leaves the row in `FAILED` permanently — there is no lease, no `nextAttemptAt` bump, and no reaper.

This directly falsifies the class comment at `:58-61`:

```typescript
onModuleInit(): void {
  // Sweep anything left PENDING by a process restart.
```

Rows left by a restart are `FAILED`, not `PENDING`.

**Defect — duplicate send.** The success `update` at `:258-267` is inside the `try`, so a transient database error *after* a successful POST is caught at `:271` and converted into `scheduleRetry`. The merchant already received `2xx`; PayForge records failure and re-POSTs the same `eventId` later.

**Defect — phantom auto-disable.** The doc at `:49-51` claims the endpoint is auto-disabled after `MAX_ATTEMPTS`. `markDead` (`:317-323`) sets only `status: 'DEAD'`. `grep -rn "disabledReason" src/` returns nothing — the field is never written. A permanently-broken endpoint burns 7 sweeps per event, forever.

---

### Flow F — FX quote

```
@Cron('7 0 * * *')                                   fx.service.ts:36
  └─ fetchAndStore() → ExchangeRateSnapshot.create

ratesForToday()                                      fx.service.ts:53
  ├─ row = findUnique({ rateDate: utcDateOnly() })
  ├─ if (!row):
  │    previous = latestSnapshot()                  :61
  │      = findFirst({ orderBy: rateDate desc })    :80-82
  │      ⚠ NO AGE CHECK ON THIS PATH
  │    return previous                              :65
  ├─ ageDays = (now - row.rateDate) / 86_400_000    :68
  ├─ if ageDays > 5 → EXCHANGE_RATES_UNAVAILABLE    :69-74
  └─ return row
```

**Defect — the stale-rate guard does not apply where staleness occurs.** The age check at `:68-74` runs only on the primary branch, where `row` was fetched by *today's* date — so `ageDays ≈ 0` always and the guard is effectively unreachable. The fallback path, which is the only path where rates can actually be old, calls `latestSnapshot()` with **no age bound whatsoever**.

If the FX provider is down for a week, PayForge quotes and settles every cross-currency payment at a week-old rate, silently. The code comment says "yesterday's rate"; the code says "any rate ever stored."

---

### Flow G — Authentication

```
POST /auth/register/user|merchant   → bcrypt(12) + Session + JWT(1h, sid)
POST /auth/login                    → lockout after 8 fails / 15 min
POST /auth/refresh                  → rotate: issue new, then revoke old
POST /auth/logout                   → revoke session row
```

JWT configuration is correct (`auth.module.ts:16-17`):

```typescript
signOptions:   { expiresIn: '1h', issuer: 'payforge', audience: 'payforge-api' },
verifyOptions: { issuer: 'payforge', audience: 'payforge-api', algorithms: ['HS256'] },
```

**Defect — logout does not revoke the access token.** The JWT carries `sid` (`auth.service.ts:163`), but `auth.guard.ts:138-143` reads only `payload.sub` and never consults `Session.revokedAt`. `POST /auth/logout`, documented as *"Revoke the current session"*, leaves the access token usable for a **full hour**.

**Defect — refresh reuse detection is inert and non-atomic.** `auth.service.ts:190-196` comments that reuse *"results in full revocation"* — the code revokes nothing beyond the already-revoked row. Worse, `issueSession()` executes *before* the revoke and neither is inside a transaction, so two concurrent refreshes with the same token both pass the `!revokedAt` check and both mint valid sessions.

**Defect — no password change or reset exists.** `Users.passwordChangedAt` is declared (`schema.prisma:27`) and never read. A merchant whose password leaks cannot rotate it.

---

## 5. Verdict matrix

| # | Area | Verdict | Blocking? |
|---|---|---|---|
| 1 | Ledger concurrency control | **COMPLETE** | — |
| 2 | Money representation (BigInt, decimal.js) | **COMPLETE** | — |
| 3 | Database money invariants + append-only | **COMPLETE** | — |
| 4 | Webhook signing | **COMPLETE** | — |
| 5 | PCI card chokepoint | **COMPLETE** | — |
| 6 | API key crypto & storage | **COMPLETE** | — |
| 7 | Cross-tenant isolation | **COMPLETE** | — |
| 8 | **Double-entry ledger** | **MISSING** | Yes |
| 9 | **Payout execution** | **BROKEN** | **Yes — C1** |
| 10 | **Refund → bank execution** | **BROKEN** | **Yes — C2** |
| 11 | **Fee-split arithmetic on refund** | **BROKEN** | **Yes — C3** |
| 12 | **Live mode / KYC gating** | **BROKEN** | **Yes — C4** |
| 13 | Reconciliation | **MISSING** | Yes |
| 14 | Scheduled jobs (1 of 5) | **BROKEN** | Yes |
| 15 | FX stale-rate safeguard | **BROKEN** | Yes |
| 16 | `@payforge/react` | **BROKEN** | Yes |
| 17 | `@payforge/node` auth model | **BROKEN** | Yes |
| 18 | Observability / metrics | **MISSING** | Yes |
| 19 | CI / deployment / backup | **MISSING** | Yes |
| 20 | Auth session lifecycle | **PARTIAL** | No |
| 21 | Webhook retry mechanism | **PARTIAL** | No |
| 22 | Test coverage (154 tests) | **PARTIAL** | No |

---

## 6. Critical defects and fixes

### 6.1 C1 — Payouts destroy money and emit a false success webhook

**Severity:** Critical · **Files:** `src/modules/payouts/payout.service.ts`

**Evidence.**

```typescript
// payout.service.ts:100 — created as SCHEDULED
status: 'SCHEDULED',

// payout.service.ts:106 — balance debited immediately
await tx.merchantBalance.update({
  data: { balance: { decrement: input.amountMinor } },
});

// payout.service.ts:114-125 — one unpaired ledger row
await tx.ledgers.create({
  data: { account: 'MERCHANT', type: 'DEBIT', referenceId: created.publicId },
});

// payout.service.ts:144 — tells the merchant the money was sent
await this.webhooks.dispatchPayoutEvent({ payoutId: payout.id, type: 'PAYOUT_PAID' });
```

`markPaid` (`:182`) and `markFailed` (`:208`) have zero callers. `BankPort.createPayout` is never invoked.

**Fix, part 1 — do not emit success at creation.**

```typescript
// payout.service.ts:144 — replace
await this.webhooks.dispatchPayoutEvent({
  payoutId: payout.id,
  type: 'PAYOUT_SCHEDULED',
});
```

**Fix, part 2 — add a payout executor.**

```typescript
// src/modules/payouts/payout-executor.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { BANK_PORT, type BankPort } from '../bank/bank.port';
import { WebhookDispatcher } from '../webhooks/webhook-dispatcher.service';

@Injectable()
export class PayoutExecutor {
  private readonly log = new Logger(PayoutExecutor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bank: BankPort,
    private readonly webhooks: WebhookDispatcher,
  ) {}

  /**
   * Executes payouts that have been scheduled but not yet sent.
   *
   * Rows are claimed with a CAS so that multiple instances can run this
   * concurrently without double-sending. The claim sets IN_TRANSIT, which is
   * excluded by the sweep's own status filter, so a crash mid-flight is visible
   * as a stuck IN_TRANSIT row rather than silently re-sent.
   */
  @Cron('*/1 * * * *', { timeZone: 'UTC' })
  async executeDue(): Promise<void> {
    const due = await this.prisma.payout.findMany({
      where: { status: 'SCHEDULED' },
      orderBy: { createdAt: 'asc' },
      take: 25,
    });

    for (const payout of due) {
      const claimed = await this.prisma.payout.updateMany({
        where: { id: payout.id, status: 'SCHEDULED' },
        data: { status: 'IN_TRANSIT', externalRef: null },
      });
      if (claimed.count === 0) continue; // another instance won the race

      try {
        const external = await this.bank.createPayout({
          amountMinor: payout.amount,
          currency: payout.currency,
          destinationToken: payout.destinationId,
          // Namespace the key so two merchants cannot collide at the bank.
          idempotencyKey: `payout:${payout.publicId}`,
        });
        await this.markPaid(payout.publicId, external.externalRef);
      } catch (error) {
        this.log.error(
          { err: error, payoutId: payout.publicId },
          'payout execution failed at the bank',
        );
        await this.markFailed(payout.publicId, 'BANK_REJECTED');
      }
    }
  }

  private async markPaid(publicId: string, externalRef: string) {
    await this.prisma.payout.update({
      where: { publicId },
      data: { status: 'PAID', externalRef, paidAt: new Date() },
    });
    const row = await this.prisma.payout.findUniqueOrThrow({ where: { publicId } });
    await this.webhooks.dispatchPayoutEvent({ payoutId: row.id, type: 'PAYOUT_PAID' });
  }

  /**
   * Reverses the balance debit taken at schedule time and posts the
   * compensating credit, so a failed payout cannot leave the merchant short.
   */
  private async markFailed(publicId: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const payout = await tx.payout.update({
        where: { publicId },
        data: { status: 'FAILED', failureReason: reason },
      });

      await tx.merchantBalance.upsert({
        where: { merchantId_currency: { merchantId: payout.merchantId, currency: payout.currency } },
        create: { merchantId: payout.merchantId, currency: payout.currency, balance: payout.amount },
        update: { balance: { increment: payout.amount } },
      });

      await tx.ledgers.create({
        data: {
          publicId: generatePublicId('pf-ledger'),
          account: 'MERCHANT',
          accountKey: payout.merchantId,
          merchantId: payout.merchantId,
          currency: payout.currency,
          amount: payout.amount,
          type: 'CREDIT',
          referenceId: `payout-reversal:${payout.publicId}`,
        },
      });
    });
  }
}
```

**Fix, part 3 — pair the payout ledger rows.** In `payout.service.ts`, replace the single-row write at `:114-125` with a balanced pair, adding a `MERCHANT_CLEARING` account to the enum:

```prisma
enum LedgerAccount {
  MERCHANT
  PLATFORM
  MERCHANT_CLEARING   // NEW — counterparty for outbound settlement
}
```

---

### 6.2 C2 — `splitProRata` leaks fee on partial refunds **[verified by simulation]**

**Severity:** Critical · **File:** `src/modules/webhooks/settlement.service.ts:367-386`

The docstring claims largest-remainder. The code is truncating division:

```typescript
/**
 * Uses the largest-remainder method so that N partial refunds which together
 * equal the full amount always reverse exactly the original fee and net —
 * naive rounding would leak or over-debit by a minor unit per refund.
 */
export function splitProRata(totalFee, totalNet, totalGross, part) {
  if (totalGross <= 0n) return { fee: 0n, net: 0n };
  const fee = (totalFee * part) / totalGross;   // ← truncates
  const net = part - fee;
  return { fee, net };
}
```

**Executed proof:**

```
A) gross=300, fee=100, net=200 — refund 100 three times
   → feeReversed=99 (original 100), netReversed=201 (original 200)
   → merchant over-debited 1 minor unit

B) gross=3, fee=1, net=2 — refund 1 three times
   → feeReversed=0 (original 1), netReversed=3 (original 2)
   → platform retains the ENTIRE fee on a fully-refunded payment
```

Case B is the dangerous one. The platform keeps 100% of fee income on a payment that was refunded in full.

**Escalation path:** the 1-unit over-debit can drive `MerchantBalance.balance` to 0. At that point the `CHECK (balance >= 0)` guard plus the `INSUFFICIENT_BALANCE` throw at `settlement.service.ts:425-430` makes the **final partial refund impossible**. The customer keeps the goods and the money.

**Fix — cumulative rounding.** The standard correction is to compute against the *cumulative* refunded total and subtract what was already reversed, so the final refund lands exactly on the original split:

```typescript
/**
 * Split a settled amount pro rata between fee and net.
 *
 * Uses cumulative rounding: the split is computed against the running total
 * refunded so far, and the delta from what has already been reversed is
 * returned. When the cumulative refund reaches the gross amount, the deltas
 * sum to exactly the original fee and net — plain per-refund division
 * truncates and leaks a minor unit per partial refund.
 */
export function splitProRata(
  totalFee: bigint,
  totalGross: bigint,
  part: bigint,
  alreadyRefunded: bigint,
): { fee: bigint; net: bigint } {
  if (totalGross <= 0n || part <= 0n) {
    return { fee: 0n, net: 0n };
  }

  const cumulative = alreadyRefunded + part;
  const feeCumulative = (totalFee * cumulative) / totalGross;
  const netCumulative = cumulative - feeCumulative;

  const feePrevious = (totalFee * alreadyRefunded) / totalGross;
  const netPrevious = alreadyRefunded - feePrevious;

  return {
    fee: feeCumulative - feePrevious,
    net: netCumulative - netPrevious,
  };
}
```

**Verification of the fix:**

```
gross=300, fee=100: refund 100 ×3
  r1 (already=0):   fee=33 net=67
  r2 (already=100): fee=33 net=67
  r3 (already=200): fee=34 net=66
  total:            fee=100 ✓  net=200 ✓

gross=3, fee=1: refund 1 ×3
  r1 (already=0):   fee=0 net=1
  r2 (already=1):   fee=0 net=1
  r3 (already=2):   fee=1 net=0
  total:            fee=1 ✓  net=2 ✓
```

**Required call-site change** at `settlement.service.ts` — pass `alreadyRefunded`:

```typescript
const { fee, net } = splitProRata(
  existing.fee,
  existing.amount,
  requested,
  alreadyRefunded,        // ← new argument
);
```

`totalNet` is no longer needed — it is derivable as `totalGross - totalFee`, and passing it invites the two arguments to disagree.

**Add a property test** asserting the invariant:

```typescript
it('never leaks fee across N partial refunds summing to gross', () => {
  for (const [gross, fee] of [[300n, 100n], [3n, 1n], [999n, 200n], [7n, 7n]]) {
    let refFee = 0n, refNet = 0n, already = 0n;
    const unit = gross / 3n;
    for (let i = 0; i < 3n; i++) {
      const part = i === 2n ? gross - already : unit;
      const r = splitProRata(fee, gross, part, already);
      refFee += r.fee; refNet += r.net; already += part;
    }
    expect(refFee).toBe(fee);
    expect(refNet).toBe(gross - fee);
  }
});
```

---

### 6.3 C3 — A 100% fee permanently wedges settlement **[verified]**

**Severity:** Critical · **Files:** `src/common/money/money.ts:97-100`, `merchant.dto.ts:93-94`, `migration.sql:790`

The merchant can self-serve their own platform fee:

```typescript
// merchant.dto.ts:93-94
@Min(0)
@Max(10000)
basisPoints!: number;
```

`merchant.service.ts:126-146` writes it straight through to `MerchantFeeSchedule` **and** `Merchants.defaultFeeBasisPoints`. The DB allows it (`migration.sql:797`: `BETWEEN 0 AND 10000`). `splitFee` then clamps:

```typescript
if (fee > gross) {
  fee = gross;
}
return { fee, net: gross - fee };   // net === 0n
```

`net = 0n` is written to `Ledgers`, and `migration.sql:790` enforces `CHECK ("amount" > 0)`. **Both `post()` and `pull()` throw, rolling back the entire settlement.**

Reachable at ordinary rates too: `net = 0` requires `bps >= 10000 - 5000/gross`. For a **one-cent charge** (`gross = 1`), that is `bps >= 5000` — **a 50%-fee merchant taking a $0.01 payment permanently wedges it.**

Failure mode: the bank webhook 500s, the transaction stays `PENDING`, and `Transactions_one_open_per_payment` then blocks every future charge on that payment. **The customer is charged and PayForge is permanently stuck**, with no reconciliation to surface it.

**Fix, part 1 — fail loudly instead of producing an unrepresentable split.**

```typescript
// src/common/money/money.ts — splitFee
export function splitFee(
  gross: bigint,
  schedule: FeeSchedule = { basisPoints: 200 },
): { fee: bigint; net: bigint } {
  if (gross <= 0n) {
    throw new Error('Cannot split a non-positive amount');
  }
  let fee = (gross * BigInt(schedule.basisPoints) + 5000n) / 10000n;
  if (schedule.minFeeMinor != null && fee < schedule.minFeeMinor) {
    fee = schedule.minFeeMinor;
  }
  if (schedule.maxFeeMinor != null && fee > schedule.maxFeeMinor) {
    fee = schedule.maxFeeMinor;
  }
  if (fee > gross) {
    fee = gross;
  }
  const net = gross - fee;

  // net === 0 cannot be written to the ledger: Ledgers has CHECK (amount > 0).
  // Surfacing it here produces a diagnosable error instead of a bank-webhook
  // 500 with the transaction stuck PENDING and the payment permanently
  // un-chargeable behind Transactions_one_open_per_payment.
  if (net <= 0n) {
    throw new Error(
      `Fee schedule yields a zero net amount for gross=${gross}. ` +
      `basisPoints must leave at least 1 minor unit to the merchant.`,
    );
  }
  return { fee, net };
}
```

**Fix, part 2 — bound the merchant-settable range.**

```typescript
// src/modules/merchants/dto/merchant.dto.ts
// A 100% fee yields net === 0, which the ledger cannot represent.
// Cap below the ceiling so a merchant can never self-serve an unwritable state.
@Min(0)
@Max(9900)
basisPoints!: number;
```

**Fix, part 3 — enforce at the database.**

```sql
ALTER TABLE "MerchantFeeSchedule"
  ADD CONSTRAINT "MerchantFeeSchedule_basis_points_ceiling"
  CHECK ("basisPoints" <= 9900);
```

---

### 6.4 C4 — No live mode exists; KYC approval is unreachable

**Severity:** Critical · **Files:** `prisma/schema.prisma:115`, `admin.service.ts:333-366`, `merchant.service.ts:118-122`

The only server-side gate between an unvetted merchant and live money is `merchant.status === 'ACTIVE'` — one unconditional admin status flip with no KYC, risk, sanctions, or provider-onboarding precondition.

**Fix, part 1 — record external provider status.**

```prisma
model MerchantProviderAccount {
  id                     String    @id @default(uuid())
  publicId               String    @unique
  merchantId             String    @unique
  provider               String                          // 'stripe', 'razorpay', …
  providerAccountId      String?                         // acct_… from the PSP
  onboardingStatus       ProviderOnboarding @default(NOT_STARTED)
  chargesEnabled         Boolean   @default(false)
  payoutsEnabled         Boolean   @default(false)
  lastSyncedAt           DateTime?
  createdAt              DateTime  @default(now())
  updatedAt              DateTime  @updatedAt

  merchant Merchants @relation(fields: [merchantId], references: [id], onDelete: Cascade)
}

enum ProviderOnboarding {
  NOT_STARTED
  PENDING
  RESTRICTED     // provider onboarded but funds held
  ENABLED
  DISABLED
}
```

**Fix, part 2 — add risk and compliance fields.**

```prisma
model MerchantRisk {
  id                String   @id @default(uuid())
  merchantId        String   @unique
  riskScore         Int      @default(0)
  sanctionsChecked  Boolean  @default(false)
  sanctionsCheckedAt DateTime?
  pepChecked        Boolean  @default(false)
  pepCheckedAt      DateTime?
  chargebackRate    Float    @default(0)
  updatedAt         DateTime @updatedAt
}
```

**Fix, part 3 — gate approval.**

```typescript
// src/modules/admin/admin.service.ts — replace approveMerchant
/**
 * Activate a merchant.
 *
 * Approving inside PayForge is not the same as being approved by a bank or
 * payment provider. Live mode additionally requires: KYC approved, risk
 * screening clear, and the external provider reporting charges + payouts
 * enabled. Recording provider status is what lets us refuse to take money on
 * a merchant the PSP has actually restricted.
 */
async approveMerchant(actorId: string, publicId: string) {
  const merchant = await this.prisma.merchants.findUnique({
    where: { publicId },
    include: { kyc: true, risk: true, providerAccount: true },
  });
  if (!merchant) throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);

  if (!merchant.kyc || merchant.kyc.status !== 'APPROVED') {
    throw ApiError.of(
      ErrorCode.VALIDATION_FAILED,
      'Merchant KYC must be approved before the account can be activated.',
    );
  }
  if (!merchant.risk?.sanctionsChecked || !merchant.risk?.pepChecked) {
    throw ApiError.of(
      ErrorCode.VALIDATION_FAILED,
      'Sanctions and PEP screening must be completed before activation.',
    );
  }
  if (
    merchant.providerAccount &&
    (!merchant.providerAccount.chargesEnabled || !merchant.providerAccount.payoutsEnabled)
  ) {
    throw ApiError.of(
      ErrorCode.VALIDATION_FAILED,
      'The payment provider has not enabled charging and payouts for this merchant.',
    );
  }

  return this.setMerchantStatus(actorId, publicId, AccountStatus.ACTIVE, ResolutionAction.APPROVE_MERCHANT);
}
```

**Fix, part 4 — add the missing KYC review endpoint.**

```typescript
// src/modules/admin/admin.controller.ts
@Post('merchants/:publicId/kyc/review')
@Roles(Role.SUPER_ADMIN)
@ApiOperation({ summary: 'Approve or reject a merchant KYC submission' })
reviewKyc(
  @CurrentUser() actor: RequestUser,
  @Param('publicId') publicId: string,
  @Body() dto: ReviewKycDto,
) {
  return this.admin.reviewKyc(actor.id, publicId, dto);
}
```

```typescript
// src/modules/admin/admin.service.ts
async reviewKyc(actorId: string, publicId: string, dto: { decision: 'APPROVE' | 'REJECT'; reason?: string }) {
  const merchant = await this.prisma.merchants.findUnique({ where: { publicId } });
  if (!merchant) throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);

  return this.prisma.$transaction(async (tx) => {
    await tx.merchantKyc.update({
      where: { merchantId: merchant.id },
      data: {
        status: dto.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        rejectionReason: dto.decision === 'REJECT' ? dto.reason ?? null : null,
        reviewedAt: new Date(),
        reviewedById: actorId,
      },
    });
    await tx.resolution.create({
      data: {
        publicId: generatePublicId('pf-res'),
        actorId,
        actorType: 'USER',
        action: dto.decision === 'APPROVE' ? 'KYC_APPROVED' : 'KYC_REJECTED',
        subjectType: 'MERCHANT',
        subjectPublicId: publicId,
        metadata: dto.reason ? { reason: dto.reason } : {},
      },
    });
  });
}
```

**Fix, part 5 — enforce live mode on the charge path.**

```typescript
// src/modules/transactions/transaction.service.ts:118-123 — replace
// Derived from the *merchant's* environment, not the payer's credential.
const liveMerchant = payment.merchant.mode === 'LIVE';

if (liveMerchant) {
  const provider = await this.prisma.merchantProviderAccount.findUnique({
    where: { merchantId: payment.merchant.merchantId },
  });
  if (!provider?.chargesEnabled) {
    throw ApiError.of(
      ErrorCode.MERCHANT_CANNOT_RECEIVE,
      'The payment provider has not enabled charging for this merchant.',
    );
  }
}
```

---

## 7. High-severity defects

### H1 — The ledger is not double-entry

Both settlement legs are `CREDIT`; payouts write a single unpaired `DEBIT`. There is no clearing account, so `Σ debits ≠ Σ credits` globally and no invariant can tie recorded money to cash held. See §3.

### H2 — FX fallback quotes at unbounded-age rates

`fx.service.ts:57-66`. See Flow F. **Fix:**

```typescript
if (!row) {
  const previous = await this.latestSnapshot();
  if (!previous) {
    throw ApiError.of(ErrorCode.EXCHANGE_RATES_UNAVAILABLE);
  }
  const ageDays = (Date.now() - previous.rateDate.getTime()) / 86_400_000;
  if (ageDays > MAX_SNAPSHOT_AGE_DAYS) {
    // Fail closed. Settling at a stale rate silently misprices every
    // cross-currency payment, which is worse than refusing to quote.
    throw ApiError.of(
      ErrorCode.EXCHANGE_RATES_UNAVAILABLE,
      'No exchange rate within the permitted age window. Please retry shortly.',
    );
  }
  return { rateDate: previous.rateDate, rates: previous.rates as Record<string, number> };
}
```

Also add intra-day retry so a single failure at 00:07 UTC does not cost 24 hours:

```typescript
@Cron('7 0,6,12,18 * * *', { timeZone: 'UTC' })   // was: '7 0 * * *'
async refreshDaily() { /* unchanged body */ }
```

### H3 — A settlement webhook can be permanently lost

`settlement.service.ts:152-157` dispatches *after* the transaction commits. If `enqueue` throws, the controller returns 500, the bank retries, and `settle()` hits the replay branch at `:49-55` — which returns `{ replayed: true }` **without re-dispatching**. The merchant is never told the payment succeeded.

**Fix — record the dispatch requirement inside the transaction.**

```typescript
// settlement.service.ts — inside the $transaction, after post()
if (outcome === 'applied') {
  // Enqueue INSIDE the transaction so a failure rolls the settlement back and
  // the bank's retry re-runs it, rather than committing money and losing the
  // notification.
  await this.webhooks.dispatchPaymentEvent({
    paymentId: existing.paymentId,
    type: succeeded ? 'PAYMENT_SUCCEEDED' : 'PAYMENT_FAILED',
  });
}
```

### H4 — Cancel can strand a captured charge with no ledger entry

`payment.service.ts:178-184` cancels `PENDING` payments without checking for an open transaction, but `transaction.service.ts:215-218` sets `PENDING` as soon as one exists. A later success webhook then hits `paid.count === 0` → `'payment_not_payable'` → **no money movement, no ledger row.**

**Fix.**

```typescript
// payment.service.ts:178 — add an open-transaction guard
const open = await this.prisma.transactions.findFirst({
  where: { paymentId: payment.id, status: { in: ['PENDING', 'SUCCESS'] } },
  select: { id: true },
});
if (open) {
  throw ApiError.of(
    ErrorCode.PAYMENT_FINALIZED,
    'This payment has a charge in flight and can no longer be cancelled.',
  );
}
```

### H5 — Webhook deliveries strand in `FAILED` after a crash

`webhook-dispatcher.service.ts:209-219`. See Flow E. **Fix — add a lease reaper.**

```typescript
// Claim with a lease timestamp instead of an immediate status flip.
const claimed = await this.prisma.webhookDelivery.updateMany({
  where: {
    id: row.id,
    OR: [
      { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
      // Reclaim anything stuck mid-flight from a dead process.
      { status: 'FAILED', updatedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
    ],
  },
  data: { status: 'PENDING', nextAttemptAt: new Date(Date.now() + 5 * 60_000) },
});
```

### H6 — Refunds never reach the bank

`SettlementService` has no `BANK_PORT` injection. **Fix.**

```typescript
// settlement.service.ts — constructor
constructor(
  private readonly prisma: PrismaService,
  private readonly webhooks: WebhookDispatcher,
  @Inject(BANK_PORT) private readonly bank: BankPort,
) {}

// settlement.service.ts — refund(), before the $transaction
const refundRef = await this.bank.refund({
  gatewayRef: transaction.gatewayRef,
  amountMinor: requested,
  currency: transaction.currency,
  idempotencyKey: `refund:${input.idempotencyKey}`,
});
```

Because the bank call must precede the ledger transaction (the same pattern as `createCharge`), a failure there must void nothing — `refund` is non-reversible — but must be surfaced and reconciled.

### H7 — `@payforge/react` depends on a global that does not exist

`packages/react/src/index.ts:83` is the only reference to `globalThis.PayForgeFields` in the repository **[verified]**. There is no static asset serving, no `public/` directory, and no URL in `.env.example`. The package cannot function.

**Two options.** Either vendor the fields script and serve it:

```typescript
// src/main.ts — add before the global prefix
import { useStaticAssets } from '@nestjs/platform-express';

app.useStaticAssets(join(__dirname, 'public'), {
  prefix: '/fields/',
  maxAge: '1h',
});
```

…with `public/payforge-fields.js` defining `window.PayForgeFields`, or **remove the package** until a real PSP integration exists. Shipping a non-functional React package to npm is worse than not shipping it.

### H8 — `@payforge/node`'s core methods always return 403

`payments.create` is `@Roles(Role.USER)` (`payment.controller.ts:41`) and `transactions.create` likewise (`transaction.controller.ts:31`), but API-key principals are hardcoded `role: 'MERCHANT'` (`auth.guard.ts:122`).

**Fix — allow merchant API keys to create payments on behalf of a payer.**

```typescript
// payment.controller.ts:41
@Roles(Role.USER, Role.MERCHANT, Role.SUPER_ADMIN)
@Scopes(Scope.PAYMENTS_WRITE)
create(...)
```

If the payer must remain a distinct principal, the Node SDK needs a token option — it currently cannot use the server's JWT auth at all, because `auth.guard.ts:52-57` rejects requests carrying both credentials and the SDK sets `x-api-key` unconditionally.

---

## 8. Medium and low severity

| ID | Defect | Location |
|---|---|---|
| M1 | `AuthorizationGuard` does not implement its documented fail-closed guarantee; `@Authenticated()` is dead metadata | `authorization.guard.ts:11-22` |
| M2 | Logout does not revoke the access token; `sid` never checked | `auth.guard.ts:138-143` |
| M3 | Refresh reuse detection revokes nothing; refresh is non-atomic | `auth.service.ts:190-196` |
| M4 | Refund ledger `referenceId` collides on equal partial refunds | `settlement.service.ts:246-252` |
| M5 | `MerchantBalance.pending` never written; `settlementDelayDays` never read | `settlement.service.ts`, `payout.service.ts:20-27` |
| M6 | `MAX_ATTEMPTS = 8` yields 7 POSTs (claim + attempt double-increment) | `webhook-dispatcher.service.ts:212,230` |
| M7 | Documented auto-disable of broken endpoints does not exist | `webhook-dispatcher.service.ts:49-51` |
| M8 | Disabling an endpoint does not stop already-queued deliveries | `webhook-dispatcher.service.ts:202-207` |
| M9 | Non-2xx response body discarded; no per-attempt history | `webhook-dispatcher.service.ts:270` |
| M10 | `ScheduleModule.forRoot()` called twice — latent crash on a 2nd cron | `app.module.ts:41`, `webhook.module.ts:17` |
| M11 | Sweep fails silently: `.catch(() => undefined)` | `webhook.module.ts:26-33` |
| M12 | No `/metrics`, no tracing, no alerting | repo-wide |
| M13 | No CI, Dockerfile, backup script, or retention/pruning | repo-wide |
| M14 | `merchant.service` lets a merchant zero its own platform fee | `merchant.service.ts:126-146` |
| M15 | `user.merchantId!` non-null assertions → 500 for SUPER_ADMIN | `payout.controller.ts:62,75,…` |
| M16 | Dev settle endpoint's loopback guard reads a spoofable header and defaults to loopback | `dev-bank.controller.ts:43-51` |
| M17 | No password change or reset endpoint | `auth.controller.ts` |
| M18 | `AuthGuard` accepts SUSPENDED users on all but two routes | `auth.guard.ts:145-155` |
| M19 | `ClientSessionService.redeem()` is dead code; hosted-fields PCI path unenforced | `client-session.service.ts:71-98` |
| M20 | Bank idempotency key not namespaced — cross-tenant collision | `transaction.service.ts:154-160` |
| M21 | Merchant can change `countryCode` post-approval with no re-review | `merchant.service.ts:82-103` |
| M22 | No expiry job; `PaymentStatus.EXPIRED` advertised but unreachable | `payment.service.ts:123` |
| M23 | No reconciliation job of any kind | repo-wide |
| M24 | `Merchant` SDK type missing `mode` and `feeSchedule` | `packages/types/src/index.ts:185-197` |
| M25 | No `exports` map in any package; broken source maps; no README/LICENSE | `packages/*/package.json` |

---

## 9. Release gate

**Do not deploy to production.**

Note that C1–C4 are **not** fixed by connecting a real payment provider. They are all reachable today against `MockBankAdapter` in a sandbox, with no external dependency. Provider integration is the *easier* half of the P0 list.

### Blocking criteria

- [ ] **C1** — Payouts execute, or the debit does not happen. Remove the false `PAYOUT_PAID`.
- [ ] **C2** — `splitProRata` uses cumulative rounding; property test passes.
- [ ] **C3** — Fee schedules cannot produce `net = 0`.
- [ ] **C4** — `Merchants.mode` has a write path; KYC review exists; approval is gated.
- [ ] **H6** — Refunds call `BankPort.refund`.
- [ ] **H2** — FX fallback enforces the age bound.
- [ ] **H3** — Webhook dispatch cannot be lost post-commit.
- [ ] Ledger is genuinely double-entry, or the single-entry design is documented and accepted in writing.
- [ ] A reconciliation job exists and has been observed running against a real provider.
- [ ] CI runs `tsc`, `lint`, `jest`, and `prisma migrate diff` drift check.
- [ ] Refund and payout flows demonstrated end-to-end against a real PSP sandbox, including decline and timeout paths.

### The distinction the system must record

Accepting a merchant in PayForge does not mean the merchant is approved by a bank or payment provider. `MerchantProviderAccount` (C4, §6.4) exists to record the external provider's onboarding and activation status independently of PayForge's own approval — so live mode is enabled only when **both** agree.

---

## 10. Remediation roadmap

### Phase 1 — Stop the bleeding (week 1)

Covers the four critical defects. All are localised; no schema migration required except C4.

1. Remove the false `PAYOUT_PAID` dispatch — **one line**, `payout.service.ts:144`
2. Replace `splitProRata` with the cumulative implementation — **one function**, plus its call site
3. Make `splitFee` throw on `net <= 0` and cap `basisPoints` at 9900
4. Add the payout executor (§6.1) and wire it into `PayoutModule`

### Phase 2 — Close the money loop (weeks 2–3)

5. Wire `BankPort.refund` into `SettlementService`
6. Build the reconciliation job — compare `Transactions` against provider statements, assert `Σ ledger == balance`
7. Add payment expiry and a stuck-`PENDING` poller
8. Fix the refund `referenceId` collision
9. Implement genuine double-entry with a clearing account

### Phase 3 — Compliance and live mode (weeks 3–5)

10. Add `MerchantProviderAccount` and `MerchantRisk`
11. Add the KYC review endpoint and gate `approveMerchant`
12. Add a live-mode write path and enforce it on the charge path
13. Bind `ApiKey.mode` to `Merchants.mode`, or delete the field

### Phase 4 — Operability (weeks 5–6)

14. Add `/metrics`; wire bank and FX into `/health/ready`
15. Add CI, Dockerfile, backup/restore script
16. Add the webhook lease reaper; fix the off-by-one attempt budget
17. Add retention/pruning for deliveries, sessions, and login attempts
18. Fix SDK auth; either vendor the fields script or withdraw `@payforge/react`

---

*End of document.*