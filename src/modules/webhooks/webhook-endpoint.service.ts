import { Injectable } from '@nestjs/common';
import { Prisma, WebhookEventType } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { generateOpaqueToken } from '../../common/crypto/crypto';
import { paginatedQuery } from '../../common/pagination/pagination';
import { generatePublicId } from '../../common/utils/generate-public-id';
import { PrismaService } from '../../database/prisma.service';
import { WebhookDispatcher } from './webhook-dispatcher.service';

const VALID_EVENTS = new Set<string>(Object.values(WebhookEventType));

@Injectable()
export class WebhookEndpointService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: WebhookDispatcher,
  ) {}

  /**
   * Register an endpoint.
   *
   * The signing secret is returned exactly once and stored encrypted (not
   * hashed) because PayForge must be able to *sign* with it on every delivery.
   * `WEBHOOK_SIGNING_KEY` is the envelope key that protects it at rest.
   */
  async create(merchantId: string, input: { url: string; events: string[]; description?: string }) {
    const events = input.events.includes('*') ? ['*'] : input.events;
    for (const event of events) {
      if (!VALID_EVENTS.has(event)) {
        throw ApiError.of(ErrorCode.VALIDATION_FAILED, `Unknown event type: ${event}.`, {
          meta: { validEvents: [...VALID_EVENTS] },
        });
      }
    }

    const secret = `whsec_${generateOpaqueToken(32)}`;
    const endpoint = await this.prisma.webhookEndpoint.create({
      data: {
        publicId: generatePublicId('pf-wh'),
        merchantId,
        url: input.url,
        secretEnc: this.dispatcher.seal(secret),
        events,
        description: input.description,
      },
    });

    return { ...this.present(endpoint), secret };
  }

  async list(merchantId: string, params: { limit: number; cursor?: string }) {
    return paginatedQuery({
      scope: { merchantId },
      query: (where, take, orderBy) =>
        this.prisma.webhookEndpoint.findMany({
          where: where as Prisma.WebhookEndpointWhereInput,
          orderBy: orderBy as Prisma.WebhookEndpointOrderByWithRelationInput[],
          take,
        }),
      present: (endpoint) => this.present(endpoint),
      limit: params.limit,
      cursor: params.cursor,
    });
  }

  async update(merchantId: string, publicId: string, patch: { url?: string; events?: string[]; status?: 'ACTIVE' | 'DISABLED'; description?: string }) {
    const endpoint = await this.prisma.webhookEndpoint.findUnique({ where: { publicId } });
    if (!endpoint || endpoint.merchantId !== merchantId) {
      throw ApiError.of(ErrorCode.VALIDATION_FAILED, 'Webhook endpoint not found.');
    }

    if (patch.events) {
      for (const event of patch.events) {
        if (!VALID_EVENTS.has(event) && event !== '*') {
          throw ApiError.of(ErrorCode.VALIDATION_FAILED, `Unknown event type: ${event}.`);
        }
      }
    }

    const updated = await this.prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: patch,
    });
    return this.present(updated);
  }

  /** Rotate the signing secret. Existing deliveries in flight use the old one. */
  async rotateSecret(merchantId: string, publicId: string) {
    const endpoint = await this.prisma.webhookEndpoint.findUnique({ where: { publicId } });
    if (!endpoint || endpoint.merchantId !== merchantId) {
      throw ApiError.of(ErrorCode.VALIDATION_FAILED, 'Webhook endpoint not found.');
    }

    const secret = `whsec_${generateOpaqueToken(32)}`;
    await this.prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { secretEnc: this.dispatcher.seal(secret), failureCount: 0 },
    });
    return { publicId, secret };
  }

  async deliveries(merchantId: string, publicId: string, params: { limit: number; cursor?: string }) {
    const endpoint = await this.prisma.webhookEndpoint.findUnique({ where: { publicId } });
    if (!endpoint || endpoint.merchantId !== merchantId) {
      throw ApiError.of(ErrorCode.VALIDATION_FAILED, 'Webhook endpoint not found.');
    }

    return paginatedQuery({
      scope: { endpointId: endpoint.id },
      query: (where, take, orderBy) =>
        this.prisma.webhookDelivery.findMany({
          where: where as Prisma.WebhookDeliveryWhereInput,
          orderBy: orderBy as Prisma.WebhookDeliveryOrderByWithRelationInput[],
          take,
        }),
      present: (delivery) => ({
        publicId: delivery.publicId,
        eventId: delivery.eventId,
        eventType: delivery.eventType,
        status: delivery.status,
        attempts: delivery.attempts,
        lastStatusCode: delivery.lastStatusCode,
        lastError: delivery.lastError,
        deliveredAt: delivery.deliveredAt,
        createdAt: delivery.createdAt,
      }),
      limit: params.limit,
      cursor: params.cursor,
    });
  }

  /** Redeliver a single event on demand — the standard "I missed it" remedy. */
  async redeliver(merchantId: string, publicId: string) {
    const endpoint = await this.prisma.webhookEndpoint.findUnique({ where: { publicId } });
    if (!endpoint || endpoint.merchantId !== merchantId) {
      throw ApiError.of(ErrorCode.VALIDATION_FAILED, 'Webhook endpoint not found.');
    }

    const updated = await this.prisma.webhookDelivery.updateMany({
      where: { endpointId: endpoint.id, publicId, status: { in: ['FAILED', 'DEAD'] } },
      data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null },
    });
    if (updated.count === 0) {
      throw ApiError.of(ErrorCode.ALREADY_IN_STATE, 'This delivery cannot be retried.');
    }

    void this.dispatcher.deliverDue().catch(() => undefined);
    return { publicId, status: 'PENDING' };
  }

  private present(endpoint: {
    publicId: string;
    url: string;
    events: string[];
    status: string;
    description: string | null;
    failureCount: number;
    createdAt: Date;
  }) {
    return {
      publicId: endpoint.publicId,
      url: endpoint.url,
      events: endpoint.events,
      status: endpoint.status,
      description: endpoint.description,
      failureCount: endpoint.failureCount,
      createdAt: endpoint.createdAt,
    };
  }
}