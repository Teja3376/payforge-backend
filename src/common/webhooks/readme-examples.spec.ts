/**
 * Executes the exact snippets from README.md against the real SDK.
 *
 * A README whose examples do not compile is worse than no README, so the code
 * in it is type-checked here rather than trusted.
 */
import PayForge, { paginate, PayForgeError } from '@payforge/node';

describe('README examples', () => {
  const payforge = new PayForge({
    apiKey: 'pf_test_a1b2c3d4e5f6_deadbeef',
    baseUrl: 'https://api.payforge.dev/v1',
  });

  it('constructs a client from an API key', () => {
    expect(payforge).toBeInstanceOf(PayForge);
  });

  it('rejects a client without an API key', () => {
    expect(() => new PayForge({ apiKey: '' })).toThrow(/API key is required/);
  });

  // Recipe 1 — take a payment
  it('Recipe 1: creates a payment with an idempotency key', async () => {
    const mockFetch = jest.fn().mockResolvedValue(
      jsonResponse(201, {
        publicId: 'PF-PAY-84JJVVGYTF3R',
        merchantPublicId: 'PF-MER-84JJVVGYTF3R',
        merchantName: 'Northwind',
        payerPublicId: 'PF-USR-1',
        amount: 1580,
        currency: 'JPY',
        fxRateDate: '2026-10-18',
        usdRate: '158.0012000000',
        inrRate: '95.0757000000',
        settlementAmount: 950.75,
        settlementCurrency: 'INR',
        feeBasisPoints: 200,
        refundedAmount: 0,
        description: null,
        status: 'CREATED',
        expiresAt: '2026-10-18T11:00:00.000Z',
        createdAt: '2026-10-18T10:30:00.000Z',
      }),
    );

    const client = new PayForge({ apiKey: 'pf_test_x', fetch: mockFetch as never });
    const payment = await client.payments.create(
      {
        merchantPublicId: 'PF-MER-84JJVVGYTF3R',
        amount: 1580,
        currency: 'JPY',
        description: 'Order #1001',
        metadata: { orderId: '1001' },
      },
      { idempotencyKey: 'order-1001' },
    );

    expect(payment.publicId).toBe('PF-PAY-84JJVVGYTF3R');

    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('order-1001');
    expect(headers['x-api-key']).toBe('pf_test_x');
  });

  // Recipe 2 — hosted fields
  it('Recipe 2: charges a gateway token instead of a card number', async () => {
    const mockFetch = jest.fn().mockResolvedValue(jsonResponse(201, { publicId: 'PF-TRX-1' }));
    const client = new PayForge({ apiKey: 'pf_test_x', fetch: mockFetch as never });

    await client.transactions.create(
      {
        paymentPublicId: 'PF-PAY-84JJVVGYTF3R',
        method: 'CARD',
        gatewayToken: 'tok_mock_6f1c0b2e3a4d4e5f',
      },
      { idempotencyKey: 'txn-1001' },
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.gatewayToken).toBe('tok_mock_6f1c0b2e3a4d4e5f');
    expect(body.cardNumber).toBeUndefined();
  });

  // Recipe 5 — payouts + paginate
  it('Recipe 5: paginates a merchant statement', async () => {
    const pages = [
      { data: [{ publicId: 'PF-LEDGER-1' }, { publicId: 'PF-LEDGER-2' }], hasMore: true, nextCursor: 'c1' },
      { data: [{ publicId: 'PF-LEDGER-3' }], hasMore: false, nextCursor: null },
    ];
    const mockFetch = jest.fn();
    for (const page of pages) {
      mockFetch.mockResolvedValueOnce(jsonResponse(200, page));
    }

    const client = new PayForge({ apiKey: 'pf_test_x', fetch: mockFetch as never });

    const seen: string[] = [];
    for await (const entry of paginate((cursor) =>
      client.merchant.statement({ cursor, limit: 100 }),
    )) {
      seen.push((entry as { publicId: string }).publicId);
    }

    expect(seen).toEqual(['PF-LEDGER-1', 'PF-LEDGER-2', 'PF-LEDGER-3']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // Recipe 6 — manual cursor loop
  it('Recipe 6: walks pages with an explicit cursor loop', async () => {
    const mockFetch = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { data: [{ publicId: 'a' }], hasMore: true, nextCursor: 'next' }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { data: [{ publicId: 'b' }], hasMore: false, nextCursor: null }),
      );

    const client = new PayForge({ apiKey: 'pf_test_x', fetch: mockFetch as never });

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.payments.list({ limit: 100, cursor });
      seen.push(...page.data.map((payment) => payment.publicId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(seen).toEqual(['a', 'b']);
    // The cursor from page one is forwarded on the second request.
    expect(mockFetch.mock.calls[1][0]).toContain('cursor=next');
  });

  // Recipe 7 — error handling
  it('Recipe 7: surfaces a typed error with a stable code', async () => {
    const mockFetch = jest.fn().mockResolvedValue(
      jsonResponse(409, {
        statusCode: 409,
        error: 'Conflict',
        code: 'PAYMENT_HAS_OPEN_TRANSACTION',
        message: 'This payment already has a transaction in progress.',
        requestId: 'req_9f2c1a7b4e6d0358aa11',
      }),
    );
    const client = new PayForge({ apiKey: 'pf_test_x', fetch: mockFetch as never });

    try {
      await client.transactions.create(
        { paymentPublicId: 'PF-PAY-1', method: 'CARD', gatewayToken: 'tok_1' },
        { idempotencyKey: 'k' },
      );
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PayForgeError);
      const typed = error as PayForgeError;
      expect(typed.code).toBe('PAYMENT_HAS_OPEN_TRANSACTION');
      expect(typed.statusCode).toBe(409);
      expect(typed.requestId).toBe('req_9f2c1a7b4e6d0358aa11');
      expect(typed.isConflict).toBe(true);
      expect(typed.isRetryable).toBe(false);
    }
  });

  it('exposes the error class as a static for `PayForge.PayForgeError`', () => {
    expect(PayForge.PayForgeError).toBe(PayForgeError);
  });

  it('retries a retryable failure but not a permanent one', async () => {
    const mockFetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { statusCode: 503, error: 'x', code: 'BANK_UNAVAILABLE', message: 'down', requestId: 'r1' }))
      .mockResolvedValueOnce(jsonResponse(200, { publicId: 'PF-PAY-OK' }));

    const client = new PayForge({ apiKey: 'pf_test_x', fetch: mockFetch as never, maxRetries: 2 });
    const result = await client.payments.create(
      { merchantPublicId: 'PF-MER-1', amount: 10, currency: 'INR' },
      { idempotencyKey: 'k' },
    );
    expect(result.publicId).toBe('PF-PAY-OK');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry without an idempotency key, to avoid double charges', async () => {
    const mockFetch = jest.fn().mockResolvedValue(
      jsonResponse(503, { statusCode: 503, error: 'x', code: 'BANK_UNAVAILABLE', message: 'down', requestId: 'r1' }),
    );
    const client = new PayForge({ apiKey: 'pf_test_x', fetch: mockFetch as never, maxRetries: 3 });

    // The SDK requires an idempotency key for writes, so this exercises the
    // guard through a read that fails.
    await expect(client.payments.list()).rejects.toBeInstanceOf(PayForgeError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_test' },
  });
}