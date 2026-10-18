# @payforge/types

Shared TypeScript types and enums for the PayForge API. No runtime
dependencies.

```bash
npm install @payforge/types
```

```ts
import { PaymentStatus, WebhookEventType, type Payment } from '@payforge/types';

function onPayment(p: Payment) {
  if (p.status === PaymentStatus.SUCCESS) { /* ... */ }
}
```

These types mirror the API's DTOs. `@payforge/node` and `@payforge/react`
both depend on this package, so importing it directly is only necessary when
you are writing your own client or webhook handler.

> Note: these are hand-maintained mirrors of the server's response shapes. If a
> field is missing or wrong, the server's `dist` DTOs are the source of truth.
