import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { generateOpaqueToken, hashApiKey } from '../../common/crypto/crypto';
import { logger } from '../../common/logger/logger';
import { generatePublicId } from '../../common/utils/generate-public-id';
import { PrismaService } from '../../database/prisma.service';
import { BANK_PORT, type BankPort } from '../bank/bank.port';

const CLIENT_SESSION_TTL_MINUTES = 15;

@Injectable()
export class ClientSessionService {
  private readonly log = logger.child({ module: 'tokenization' });

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BANK_PORT) private readonly bank: BankPort,
  ) {}

  /**
   * Issue a short-lived client secret for hosted card fields.
   *
   * This is the PCI chokepoint. In the hosted-fields flow the PAN is captured
   * inside the provider's iframe and never transits PayForge servers, which
   * reduces scope from full PCI DSS to SAQ A. The secret below is what lets the
   * browser prove it belongs to this specific payment before the iframe opens.
   *
   * The raw secret is returned once and stored only as a SHA-256 hash, exactly
   * like an API key.
   */
  async create(merchantId: string, paymentId?: string) {
    const clientSecret = generateOpaqueToken(32);
    const expiresAt = new Date(Date.now() + CLIENT_SESSION_TTL_MINUTES * 60_000);

    await this.prisma.clientSession.create({
      data: {
        publicId: generatePublicId('pf-cs'),
        secretHash: hashApiKey(clientSecret),
        merchantId,
        paymentId: paymentId ?? null,
        expiresAt,
      },
    });

    return {
      clientSecret,
      expiresAt,
      // Surfaced so the SDK knows which provider region/iframe to mount.
      providerSession: await this.bank
        .createTokenizationSession({ clientSecret, expiresAt })
        .then((session) => session.sessionId)
        .catch((error: unknown) => {
          this.log.error({ err: error }, 'provider tokenization session failed');
          throw ApiError.of(
            ErrorCode.BANK_UNAVAILABLE,
            'Card entry is temporarily unavailable. Please try again.',
            { cause: error },
          );
        }),
    };
  }

  /**
   * Exchange a client secret plus the provider's single-use gateway token for
   * a chargeable PayForge reference.
   *
   * Consuming the session is a compare-and-set so a leaked secret cannot be
   * redeemed twice, even under concurrent presentation.
   */
  async redeem(clientSecret: string, gatewayToken: string) {
    const session = await this.prisma.clientSession.findUnique({
      where: { secretHash: hashApiKey(clientSecret) },
    });

    if (!session) {
      throw ApiError.of(ErrorCode.CLIENT_SESSION_NOT_FOUND);
    }
    if (session.consumedAt) {
      throw ApiError.of(
        ErrorCode.CLIENT_SESSION_CONSUMED,
        'This card entry session has already been used.',
      );
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw ApiError.of(ErrorCode.CLIENT_SESSION_EXPIRED);
    }

    const claimed = await this.prisma.clientSession.updateMany({
      where: { id: session.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (claimed.count === 0) {
      throw ApiError.of(ErrorCode.CLIENT_SESSION_CONSUMED);
    }

    return { merchantId: session.merchantId, paymentId: session.paymentId, gatewayToken };
  }

  /**
   * Persist a tokenized instrument so the customer is not asked for card
   * details on every future charge. Only the provider's opaque token and
   * display-safe metadata (brand, last4) are stored.
   */
  async savePaymentMethod(input: {
    merchantId: string;
    gatewayToken: string;
    customerRef?: string;
    brand?: string;
    last4?: string;
    expiryMonth?: number;
    expiryYear?: number;
    holderName?: string;
  }) {
    const existing = await this.prisma.savedPaymentMethod.findUnique({
      where: { gatewayToken: input.gatewayToken },
    });
    if (existing) {
      if (existing.merchantId !== input.merchantId) {
        throw ApiError.of(
          ErrorCode.FORBIDDEN,
          'That payment method belongs to another merchant.',
        );
      }
      return this.present(existing);
    }

    try {
      const method = await this.prisma.savedPaymentMethod.create({
        data: {
          publicId: generatePublicId('pf-pm'),
          merchantId: input.merchantId,
          customerRef: input.customerRef,
          type: 'CARD',
          gatewayToken: input.gatewayToken,
          brand: (input.brand as never) ?? null,
          last4: input.last4,
          expiryMonth: input.expiryMonth,
          expiryYear: input.expiryYear,
          holderName: input.holderName,
        },
      });
      return this.present(method);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.prisma.savedPaymentMethod.findUnique({
          where: { gatewayToken: input.gatewayToken },
        });
        if (raced && raced.merchantId === input.merchantId) {
          return this.present(raced);
        }
      }
      throw error;
    }
  }

  async listPaymentMethods(merchantId: string, customerRef?: string) {
    const methods = await this.prisma.savedPaymentMethod.findMany({
      where: {
        merchantId,
        status: 'ACTIVE',
        ...(customerRef ? { customerRef } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    return methods.map((method) => this.present(method));
  }

  async disablePaymentMethod(merchantId: string, publicId: string) {
    const method = await this.prisma.savedPaymentMethod.findUnique({ where: { publicId } });
    if (!method || method.merchantId !== merchantId) {
      throw ApiError.of(ErrorCode.VALIDATION_FAILED, 'Payment method not found.');
    }
    await this.prisma.savedPaymentMethod.update({
      where: { id: method.id },
      data: { status: 'DISABLED' },
    });
  }

  private present(method: {
    publicId: string;
    customerRef: string | null;
    type: string;
    brand: string | null;
    last4: string | null;
    expiryMonth: number | null;
    expiryYear: number | null;
    holderName: string | null;
    status: string;
    createdAt: Date;
  }) {
    return {
      publicId: method.publicId,
      customerRef: method.customerRef,
      type: method.type,
      brand: method.brand,
      last4: method.last4,
      expiryMonth: method.expiryMonth,
      expiryYear: method.expiryYear,
      holderName: method.holderName,
      status: method.status,
      createdAt: method.createdAt,
    };
  }
}