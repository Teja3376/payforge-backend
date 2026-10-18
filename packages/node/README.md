# @payforge/node

Server SDK for the PayForge API. This package runs on your server and must
never be shipped to a browser.

```bash
npm install @payforge/node
```

## Authenticating

Pass **either** an API key or an access token. The server rejects a request
that carries both credential types, so the SDK refuses the combination at
construction time rather than failing 401 on every call.

```ts
import { PayForge } from '@payforge/node';

// Server-to-server integration
const payforge = new PayForge({ apiKey: process.env.PAYFORGE_API_KEY! });

// Operator / dashboard session
const payforge = new PayForge({ accessToken: 'eyJhbGciOi...' });
```

`accessToken` also accepts a function, so a rotating token works:

```ts
const payforge = new PayForge({ accessToken: () => currentToken() });
```

## Taking a payment

A merchant creates the payment, then hands the customer a client secret so the
card never touches your server.

```ts
const payment = await payforge.payments.create(
  { merchantPublicId: 'PF-MER-...', amount: 100, currency: 'INR' },
  { idempotencyKey: 'order-1001' },
);

const session = await payforge.payments.clientSession({ paymentId: payment.publicId });
// → pass session.clientSecret to the browser, use it with @payforge/react
```

## Idempotency

Every money-moving method takes an `Idempotency-Key`. Replaying the same key
with the same payload returns the original object; replaying it with a
different payload is a `409`.

Retries are only attempted when an idempotency key was supplied. That is
deliberate: retrying a non-idempotent write after an ambiguous failure is how
one order becomes two payments.

## Errors

```ts
import { PayForgeError } from '@payforge/node';

try {
  await payforge.payments.create(input, { idempotencyKey: key });
} catch (error) {
  if (error instanceof PayForgeError) {
    console.error(error.code, error.statusCode, error.requestId);
    if (error.isRetryable) { /* back off and retry */ }
    if (error.isScopeError) { /* API key is missing a scope */ }
  }
}
```
