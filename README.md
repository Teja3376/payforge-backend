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

PayForge is an HTTP API at `/v1`. Your application keeps two credentials and uses each for a different job.

| Credential | Who holds it | What it can do |
|---|---|---|
| Customer access token | The signed-in payer (`POST /v1/auth/login`) | Create a payment and attempt a charge |
| Merchant API key (`pf_test_…` or `pf_live_…`) | Your server only | Refunds, payouts, saved payment methods, client sessions, webhook endpoints |

Do not send both headers on one request. A browser never sees the API key: the browser talks to your app, and your app talks to PayForge.

`@payforge/node` currently sends only `x-api-key`. Use it for the merchant routes. Create the payment and the charge with the customer's bearer token until those two routes accept a merchant key.

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
| **Payment** | *An intent.* A quoted, frozen amount the customer intends to pay. | Your backend, with the **customer's** access token |
| **Transaction** | *An attempt* to collect that payment with a specific method. | Your backend, with the **customer's** access token |

One payment can have several transactions (customer tried card, it failed, tried
UPI, succeeded) but **at most one open at a time**.

```bash
# 1. Create the payment with the customer's access token.
#    Amounts on the wire are major units: 1580 JPY, or 950.75 INR.
curl -X POST localhost:3000/v1/payments \
  -H "authorization: Bearer $CUSTOMER_TOKEN" \
  -H 'idempotency-key: order-1001' \
  -H 'content-type: application/json' \
  -d '{"merchantPublicId":"PF-MER-84JJVVGYTF3R","amount":1580,"currency":"JPY"}'

# 2. Attempt the charge with the same token. Prefer a saved method or a
#    client session so the card number never hits your server.
curl -X POST localhost:3000/v1/transactions \
  -H "authorization: Bearer $CUSTOMER_TOKEN" \
  -H 'idempotency-key: txn-1001' \
  -H 'content-type: application/json' \
  -d '{"paymentPublicId":"PF-PAY-…","method":"CARD","savedPaymentMethodId":"PF-PM-…"}'

# 3. Wait for the signed webhook. Do not poll.
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

### Money is never a float in the database

The JSON API speaks **major units** (`amount: 1580` for 1,580 JPY, `amount: 950.75` for ₹950.75). PayForge converts that to an integer minor-unit `BigInt` before it is stored (`1580` yen, `95075` paise). Floats never touch the database. Rounding is half-up, once, at that edge.

Currencies with unusual exponents (JPY has none, KWD has three) are handled by a
lookup table, not an `if` chain.

### The FX rate is frozen at payment creation

A payment stores `fxRateDate`, `usdRate`, `inrRate`, `settlementAmount` and
`settlementCurrency` at the moment it is created. A transaction created an hour
later still settles at that earlier quote.

A charge is converted to INR only when the merchant's country is `IN`, their settlement currency is `INR`, and the customer paid in something else. Every other combination settles in the currency the customer paid.

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

Test card numbers are rejected only when the **merchant's** mode is `LIVE`.
API-key mode does not control that check, and no route currently sets a
merchant to `LIVE`. Approval sets the account to `ACTIVE` and leaves mode `TEST`.

---

## Operating PayForge

```bash
npm run start:dev      # watch mode
npm run build          # compile
npm test               # 148 unit tests
npm run prisma:migrate # create + apply a migration (dev)
npm run prisma:deploy  # apply migrations (prod)
npm run prisma:reset   # drop + recreate

bash scripts/e2e.sh    # 34 end-to-end checks against a running server
```

### Deployment checklist

See **[docs/RUNBOOK.md](docs/RUNBOOK.md)** for the full procedure, incident
playbooks and the metrics to alert on. The short version:

- [ ] **Rotate every value in `.env`** that has been on a shared machine.
- [ ] `ENABLE_DEV_TOOLS=false`. `POST /v1/dev/bank/settle` credits real
      merchant balances.
- [ ] `NODE_ENV=production` — this unmounts `/docs`.
- [ ] `CORS_ORIGINS` lists explicit origins (`*` is rejected at boot).
- [ ] TLS terminates in front; HSTS set at the edge.
- [ ] `scripts/backup.sh` run **and `scripts/restore.sh` rehearsed**. An
      untested backup is not a backup.
- [ ] Prometheus scraping `/v1/health/metrics`, alerting on
      `payforge_ledger_imbalance_minor`.
- [ ] Readiness (`/v1/health/ready`) wired to the orchestrator, liveness
      (`/v1/health`) to the restart probe.
- [ ] A real `BANK_PORT` adapter is implemented and exercised in its sandbox.
      **Until you do, no money actually moves** — but payouts, refunds and
      settlement will all call it correctly.

### Current limitations

Honest list of what is still not production-complete:

- **The bank adapter is a mock.** Nothing moves real money until you implement
  a real PSP behind `BANK_PORT`. Payout execution, provider refunds, and
  charge/refund status reconciliation are all wired to the port and will work
  unchanged against a real adapter — but they have only been exercised against
  the mock.
- **`@payforge/react` needs the hosted-fields script.** It is not bundled,
  because the iframe must come from whichever processor moves the money. See
  the package README for the `<script>` tag.
- **The charge amount is the settlement currency, not the currency the payer
  was quoted.** A USD payer on an INR merchant is debited in INR. This needs a
  product decision — either disclose it at the point of charge, or charge the
  payer their quoted amount and absorb the FX.
- **`settlementDelayDays` and `MerchantBalance.pending` are unused.** Settled
  funds land directly in available balance, so a merchant can withdraw money
  that is still inside the chargeback window. `pending` has no write site.
- **A merchant can set their own platform fee** from 0 to 9900 basis points.
  There is no admin review of that schedule.
- **Charges still cross this server as raw PAN/CVV** on the legacy path
  (`create-transaction.dto`). That keeps any deployment using it in PCI DSS
  SAQ D scope. The tokenized and saved-method paths are the PCI-safe ones.
- **No data retention.** Deliveries, sessions and login attempts grow without
  bound.
- **One provider, one FX source.** No secondary rate provider to fall back to.

### What is production-shaped

- BigInt minor units throughout, `decimal.js` only at the boundary
- Double-entry ledger, append-only, enforced by a database trigger
- `SELECT … FOR UPDATE` balance locks with consistent lock ordering
- Compare-and-set on every money-affecting state transition
- Unique idempotency constraints on payments, transactions, refunds and payouts
- HMAC-SHA256 webhook signing with timestamp, event-id nonce and constant-time
  comparison — contract-tested against the SDK
- Reconciliation proving the journal balances, nightly
- Scheduled payout execution with crash recovery
- Two-phase refunds, so an irreversible provider call is never made speculatively

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
- **Role and scope checks run only when a route declares them.** A session
  token skips `@Scopes`. An API key skips nothing that the route declared.
  Logout and session routes are authenticated and have no role list.
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