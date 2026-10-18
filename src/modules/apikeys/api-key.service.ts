import { Injectable } from '@nestjs/common';
import { ActorType, type Prisma } from '@prisma/client';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { generateApiKey } from '../../common/crypto/crypto';
import { ALL_SCOPES, isValidScope, type ScopeValue } from '../../common/scopes/scopes';
import { generatePublicId } from '../../common/utils/generate-public-id';
import { PrismaService } from '../../database/prisma.service';

export type CreateKeyInput = {
  merchantId: string;
  name: string;
  scopes: string[];
  mode: 'LIVE' | 'TEST';
  expiresInDays?: number;
};

@Injectable()
export class ApiKeyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Mint a key.
   *
   * The full key is returned exactly once, in this response. Only its hash is
   * stored, so the secret cannot be recovered from the database or from a log
   * line. Integration docs must make that clear — a merchant who loses the key
   * rotates it rather than trying to retrieve it.
   */
  async create(input: CreateKeyInput, actorId: string) {
    const unknownScopes = input.scopes.filter((scope) => !isValidScope(scope));
    if (unknownScopes.length > 0) {
      throw ApiError.of(
        ErrorCode.VALIDATION_FAILED,
        `Unknown scope${unknownScopes.length === 1 ? '' : 's'}: ${unknownScopes.join(', ')}.`,
        { meta: { validScopes: ALL_SCOPES } },
      );
    }
    if (input.scopes.length === 0) {
      throw ApiError.of(ErrorCode.VALIDATION_FAILED, 'Choose at least one scope.');
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const generated = generateApiKey(input.mode === 'TEST' ? 'test' : 'live');
      try {
        const key = await this.prisma.apiKey.create({
          data: {
            publicId: generatePublicId('pf-key'),
            merchantId: input.merchantId,
            name: input.name,
            prefix: generated.prefix,
            hash: generated.hash,
            scopes: input.scopes,
            mode: input.mode,
            expiresAt: input.expiresInDays
              ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
              : null,
          },
        });

        await this.prisma.resolution.create({
          data: {
            publicId: generatePublicId('pf-res'),
            actorId,
            actorType: ActorType.USER,
            action: 'CREATE_API_KEY',
            subjectType: 'API_KEY',
            subjectPublicId: key.publicId,
            metadata: { name: key.name, scopes: key.scopes, mode: key.mode },
          },
        });

        return { ...this.present(key), key: generated.raw };
      } catch (error) {
        // Retry only on a prefix collision. 72 bits of prefix makes this
        // vanishingly unlikely, but a 500 here would be a confusing failure.
        if (
          attempt === 2 ||
          !(error instanceof Error) ||
          !('code' in error) ||
          (error as { code?: string }).code !== 'P2002'
        ) {
          throw error;
        }
      }
    }
    throw ApiError.of(ErrorCode.KEY_PREFIX_COLLISION);
  }

  async list(merchantId: string) {
    const keys = await this.prisma.apiKey.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
    });
    return keys.map((key) => this.present(key));
  }

  async revoke(merchantId: string, publicId: string, actorId: string) {
    const key = await this.prisma.apiKey.findUnique({ where: { publicId } });
    // 404 rather than 403: a merchant must not be able to probe for the
    // existence of another merchant's key.
    if (!key || key.merchantId !== merchantId) {
      throw ApiError.of(ErrorCode.API_KEY_NOT_FOUND);
    }
    if (key.revokedAt) {
      throw ApiError.of(ErrorCode.ALREADY_IN_STATE, 'This API key is already revoked.');
    }

    await this.prisma.$transaction([
      this.prisma.apiKey.update({
        where: { id: key.id },
        data: { revokedAt: new Date() },
      }),
      this.prisma.resolution.create({
        data: {
          publicId: generatePublicId('pf-res'),
          actorId,
          actorType: ActorType.USER,
          action: 'REVOKE_API_KEY',
          subjectType: 'API_KEY',
          subjectPublicId: key.publicId,
        },
      }),
    ]);

    return this.present({ ...key, revokedAt: new Date() });
  }

  /**
   * Which key authenticated this request, for audit trails. Returns null for
   * session-authenticated calls.
   */
  async describeActor(actorId: string): Promise<Prisma.ApiKeyGetPayload<Record<string, never>> | null> {
    if (!actorId) {
      return null;
    }
    return this.prisma.apiKey.findUnique({ where: { id: actorId } });
  }

  private present(key: {
    publicId: string;
    name: string;
    prefix: string;
    scopes: string[];
    mode: string;
    lastUsedAt: Date | null;
    expiresAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
  }) {
    return {
      publicId: key.publicId,
      name: key.name,
      // Only the lookup prefix is exposed; the secret half never leaves the
      // create response.
      prefix: `pf_${key.mode === 'TEST' ? 'test' : 'live'}_${key.prefix}_…`,
      scopes: key.scopes as ScopeValue[],
      mode: key.mode,
      status: key.revokedAt ? 'REVOKED' : key.expiresAt && key.expiresAt < new Date() ? 'EXPIRED' : 'ACTIVE',
      lastUsedAt: key.lastUsedAt,
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
    };
  }
}