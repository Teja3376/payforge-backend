import { MockBankAdapter } from './mock-bank.adapter';

/**
 * The mock's status queries are load-bearing: reconciliation asks the provider
 * what actually happened to a charge or refund and acts on the answer. An
 * adapter that returned a confident answer for a reference it had never issued
 * would let reconciliation "resolve" a stranded transaction into a
 * confidently wrong state, so these tests pin the UNKNOWN behaviour.
 */
describe('MockBankAdapter', () => {
  let bank: MockBankAdapter;

  beforeEach(() => {
    bank = new MockBankAdapter();
  });

  describe('createCharge', () => {
    it('issues a reference and tracks it as PENDING', async () => {
      const { gatewayRef } = await bank.createCharge({
        amountMinor: 1_000n,
        currency: 'INR',
        idempotencyKey: 'k1',
        method: 'CARD',
      });

      expect(gatewayRef).toMatch(/^mock_/);
      await expect(bank.getChargeStatus({ gatewayRef })).resolves.toEqual({ status: 'PENDING' });
    });

    it('refuses a non-positive amount', async () => {
      await expect(
        bank.createCharge({
          amountMinor: 0n,
          currency: 'INR',
          idempotencyKey: 'k2',
          method: 'CARD',
        }),
      ).rejects.toThrow(/non-positive/);
    });

    it('honours the failure-injection hook', async () => {
      bank.failNextCharges = 1;
      await expect(
        bank.createCharge({
          amountMinor: 100n,
          currency: 'INR',
          idempotencyKey: 'k3',
          method: 'CARD',
        }),
      ).rejects.toThrow(/declined/);

      // The hook is one-shot.
      await expect(
        bank.createCharge({
          amountMinor: 100n,
          currency: 'INR',
          idempotencyKey: 'k4',
          method: 'CARD',
        }),
      ).resolves.toHaveProperty('gatewayRef');
    });
  });

  describe('getChargeStatus', () => {
    it('reports UNKNOWN for a reference it never issued', async () => {
      // Guessing here would let reconciliation resolve a stranded transaction
      // into a state the provider never agreed to.
      await expect(bank.getChargeStatus({ gatewayRef: 'mock_nonexistent' })).resolves.toEqual({
        status: 'UNKNOWN',
      });
    });

    it('reflects a void', async () => {
      const { gatewayRef } = await bank.createCharge({
        amountMinor: 500n,
        currency: 'INR',
        idempotencyKey: 'k5',
        method: 'CARD',
      });
      await bank.voidCharge({ gatewayRef, reason: 'commit failed' });
      await expect(bank.getChargeStatus({ gatewayRef })).resolves.toEqual({ status: 'VOIDED' });
    });
  });

  describe('getRefundStatus', () => {
    it('reports SUCCEEDED for a refund it issued', async () => {
      const { gatewayRef } = await bank.createCharge({
        amountMinor: 1_000n,
        currency: 'INR',
        idempotencyKey: 'k6',
        method: 'CARD',
      });
      const { refundRef } = await bank.refund({
        gatewayRef,
        amountMinor: 400n,
        currency: 'INR',
        idempotencyKey: 'r1',
      });

      await expect(bank.getRefundStatus({ gatewayRef, refundRef })).resolves.toEqual({
        status: 'SUCCEEDED',
      });
      // Also resolvable by charge alone, which is how the stranded-refund
      // sweeper identifies a refund whose reference was never written.
      await expect(bank.getRefundStatus({ gatewayRef })).resolves.toEqual({ status: 'SUCCEEDED' });
    });

    it('reports UNKNOWN for a charge that was never refunded', async () => {
      const { gatewayRef } = await bank.createCharge({
        amountMinor: 1_000n,
        currency: 'INR',
        idempotencyKey: 'k7',
        method: 'CARD',
      });
      await expect(bank.getRefundStatus({ gatewayRef })).resolves.toEqual({ status: 'UNKNOWN' });
    });

    it('reports UNKNOWN for a refund reference it never issued', async () => {
      await expect(
        bank.getRefundStatus({ gatewayRef: 'mock_x', refundRef: 'mock_refr_fabricated' }),
      ).resolves.toEqual({ status: 'UNKNOWN' });
    });
  });

  describe('createPayout', () => {
    it('issues an external reference', async () => {
      const result = await bank.createPayout({
        amountMinor: 2_000n,
        currency: 'INR',
        destination: {
          bankName: 'Test Bank',
          accountHolder: 'A Merchant',
          accountNumber: '000123456',
          routingNumber: '110000',
        },
        idempotencyKey: 'payout:pf-po-1',
      });
      expect(result.externalRef).toMatch(/^mock_po_/);
    });
  });
});