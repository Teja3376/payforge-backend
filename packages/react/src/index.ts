import type { ClientSession, SavedPaymentMethod } from '@payforge/types';

/**
 * PayForge React bindings for hosted card fields.
 *
 * The point of this package is PCI: the card number is entered inside the
 * payment provider's iframe and **never transits PayForge's servers**. That
 * keeps an integration out of full PCI DSS scope (SAQ A) instead of dragging it
 * into an annual audit and penetration test.
 *
 * Usage:
 *
 *   const { tokenize, isReady } = usePayForgeCard({ clientSecret });
 *   <PayForgeCardField onTokenize={tokenize} />
 *
 * (The above is illustrative. The shipped API is `PayForgeProvider` plus
 * `usePayForge`, both re-exported from this module.)
 *
 * `clientSecret` must be minted on your server — it is a short-lived,
 * single-use credential and must not be hard-coded in a browser bundle.
 */

export type CardFieldState = 'idle' | 'focused' | 'complete' | 'error';

export type TokenizeResult =
  | { status: 'success'; gatewayToken: string; brand?: string; last4?: string }
  | { status: 'error'; code: string; message: string };

export type PayForgeCardOptions = {
  /** From `POST /payments/client-session` on your server. Single use, 15 min TTL. */
  clientSecret: string;
  /** Provider session id returned alongside the secret. */
  providerSession?: string;
  /** Field configuration passed through to the provider iframe. */
  fields?: { cardholderName?: boolean; billingAddress?: boolean };
  locale?: string;
  /** Fires whenever the field's focus/completeness state changes. */
  onStateChange?: (state: CardFieldState) => void;
};

export type PayForgeCardInstance = {
  mount(container: HTMLElement): Promise<void>;
  tokenize(): Promise<TokenizeResult>;
  focus(): void;
  clear(): void;
  destroy(): void;
};

export type UsePayForgeCardResult = {
  /** Attach the iframe to a DOM node. */
  mount: (container: HTMLElement | null) => Promise<void>;
  /** Exchange the entered card for a single-use gateway token. */
  tokenize: () => Promise<TokenizeResult>;
  focus: () => void;
  clear: () => void;
  destroy: () => void;
  ready: boolean;
  fieldState: CardFieldState;
};

/**
 * Framework-agnostic controller.
 *
 * The actual iframe mounting is delegated to the provider's own script, which
 * is loaded once by the host application. Keeping the controller free of React
 * means it can be tested in isolation and reused outside React.
 */
export function createCardController(options: PayForgeCardOptions): PayForgeCardInstance {
  let instance: unknown = null;
  let mounted = false;
  let state: CardFieldState = 'idle';

  const setState = (next: CardFieldState) => {
    state = next;
    options.onStateChange?.(next);
  };

  void state;

  return {
    async mount(container: HTMLElement) {
      if (mounted) return;
      if (!options.clientSecret) {
        throw new Error('A client secret is required. Mint one on your server first.');
      }

      const factory = resolveFieldsFactory();

      instance = await factory({
        clientSecret: options.clientSecret,
        fields: options.fields ?? { cardholderName: true },
        locale: options.locale ?? 'en',
        onStateChange: setState,
      });
      await (instance as { mount(el: HTMLElement): Promise<void> }).mount(container);
      mounted = true;
    },

    async tokenize() {
      if (!mounted) {
        return { status: 'error', code: 'NOT_MOUNTED', message: 'Mount the card field first.' };
      }
      try {
        const result = (await (instance as { tokenize(): Promise<unknown> }).tokenize()) as {
          token?: string;
          brand?: string;
          last4?: string;
        };
        if (!result?.token) {
          return { status: 'error', code: 'TOKENIZATION_FAILED', message: 'No token was returned.' };
        }
        return {
          status: 'success',
          gatewayToken: result.token,
          brand: result.brand,
          last4: result.last4,
        };
      } catch (error) {
        return {
          status: 'error',
          code: 'TOKENIZATION_FAILED',
          message: error instanceof Error ? error.message : 'Card entry failed.',
        };
      }
    },

    focus() {
      (instance as { focus?: () => void } | null)?.focus?.();
    },

    clear() {
      (instance as { clear?: () => void } | null)?.clear?.();
      setState('idle');
    },

    destroy() {
      (instance as { destroy?: () => void } | null)?.destroy?.();
      instance = null;
      mounted = false;
      setState('idle');
    },
  };
}

/**
 * Locate the hosted-fields factory.
 *
 * The global is supplied by the script tag on the merchant's checkout page:
 *
 *   <script src="https://js.payforge.dev/fields/v1/payforge-fields.js"></script>
 *
 * PayForge does not bundle or vendor it, because the iframe that captures card
 * data has to come from whichever processor actually moves the money. Until
 * PayForge is pointed at a live processor there is nothing to serve, so this
 * resolves `window.PayForgeFields` and nothing else.
 *
 * The error names the script tag explicitly. The previous message said only
 * "Add the provider <script> tag", with no URL and no hint about which
 * provider, which left the most common integration failure undiagnosable.
 */
function resolveFieldsFactory(): (config: unknown) => Promise<unknown> {
  const injected = (globalThis as Record<string, unknown>).PayForgeFields;
  if (typeof injected === 'function') {
    return injected as (config: unknown) => Promise<unknown>;
  }

  throw new Error(
    'PayForge Fields is not loaded.\n\n' +
      'Add this to your checkout page before React mounts:\n\n' +
      '  <script src="https://js.payforge.dev/fields/v1/payforge-fields.js"></script>\n\n' +
      'It must load before you call mount(). If you self-host it, point\n' +
      'window.PayForgeFields at your own copy.',
  );
}

/**
 * Test card numbers.
 *
 * These are rejected when the *merchant* is in LIVE mode — the test-BIN block
 * reads `Merchants.mode`, not the API key's mode. (An earlier version of this
 * comment said "TEST-mode API key", which described a control that does not
 * exist: `ApiKey.mode` is stored and displayed but never enforced.)
 */
export const TEST_CARDS = [
  { brand: 'Visa', number: '4111111111111111', cvv: '123', expiry: '12/34' },
  { brand: 'Mastercard', number: '5555555555554444', cvv: '123', expiry: '12/34' },
  { brand: 'Amex', number: '378282246310005', cvv: '1234', expiry: '12/34' },
  { brand: 'RuPay', number: '6011111111111117', cvv: '123', expiry: '12/34' },
  { brand: 'Declines', number: '4000000000000002', cvv: '123', expiry: '12/34' },
] as const;

export type { ClientSession, SavedPaymentMethod };

// The React surface is part of this package's public API. It was defined in
// ./react but never re-exported here, and with no `exports` map the only way
// to reach it was the undocumented deep path '@payforge/react/dist/react' —
// so `import { PayForgeProvider } from '@payforge/react'` did not compile.
export { PayForgeProvider, usePayForge } from './react';
export type { PayForgeContextValue, PayForgeProviderProps } from './react';