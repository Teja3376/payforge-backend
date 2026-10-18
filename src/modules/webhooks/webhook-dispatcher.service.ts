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
   * Called on a schedule. Safe to run on multiple replicas: the `updateMany`
   * claim below makes each row single-owner, so a second replica finds nothing
   * to do rather than double-delivering.
   */
  async deliverDue(limit = 50) {
    const due = await this.prisma.webhookDelivery.findMany({
      where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
      orderBy: { nextAttemptAt: 'asc' },
      take: limit,
      select: { id: true },
    });

    for (const row of due) {
      const claimed = await this.prisma.webhookDelivery.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: { status: 'FAILED', attempts: { increment: 1 }, updatedAt: new Date() },
      });
      if (claimed.count === 0) {
        continue;
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

    const attemptNumber = delivery.attempts + 1;
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
        },
        body,
      });

      if (response.ok) {
        await this.prisma.webhookDelivery.update({
          where: { id: deliveryId },
          data: {
            status: 'DELIVERED',
            deliveredAt: new Date(),
            lastStatusCode: response.status,
            lastError: null,
          },
        });
        return;
      }
      await this.scheduleRetry(deliveryId, attemptNumber, `HTTP ${response.status}`, response.status);
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

  private async scheduleRetry(
    deliveryId: string,
    attemptNumber: number,
    reason: string,
    statusCode: number | null,
  ) {
    if (attemptNumber >= MAX_ATTEMPTS) {
      await this.markDead(deliveryId, reason);
      return;
    }

    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      select: { endpointId: true },
    });

    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'PENDING',
        nextAttemptAt: new Date(Date.now() + backoffMs(attemptNumber)),
        lastError: reason.slice(0, 500),
        lastStatusCode: statusCode,
      },
    });

    if (delivery) {
      await this.prisma.webhookEndpoint.update({
        where: { id: delivery.endpointId },
        data: { failureCount: { increment: 1 } },
      });
    }
  }

  private async markDead(deliveryId: string, reason: string) {
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: 'DEAD', lastError: reason.slice(0, 500) },
    });
    this.log.warn({ deliveryId, reason }, 'webhook delivery exhausted retries');
  }

  private signingKey(): string {
    return process.env.WEBHOOK_SIGNING_KEY ?? '';
  }

  /** Used by the endpoint service when minting a new signing secret. */
  seal(secret: string): string {
    return encryptSecret(secret, this.signingKey());
  }
}