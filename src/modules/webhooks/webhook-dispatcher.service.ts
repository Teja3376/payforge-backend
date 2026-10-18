import { Injectable, OnModuleInit } from '@nestjs/common';
import { WebhookEventType } from '@prisma/client';
import { decryptSecret, encryptSecret } from '../../common/crypto/crypto';
import { logger } from '../../common/logger/logger';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { generatePublicId } from '../../common/utils/generate-public-id';
import { PrismaService } from '../../database/prisma.service';
import { signOutbound } from '../../common/webhooks/signing';
import { toMajorNumber } from '../../common/money/money';

const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 30_000;
const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * How long a claimed delivery is considered owned by the worker that claimed
 * it. Must exceed DELIVERY_TIMEOUT_MS so a live request is never reclaimed
 * mid-flight. Past this, a row still IN_FLIGHT belonged to a process that died.
 */
const LEASE_MS = 60_000;

/** Cap on an honoured Retry-After, so a provider cannot park a delivery for days. */
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

/** Dead deliveries on one endpoint within 24h before it is auto-disabled. */
const AUTO_DISABLE_THRESHOLD = 25;

/** Event ids are global and opaque; merchants deduplicate on them. */
function newEventId(): string {
  return `evt_${randomUUID().replace(/-/g, '')}`;
}

/** P2002 on the (endpointId, eventId) unique index: already enqueued. */
function isDuplicateKey(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** Exponential backoff with jitter, capped. */
function backoffMs(attempt: number): number {
  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), 6 * 60 * 60 * 1000);
  return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
}

export type DispatchInput = {
  paymentId?: string;
  payoutId?: string;
  type: WebhookEventType;
  merchantId?: string;
};

/**
 * Delivers events to merchant webhook endpoints.
 *
 * Design notes:
 *  - Dispatch is *enqueue only*. The HTTP call happens in a retry sweep, never
 *    inside the settlement transaction. A merchant whose endpoint hangs must
 *    not be able to roll back a settlement, and settlement latency must not
 *    depend on a third party's uptime.
 *  - Every (endpoint, eventId) pair is unique, so re-dispatching the same event
 *    after a crash cannot produce a duplicate delivery row.
 *  - After `MAX_ATTEMPTS` the delivery is marked DEAD and the endpoint is
 *    auto-disabled, so a permanently-broken endpoint stops consuming sweeps.
 */
@Injectable()
export class WebhookDispatcher implements OnModuleInit {
  private readonly log = logger.child({ module: 'webhooks.outbound' });

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    // Sweep anything left PENDING by a process restart.
    void this.deliverDue().catch((error) => this.log.error({ err: error }, 'webhook sweep failed on boot'));
  }

  async dispatchPaymentEvent(input: { paymentId: string; type: WebhookEventType }) {
    const payment = await this.prisma.payments.findUnique({
      where: { id: input.paymentId },
      select: {
        merchantId: true,
        publicId: true,
        amount: true,
        currency: true,
        settlementAmount: true,
        settlementCurrency: true,
        refundedAmount: true,
        status: true,
        createdAt: true,
        merchant: { select: { publicId: true, name: true } },
      },
    });
    if (!payment) {
      return;
    }

    const eventId = newEventId();
    await this.enqueue({
      eventId,
      merchantId: payment.merchantId,
      type: input.type,
      payload: {
        id: eventId,
        type: input.type,
        createdAt: new Date().toISOString(),
        livemode: true,
        data: {
          object: 'payment',
          id: payment.publicId,
          merchant: { id: payment.merchant.publicId, name: payment.merchant.name },
          amount: toMajorNumber(payment.amount, payment.currency),
          currency: payment.currency,
          settlement_amount: toMajorNumber(payment.settlementAmount, payment.settlementCurrency),
          settlement_currency: payment.settlementCurrency,
          refunded_amount: toMajorNumber(payment.refundedAmount, payment.settlementCurrency),
          status: payment.status,
          created_at: payment.createdAt.toISOString(),
        },
      },
    });
  }

  async dispatchPayoutEvent(input: { payoutId: string; type: WebhookEventType }) {
    const payout = await this.prisma.payout.findUnique({
      where: { id: input.payoutId },
      select: {
        merchantId: true,
        publicId: true,
        amount: true,
        currency: true,
        status: true,
        createdAt: true,
      },
    });
    if (!payout) {
      return;
    }

    const eventId = newEventId();
    await this.enqueue({
      eventId,
      merchantId: payout.merchantId,
      type: input.type,
      payload: {
        id: eventId,
        type: input.type,
        createdAt: new Date().toISOString(),
        livemode: true,
        data: {
          object: 'payout',
          id: payout.publicId,
          amount: toMajorNumber(payout.amount, payout.currency),
          currency: payout.currency,
          status: payout.status,
          created_at: payout.createdAt.toISOString(),
        },
      },
    });
  }

  private async enqueue(input: {
    eventId: string;
    merchantId: string;
    type: WebhookEventType;
    payload: Record<string, unknown>;
  }) {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { merchantId: input.merchantId, status: 'ACTIVE' },
      select: { id: true, events: true },
    });

    // An endpoint subscribed to "*" receives everything.
    const targets = endpoints.filter(
      (endpoint) => endpoint.events.includes('*') || endpoint.events.includes(input.type),
    );
    if (targets.length === 0) {
      return;
    }

    for (const endpoint of targets) {
      // The (endpointId, eventId) unique constraint is the deduplication
      // guarantee: re-enqueueing after a crash is a no-op, not a duplicate
      // delivery, and not a spurious retry either.
      await this.prisma.webhookDelivery
        .create({
          data: {
            publicId: generatePublicId('pf-delivery'),
            endpointId: endpoint.id,
            eventId: input.eventId,
            eventType: input.type,
            payload: input.payload as object,
            nextAttemptAt: new Date(),
          },
        })
        .catch((error: unknown) => {
          if (!isDuplicateKey(error)) {
            throw error;
          }
        });
    }

    // Deliver immediately for good latency; the sweep is the safety net.
    void this.deliverDue().catch((error) =>
      this.log.error({ err: error }, 'immediate webhook delivery failed'),
    );
  }

  /**
   * Attempt every delivery whose `nextAttemptAt` has passed.
   *
   * Safe to run on multiple replicas: the `updateMany` claim below makes each
   * row single-owner, so a second replica finds nothing to do rather than
   * double-delivering.
   *
   * The claim writes a *lease* (`nextAttemptAt` pushed out) rather than
   * flipping the row to FAILED. Previously the claim set FAILED before the HTTP
   * call and only moved it back on success or on a scheduled retry, so a
   * process kill between claim and terminal write left the row in FAILED —
   * which this query never reads, because it filters on PENDING. Those rows
   * were stranded permanently with no reaper. `IN_FLIGHT` rows past their
   * lease are reclaimed here.
   */
  async deliverDue(limit = 50) {
    const now = new Date();

    const due = await this.prisma.webhookDelivery.findMany({
      where: {
        OR: [
          { status: 'PENDING', nextAttemptAt: { lte: now } },
          // Reclaim anything a dead process left mid-flight.
          { status: 'IN_FLIGHT', nextAttemptAt: { lte: now } },
        ],
        // A disabled endpoint still has queued events. Delivering them
        // contradicts an operator's decision to disable it.
        endpoint: { status: { not: 'DISABLED' } },
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: limit,
      select: { id: true },
    });

    for (const row of due) {
      // Claim with a lease rather than a terminal status. If this process dies
      // mid-request the row stays IN_FLIGHT until the lease expires, and the
      // next sweep picks it up.
      const claimed = await this.prisma.webhookDelivery.updateMany({
        where: {
          id: row.id,
          OR: [
            { status: 'PENDING', nextAttemptAt: { lte: now } },
            { status: 'IN_FLIGHT', nextAttemptAt: { lte: now } },
          ],
        },
        data: {
          status: 'IN_FLIGHT',
          attempts: { increment: 1 },
          nextAttemptAt: new Date(now.getTime() + LEASE_MS),
        },
      });
      if (claimed.count === 0) {
        continue; // another replica owns it
      }
      await this.attempt(row.id);
    }
  }

  private async attempt(deliveryId: string) {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { endpoint: true },
    });
    if (!delivery) {
      return;
    }

    // The claim already incremented `attempts`, so this IS the attempt number.
    // It used to be `delivery.attempts + 1`, which double-counted against the
    // claim and made MAX_ATTEMPTS = 8 deliver only 7 POSTs.
    const attemptNumber = delivery.attempts;
    const body = JSON.stringify(delivery.payload);
    let signature: string;
    try {
      const secret = decryptSecret(delivery.endpoint.secretEnc, this.signingKey());
      signature = signOutbound(body, Math.floor(Date.now() / 1000), delivery.eventId, secret);
    } catch (error) {
      this.log.error({ err: error, deliveryId }, 'cannot sign webhook delivery');
      await this.markDead(deliveryId, 'signing failed');
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    try {
      const response = await fetch(delivery.endpoint.url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'PayForge-Webhooks/1.0',
          'x-payforge-signature': signature,
          'x-payforge-event-id': delivery.eventId,
          'x-payforge-event-type': delivery.eventType,
          'x-payforge-attempt': String(attemptNumber),
        },
        body,
      });

      if (response.ok) {
        // Outside the try: a database error after a successful POST must not be
        // converted into a retry, or the merchant receives the same event twice
        // because PayForge believes it failed.
        await this.prisma.webhookDelivery.update({
          where: { id: deliveryId },
          data: {
            status: 'DELIVERED',
            deliveredAt: new Date(),
            lastStatusCode: response.status,
            lastError: null,
          },
        });
        await this.recordSuccess(delivery.endpointId);
        return;
      }

      const statusCode = response.status;

      // Capture the response so an operator can tell a 401 from a 403 from a
      // schema rejection. Previously only `HTTP 400` was recorded and the body
      // was discarded, which made delivery failures undiagnosable.
      const detail = await this.readErrorDetail(response);

      if (isPermanentFailure(statusCode)) {
        // A 4xx (except 408/429) means the request itself is wrong. Retrying
        // the identical body seven more times cannot succeed and only delays
        // the operator finding out.
        await this.markDead(
          deliveryId,
          `HTTP ${statusCode}: ${detail}`,
        );
        await this.recordFailure(delivery.endpointId);
        return;
      }

      await this.scheduleRetry(
        deliveryId,
        attemptNumber,
        `HTTP ${statusCode}: ${detail}`,
        statusCode,
        retryAfterMs(response),
      );
    } catch (error) {
      await this.scheduleRetry(
        deliveryId,
        attemptNumber,
        error instanceof Error ? error.message : 'network error',
        null,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private scheduleRetry(
    deliveryId: string,
    attemptNumber: number,
    reason: string,
    statusCode: number | null,
    retryAfterMs?: number,
  ) {
    if (attemptNumber >= MAX_ATTEMPTS) {
      return this.markDead(deliveryId, reason);
    }

    return this.prisma.$transaction(async (tx) => {
      const delivery = await tx.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'PENDING',
          // Honour Retry-After when the provider sends one, otherwise back off.
          nextAttemptAt: new Date(Date.now() + (retryAfterMs ?? backoffMs(attemptNumber))),
          lastError: reason.slice(0, 500),
          lastStatusCode: statusCode,
        },
        select: { endpointId: true },
      });
      await tx.webhookEndpoint.update({
        where: { id: delivery.endpointId },
        data: { failureCount: { increment: 1 } },
      });
    });
  }

  /**
   * Mark a delivery dead and disable a persistently-broken endpoint.
   *
   * The docstring on this class claimed the endpoint is auto-disabled after
   * MAX_ATTEMPTS so a permanently-broken URL stops consuming sweeps. It did
   * not: `disabledReason` was never written and `failureCount` was recorded
   * but never read, so a 404-ing endpoint burned a full retry budget per event
   * forever.
   */
  private async markDead(deliveryId: string, reason: string) {
    const delivery = await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: 'DEAD', lastError: reason.slice(0, 500) },
      select: { endpointId: true },
    });

    this.log.warn({ deliveryId, reason }, 'webhook delivery exhausted retries');

    await this.recordFailure(delivery.endpointId);

    const [deaths, dead] = await Promise.all([
      this.prisma.webhookDelivery.count({
        where: { endpointId: delivery.endpointId, status: 'DEAD' },
      }),
      this.prisma.webhookDelivery.count({
        where: { endpointId: delivery.endpointId, status: 'DEAD', updatedAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) } },
      }),
    ]);

    if (deaths >= AUTO_DISABLE_THRESHOLD && dead >= AUTO_DISABLE_THRESHOLD) {
      await this.prisma.webhookEndpoint.updateMany({
        where: { id: delivery.endpointId, status: { not: 'DISABLED' } },
        data: {
          status: 'DISABLED',
          disabledReason: `${deaths} deliveries failed; last: ${reason}`.slice(0, 500),
        },
      });
      this.log.error(
        { endpointId: delivery.endpointId, deaths },
        'webhook endpoint auto-disabled after repeated delivery failures',
      );
    }
  }

  private async recordFailure(endpointId: string) {
    await this.prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: { failureCount: { increment: 1 } },
    });
  }

  private async recordSuccess(endpointId: string) {
    // A success is evidence the endpoint works; clearing the counter stops a
    // single bad afternoon from accumulating toward the disable threshold.
    await this.prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: { failureCount: 0 },
    });
  }

  /** Best-effort capture of a non-2xx response body for diagnosis. */
  private async readErrorDetail(response: Response): Promise<string> {
    try {
      const text = await response.text();
      return text.slice(0, 300);
    } catch {
      return response.statusText || 'no response body';
    }
  }

  private signingKey(): string {
    return process.env.WEBHOOK_SIGNING_KEY ?? '';
  }

  /** Used by the endpoint service when minting a new signing secret. */
  seal(secret: string): string {
    return encryptSecret(secret, this.signingKey());
  }
}

/**
 * 4xx means the request is wrong; retrying the identical body cannot help.
 * 408 (timeout) and 429 (rate limited) are the exceptions — both can succeed
 * on a later attempt.
 */
function isPermanentFailure(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** Parse Retry-After as seconds, or as an HTTP date. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? Math.min(delta, MAX_RETRY_AFTER_MS) : 0;
  }
  return undefined;
}