/**
 * Everything PayForge needs from a payment provider or bank rail.
 *
 * Implementations must be safe to call concurrently and must respect
 * `idempotencyKey` — the bank is the system of record for "did this money
 * actually move", so a retry after a timeout must not double-charge.
 *
 * `MOCK_BANK_SECRET` from the original scaffold was doing double duty as both
 * the mock's signing key and the production verification key. Those are now
 * separate: `BANK_WEBHOOK_SECRET` verifies inbound bank callbacks, and a
 * real adapter would hold its own per-provider credentials.
 */
export interface BankPort {
  /** Begin a charge. Returns a reference the bank will later report on. */
  createCharge(input: {
    amountMinor: bigint;
    currency: string;
    idempotencyKey: string;
    /** Present when paying with a previously tokenized instrument. */
    paymentToken?: string;
    method: 'CARD' | 'UPI' | 'NET_BANKING' | 'WALLET';
  }): Promise<{ gatewayRef: string }>;

  /**
   * Cancel a charge that was created but never settled.
   *
   * Required to avoid orphaned charges: `createCharge` happens before the
   * database transaction opens, so a crash in between leaves money held at the
   * bank with no local record. This is the compensating action.
   */
  voidCharge(input: { gatewayRef: string; reason: string }): Promise<{ voided: boolean }>;

  /**
   * Reverse settled funds at the bank.
   *
   * Without this, a refund only moves the internal ledger: the customer's
   * card is never actually credited back.
   */
  refund(input: {
    gatewayRef: string;
    amountMinor: bigint;
    currency: string;
    idempotencyKey: string;
  }): Promise<{ refundRef: string }>;

  /**
 * Send money out to a merchant's bank account.
 *
 * `destination` carries the routing details an adapter needs. PayForge stores
 * account and routing numbers encrypted (`PayoutDestination.accountEnc` /
 * `routingEnc`), so the executor decrypts at the point of transfer and never
 * persists them in plaintext. An adapter that talks to a provider using
 * connected-account IDs should map this to that identifier here rather than
 * requiring the schema to change.
 */
createPayout(input: {
    amountMinor: bigint;
    currency: string;
    destination: {
      bankName: string;
      accountHolder: string;
      accountNumber: string;
      routingNumber: string;
    };
    idempotencyKey: string;
  }): Promise<{ externalRef: string }>;

  /**
   * Issue a short-lived tokenization session for hosted card fields.
   *
   * This is the seam that keeps PAN out of PayForge. The client exchanges its
   * `clientSecret` for a session, the PSP iframe captures the card, and only
   * a single-use gateway token ever crosses our API.
   */
  createTokenizationSession(input: {
    clientSecret: string;
    expiresAt: Date;
  }): Promise<{ sessionId: string }>;

  /**
   * The authoritative state of a charge, as the provider sees it.
   *
   * Reconciliation needs this: when a callback is lost, the local row stays
   * PENDING forever and `Transactions_one_open_per_payment` blocks any further
   * charge on that payment. The only way to resolve that is to ask the
   * provider what actually happened.
   *
   * Must return UNKNOWN rather than guessing when the reference is not
   * recognised: reconciliation acts on this answer.
   */
  getChargeStatus(input: { gatewayRef: string }): Promise<{
    status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'VOIDED' | 'UNKNOWN';
    settledAt?: Date;
  }>;

  /** The authoritative state of a refund. */
  getRefundStatus(input: { gatewayRef: string; refundRef?: string }): Promise<{
    status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  }>;
}

export const BANK_PORT = Symbol('BANK_PORT');