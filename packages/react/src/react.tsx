import type { CardFieldState, PayForgeCardOptions, TokenizeResult } from './index';

export { createCardController, TEST_CARDS } from './index';
export type { CardFieldState, PayForgeCardOptions, PayForgeCardInstance, TokenizeResult } from './index';

export type PayForgeProviderProps = {
  clientSecret: string;
  providerSession?: string;
  children: React.ReactNode;
};

/**
 * Minimal React context so a card field and its submit button can share one
 * tokenization session.
 *
 * The React surface is intentionally tiny. Anything that needs real state
 * management should call `@payforge/node` on the server instead.
 */
import { createContext, useContext, useMemo, useRef, useState, useEffect } from 'react';
import { createCardController, type PayForgeCardInstance } from './index';

export type PayForgeContextValue = {
  tokenize: () => Promise<TokenizeResult>;
  ready: boolean;
  fieldState: CardFieldState;
};

const PayForgeContext = createContext<PayForgeContextValue | null>(null);

export function PayForgeProvider({ clientSecret, children }: PayForgeProviderProps) {
  const [ready, setReady] = useState(false);
  const [fieldState, setFieldState] = useState<CardFieldState>('idle');
  const controllerRef = useRef<PayForgeCardInstance | null>(null);

  useEffect(() => {
    const options: PayForgeCardOptions = {
      clientSecret,
      onStateChange: (next) => {
        setFieldState(next);
        if (next === 'complete') setReady(true);
      },
    };
    const controller = createCardController(options);
    controllerRef.current = controller;
    return () => {
      controller.destroy();
      controllerRef.current = null;
      setReady(false);
    };
  }, [clientSecret]);

  const value = useMemo<PayForgeContextValue>(
    () => ({
      tokenize: async () => controllerRef.current?.tokenize() ?? Promise.resolve({
        status: 'error' as const,
        code: 'NOT_MOUNTED',
        message: 'Mount the card field first.',
      }),
      ready,
      fieldState,
    }),
    [ready, fieldState],
  );

  return <PayForgeContext.Provider value={value}>{children}</PayForgeContext.Provider>;
}

export function usePayForge(): PayForgeContextValue {
  const context = useContext(PayForgeContext);
  if (!context) {
    throw new Error('usePayForge must be used inside a <PayForgeProvider>.');
  }
  return context;
}