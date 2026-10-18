<p align="center">
  <strong>PayForge</strong><br>
  <em>Multi-currency payment orchestration for platforms and marketplaces.</em>
</p>

<p align="center">
  <a href="#what-payforge-does">What it does</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-to-use-it">How to use it</a> ·
  <a href="#core-concepts">Concepts</a> ·
  <a href="#api-reference">API reference</a> ·
  <a href="#building-blocks">npm packages</a>
</p>

---

## What PayForge is

PayForge is the payment layer you put **between your customers and a bank**.

Your customer pays 1,580 JPY. Your merchant is based in India and wants to be
paid in rupees. PayForge handles the messy middle:

```
  Customer ──── pays 1,580 JPY ────► PayForge ──── settles ₹950.75 ────► Merchant
                                    │
                                    ├─ freezes today's FX rate for 30 minutes
                                    ├─ charges a 2% platform fee
                                    ├─ writes an auditable double-sided ledger
                                    └─ tells you over a signed webhook
```

Without it you would build, and get wrong, all of this yourself: multi-currency
quoting, rate locking, an append-only money ledger, partial refunds, merchant
payouts, scoped API credentials, signed webhooks, and PCI-compliant card entry.

### Who it is for

- **SaaS platforms** collecting on behalf of many merchants.
- **Marketplaces** splitting a charge between sellers and a platform.
- **Cross-border sellers** who charge in one currency and settle in another.

### What it is not

- **Not a gateway.** It sits in front of one. The bank adapter ships as a mock;
  you plug in a real PSP behind the `BANK_PORT` interface.
- **Not an npm-installable server.** The server is a hosted service. What we
  publish is a thin [toolkit](#building-blocks) around it.

---

## Quick start

### 1. Run the server

```bash
git clone <your-repo> payforge-backend && cd payforge-backend
cp .env.example .env
```

Generate the four secrets it requires:

```bash
for k in JWT_SECRET ENCRYPTION_KEY WEBHOOK_SIGNING_KEY BANK_WEBHOOK_SECRET; do
  echo "$k=$(openssl rand -hex 32)"
done
```

Paste them into `.env`, set `SUPER_ADMIN_PASSWORD` (12+ characters), then:

```bash
npm install
npm run prisma:deploy
npm run start:dev
```

Check it came up:

```bash
curl localhost:3000/v1/health/ready
# {"status":"ok","database":"up","latencyMs":4}
```

Interactive API docs: **<http://localhost:3000/docs>**

### 2. Onboard a merchant

```bash
curl -X POST localhost:3000/v1/auth/register/merchant \
  -H 'content-type: application/json' \
  -d '{"name":"Northwind Trading Ltd",
       "email":"ops@northwind.example",
       "password":"correct-horse-battery-staple",
       "countryCode":"IN"}'
```

```json
{
  "publicId": "PF-USR-84JJVVGYTF3R",
  "role": "MERCHANT",
  "merchant": { "publicId": "PF-MER-84JJVVGYTF3R", "status": "PENDING_REVIEW" }
}
```

Merchants start **pending** and cannot receive money until an administrator
approves them:

```bash
curl -X POST localhost:3000/v1/admin/merchants/PF-MER-84JJVVGYTF3R/approve \
  -H "authorization: Bearer $SUPER_ADMIN_TOKEN"
```

### 3. Issue an API key

```bash
curl -X POST localhost:3000/v1/api-keys \
  -H "authorization: Bearer $MERCHANT_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"checkout service","scopes":["payments:read","payments:write"],"mode":"TEST"}'
```

```json
{
  "publicId": "PF-KEY-3NQ8RVT7XM2P",
  "prefix": "pf_test_a1b2c3d4e5f6_…",
  "key": "pf_test_a1b2c3d4e5f6_9f2c1a…",
  "status": "ACTIVE"
}
```

> **The `key` is shown once.** Only a SHA-256 digest is stored. If you lose it,
> revoke and issue a new one — it cannot be recovered.

---

## How to use it

The fastest path is the npm SDK, which wraps the HTTP API.

```bash
npm install @payforge/node
```

```ts
import PayForge from '@payforge/node';

const payforge = new PayForge({
  apiKey: process.env.PAYFORGE_API_KEY!,
  baseUrl: 'https://api.your-domain.com/v1',
});
```

---

### Recipe 1 — take a payment (the core flow)

There are **two objects**, and keeping them straight is the whole game:

| Object | What it means | Who creates it |
|---|---|---|
| **Payment** | *An intent.* A quoted, frozen amount the customer intends to pay. | Your backend |
| **Transaction** | *An attempt* to collect that payment with a specific method. | Your backend |

One payment can have several transactions (customer tried card, it failed, tried
UPI, succeeded) but **at most one open at a time**.

```ts
// 1. Create the payment. Freezes the FX quote and reserves the amount.
const payment = await payforge.payments.create(
  {
    merchantPublicId: 'PF-MER-84JJVVGYTF3R',
    amount: 1580,
    currency: 'JPY',
    description: 'Order #1001',
    metadata: { orderId: '1001' },
  },
  { idempotencyKey: `order-1001` },   // ← required, always
);

// 2. Attempt the charge.
const transaction = await payforge.transactions.create(
  {
    paymentPublicId: payment.publicId,
    method: 'CARD',
    savedPaymentMethodId: 'PF-PM-…',   // or inline card details
  },
  { idempotencyKey: `txn-1001` },
);

// 3. Wait for the webhook — do not poll.
```

**Always pass an `Idempotency-Key`.** Every money-moving endpoint requires one.
Replaying the same key returns the original result instead of charging twice;
replaying it with a *different* payload returns `409`. That makes retries free:

```ts
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    return await payforge.payments.create(body, { idempotencyKey: `order-${orderId}` });
  } catch (error) {
    if (error instanceof PayForge.PayForgeError && error.isRetryable) continue;
    throw error;
  }
}
```

### Recipe 2 — accept cards without touching card data (recommended)

The raw path — `card: { cardNumber, cvv }` — sends the PAN through your server,
which puts you in **full PCI DSS scope**. Use hosted fields instead and the PAN
never reaches you:

```ts
// Your backend mints a short-lived, single-use secret.
app.post('/checkout/start', async (_req, res) => {
  const session = await payforge.clientSession({ paymentId });
  res.json({ clientSecret: session.clientSecret });
});
```

```tsx
// Your frontend mounts the provider iframe with it.
import { createCardController } from '@payforge/react';

const card = createCardController({ clientSecret });

const result = await card.tokenize();
// → { status: 'success', gatewayToken: 'tok_…', brand: 'VISA', last4: '4242' }
```

Then charge the token instead of the card:

```ts
await payforge.transactions.create(
  {
    paymentPublicId: payment.publicId,
    method: 'CARD',
    gatewayToken: result.gatewayToken,   // ← charge the token, not a card number
  },
  { idempotencyKey: `txn-${orderId}` },
);
```

> This is the single highest-leverage change you can make: it takes you from a
> full PCI audit to **SAQ A**.

### Recipe 3 — react to payments with webhooks

Poll loops are slow and fragile. Register an endpoint and let PayForge push.

```bash
curl -X POST localhost:3000/v1/webhooks/endpoints \
  -H "authorization: Bearer $MERCHANT_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/webhooks/payforge",
       "events":["PAYMENT_SUCCEEDED","PAYMENT_FAILED","PAYMENT_REFUNDED"]}'
```

The response includes a `secret`. **Store it.**

```ts
import express from 'express';
import { parseWebhookEvent } from '@payforge/node';

app.post('/webhooks/payforge', express.raw({ type: 'application/json' }), (req, res) => {
  const result = parseWebhookEvent({
    payload: req.body.toString('utf8'),   // raw bytes — do NOT re-serialise
    header: req.headers['x-payforge-signature'] as string,
    secret: process.env.PAYFORGE_WEBHOOK_SECRET!,
  });

  if (!result.valid) {
    console.warn('rejected webhook:', result.reason);
    return res.status(400).send();        // must be 2xx or we will retry
  }

  // Deduplicate on event.id — at-least-once delivery means duplicates.
  if (await alreadyHandled(result.event.id)) return res.sendStatus(200);

  switch (result.event.type) {
    case 'PAYMENT_SUCCEEDED':
      await fulfilOrder(result.event.data.id);
      break;
  }
  res.sendStatus(200);
});
```

**Three rules that matter:**

1. Read the **raw body**. Parsing and re-serialising changes key order and the
   signature will not match.
2. Verify with the helper. It rejects stale timestamps (5-minute window), so a
   captured delivery cannot be replayed.
3. Return `2xx` fast. Do the work in a queue. We retry with exponential backoff
   for 8 attempts, then mark the delivery dead — you can inspect it at
   `GET /webhooks/endpoints/:id/deliveries` and force a redelivery.

### Recipe 4 — refund

```ts
// Full refund of whatever remains
await payforge.refunds.create(
  { paymentId: 'PF-PAY-XBX3F6YEH28J', reason: 'Customer returned the item' },
  { idempotencyKey: `refund-${orderId}-1` },
);

// Or part of it — the fee is reversed pro rata
await payforge.refunds.create(
  { paymentId: 'PF-PAY-XBX3F6YEH28J', amount: 250.50 },
  { idempotencyKey: `refund-${orderId}-2` },
);
```

Over-refunding is impossible: the database enforces
`refundedAmount <= settlementAmount`, and the merchant's balance is debited in
the same transaction.

### Recipe 5 — get paid out

Money accrues in the merchant's balance and stays there until you withdraw it.

```ts
// 1. Register where the money should go (encrypted at rest, only last4 returned).
await payforge.payouts.addDestination({
  bankName: 'HDFC Bank',
  accountHolder: 'Northwind Trading Ltd',
  accountNumber: '50100234567890',
  routingCode: 'HDFC0001234',
  currency: 'INR',
  isDefault: true,
});

// 2. Withdraw.
await payforge.payouts.create(
  { amount: 50000, currency: 'INR' },
  { idempotencyKey: `payout-2026-10` },
);

// 3. Reconcile against the ledger — this is the authoritative record.
for await (const page of paginate((c) =>
  payforge.merchant.statement({ cursor: c, limit: 100 }))) {
  console.log(page.data);
}
```

### Recipe 6 — paginate anything

Cursor-based, stable under concurrent writes. No offset drift.

```ts
let cursor: string | undefined;
do {
  const page = await payforge.payments.list({ limit: 100, cursor });
  for (const payment of page.data) { /* … */ }
  cursor = page.nextCursor ?? undefined;
} while (cursor);
```

### Recipe 7 — handle errors properly

Every failure looks the same. Branch on `code`, never on `message`:

```ts
import { PayForge } from '@payforge/node';

try {
  await payforge.transactions.create(body, { idempotencyKey });
} catch (error) {
  if (!(error instanceof PayForge.PayForgeError)) throw error;

  switch (error.code) {
    case 'CARD_DECLINED':          return showSoftDecline();
    case 'INSUFFICIENT_BALANCE':   return askMerchantToWait();
    case 'PAYMENT_HAS_OPEN_TRANSACTION':
                                    return pollExisting();
    case 'RATE_LIMITED':           return backOff(error.requestId);
    default:
      logger.error({ code: error.code, requestId: error.requestId }, 'payment failed');
      throw error;
  }
}
```

Quote `error.requestId` to support — it matches the `requestId` in the server
logs, so you can find the exact request.

---

## Core concepts

### Money is never a float

Every amount is an integer in **minor units** (`1580 JPY` → `1580`, `₹950.75` →
`95075`). Floats never touch the database. Conversion happens once, at the
edge, with explicit rounding.

Currencies with unusual exponents (JPY has none, KWD has three) are handled by a
lookup table, not an `if` chain.

### The FX rate is frozen at payment creation

A payment stores `fxRateDate`, `usdRate`, `inrRate`, `settlementAmount` and
`settlementCurrency` at the moment it is created. A transaction created an hour
later still settles at that earlier quote.

Settlement currency is chosen by the **merchant's** country and configuration —
not the payer's. An Indian merchant settles in INR; everyone else settles in
their own currency at the source rate.

### Fees are data, not code

Stored as **basis points** per merchant (`200` = 2.00%). The split always sums
exactly back to the gross amount — `fee + net === gross`, to the last minor
unit. Change a merchant's rate and it applies to their *next* payment;
historical payments keep the rate they captured.

### The ledger is append-only

Every movement writes two rows — one for the merchant, one for the platform —
in the same database transaction as the balance mutation. A Postgres trigger
makes `UPDATE` and `DELETE` on the ledger **impossible**. Mistakes are fixed
with compensating entries, never by rewriting history.

This is why the admin revenue report now agrees with the merchant's own balance
to the paisa.

### Two kinds of credential

| | Session token | API key |
|---|---|---|
| Used by | Humans — dashboards, admin | Your servers |
| Lifetime | 1 hour, 30-day refresh | Until revoked or expired |
| Revocable | Yes, per session | Yes, immediately |
| Scoped | By role | By scope (`payments:read`, …) |

Never ship an API key to a browser. The browser should call **your** backend,
which holds the key.

### Public identifiers

Every object is addressed by an unguessable public ID (`PF-PAY-84JJVVGYTF3R`) —
60 bits of entropy. Internal UUIDs are never exposed.

---

## API reference

56 operations across 10 groups. Full request/response schemas at `/docs`.

| Group | Endpoints |
|---|---|
| **Auth** | register user/merchant, login, refresh, logout, list/revoke sessions |
| **Payments** | create, retrieve, list, cancel |
| **Transactions** | create (charge), retrieve, list |
| **Refunds** | create (full or partial), retrieve, list |
| **Payouts** | create, retrieve, list, destinations |
| **Merchants** | profile, update, KYC, fee schedule, balance statement |
| **API keys** | create, list, revoke, list scopes |
| **Webhooks** | endpoints CRUD, rotate secret, deliveries, redeliver |
| **Admin** | overview, merchants, users, revenue, ledger, audit trail, refunds |
| **Health** | liveness, readiness |

### Conventions

- Base URL: `/v1`. Breaking changes ship as `/v2`; `/v1` never changes meaning.
- Auth: `x-api-key: pf_live_…` or `Authorization: Bearer <token>`.
- Write endpoints: `Idempotency-Key` header required.
- Lists: `?limit=` (max 100) and `?cursor=`, returning
  `{ data, hasMore, nextCursor }`.

### Error envelope

```json
{
  "statusCode": 409,
  "error": "Conflict",
  "code": "PAYMENT_HAS_OPEN_TRANSACTION",
  "message": "This payment already has a transaction in progress.",
  "requestId": "req_9f2c1a7b4e6d0358aa11"
}
```

`code` is stable and safe to branch on. `message` is for humans and may be
reworded. `requestId` is for support.

Common codes: `CARD_INVALID` · `CARD_DECLINED` · `INSUFFICIENT_BALANCE` ·
`PAYMENT_HAS_OPEN_TRANSACTION` · `PAYMENT_NOT_REFUNDABLE` ·
`REFUND_EXCEEDS_REMAINING` · `IDEMPOTENCY_PAYLOAD_MISMATCH` ·
`INSUFFICIENT_SCOPE` · `RATE_LIMITED` · `ACCOUNT_SUSPENDED`.

---

## Building blocks

The server is hosted. These are the packages you install.

| Package | Purpose |
|---|---|
| `@payforge/types` | Shared enums and types. Zero runtime dependencies. |
| `@payforge/node` | Typed server SDK. Thin `fetch` wrapper with typed errors. |
| `@payforge/react` | Hosted-fields bindings — this is what keeps you out of full PCI scope. |
| `@payforge/cli` | `payforge login`, `doctor`, `cards`, `webhook verify`. |

### `@payforge/cli`

```bash
npx payforge login     # store a key for this machine
npx payforge doctor    # check connectivity and list your key scopes
npx payforge cards     # test card numbers (need a TEST-mode key)
```

Test cards are rejected against live keys, so a test number cannot move real
money even by mistake.

---

## Operating PayForge

```bash
npm run start:dev      # watch mode
npm run build          # compile
npm test               # 144 unit tests
npm run prisma:migrate # create + apply a migration (dev)
npm run prisma:deploy  # apply migrations (prod)
npm run prisma:reset   # drop + recreate

bash scripts/e2e.sh    # 34 end-to-end checks against a running server
```

### Deployment checklist

- [ ] **Rotate every value in `.env`** that has been on a shared machine.
- [ ] `ENABLE_DEV_TOOLS=false`. `POST /v1/dev/bank/settle` credits real
      merchant balances and only accepts loopback requests when enabled.
- [ ] `NODE_ENV=production` — this unmounts `/docs`.
- [ ] `CORS_ORIGINS` lists explicit origins (`*` is rejected at boot).
- [ ] TLS terminates in front; HSTS set at the edge.
- [ ] Database backups and point-in-time recovery verified.
- [ ] A real `BANK_PORT` adapter is implemented. **Until you do, no money
      actually moves.**

### Current limitations

Worth knowing before you build on this:

- **The bank adapter is a mock.** Nothing moves real money until you implement
  a real PSP behind `BANK_PORT`.
- **FX is a single provider, refreshed once daily.** One rate per UTC day; a
  payment quoted at 00:01 and charged at 23:59 uses the same rate.
- **Refunds reverse the internal ledger only.** A real adapter must also call
  the bank; `BankPort.refund` exists but is unimplemented.
- **The ledger is a two-sided revenue split**, not a fully balanced general
  ledger — there is no payer or suspense account.
- **No scheduled payouts yet.** `POST /payouts` debits the balance and marks
  the payout `SCHEDULED`; you drive the bank leg.

---

## Architecture

For contributors.

```
src/
  common/        errors, crypto, scopes, pagination, logging, guards, webhooks
  database/      Prisma client and lifecycle
  modules/       auth · payments · transactions · refunds · payouts
                 merchants · apikeys · webhooks · admin · fx · bank · health
packages/        the published npm toolkit
prisma/          schema + migrations
scripts/e2e.sh   end-to-end smoke test
```

**Key decisions, and why:**

- **Money invariants live in the database.** `CHECK (amount > 0)`,
  `balance >= 0`, `refundedAmount <= settlementAmount`. Application checks alone
  are one refactor away from being bypassed.
- **The authorization guard fails closed.** An endpoint with neither `@Roles`
  nor `@Scopes` is unreachable. The previous guard allowed access when no
  metadata was present, so a forgotten decorator silently opened an endpoint.
- **Scope checks apply to API keys only.** A session token is the bootstrap
  path — the operator issuing the first key cannot yet hold a key.
- **Idempotency hashes are key-sorted.** `JSON.stringify` is order-dependent,
  so reordering object keys would turn a legitimate retry into a spurious `409`.
- **Balances are locked with `SELECT ... FOR UPDATE`.** Without it, two
  concurrent credits read the same starting balance and one is lost.
- **Public IDs carry 60 bits**, not the 32 they started with, because they are
  the only identifiers exposed.
- **The pino logger redacts `cardNumber`/`cvv` by key name**, so a third-party
  error object carrying the request body cannot leak them.

---

## License

UNLICENSED — all rights reserved.