# @payforge/react

React bindings for PayForge hosted card fields, so card data never touches your
servers.

```bash
npm install @payforge/react
```

## Setup

The card fields are rendered by an iframe served by your payment processor.
PayForge does not bundle it. Load the script before React mounts:

```html
<script src="https://js.payforge.dev/fields/v1/payforge-fields.js"></script>
```

If you self-host it, point `window.PayForgeFields` at your own copy.

## Usage

Mint a client secret on **your server**, then pass it to the provider:

```tsx
import { PayForgeProvider, usePayForge } from '@payforge/react';

function Checkout() {
  const { card, tokenize, isReady } = usePayForge();

  return (
    <>
      <div ref={card.mount} />
      <button disabled={!isReady} onClick={() => tokenize()}>
        Pay
      </button>
    </>
  );
}

export default function Page({ clientSecret }) {
  return (
    <PayForgeProvider clientSecret={clientSecret}>
      <Checkout />
    </PayForgeProvider>
  );
}
```

## PCI

The client secret is single-use and short-lived. A live PAN and CVV exist only
inside the processor's iframe — never in your JavaScript, never in your logs,
never on your server.

## Test cards

`TEST_CARDS` exports a set of numbers for sandbox testing. They are rejected
when the **merchant** is in `LIVE` mode. (They are not gated on the API key's
mode; that field is informational.)
