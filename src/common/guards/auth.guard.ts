import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ActorType } from '@prisma/client';
import { RequestUser } from '../auth/request-user';
import { hashApiKey } from '../crypto/crypto';
import { ApiError, ErrorCode } from '../errors/api-error';
import { setRequestContext } from '../logger/logger';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PrismaService } from '../../database/prisma.service';

/**
 * Narrow structural type so the guard does not depend on JwtService directly.
 * Bound to a concrete implementation in `AppModule`.
 */
export interface TokenVerifier {
  verify(token: string): Promise<{ sub: string }>;
}

/** DI token for the above. */
export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');

/**
 * Authenticates a request as either an API key or a session JWT.
 *
 * API keys are tried first because a merchant's server is the dominant caller
 * and should not pay for a JWT verify + a `users.findUnique` on every request.
 * A request carrying exactly one credential type is unambiguous; a request
 * carrying both is rejected rather than guessed at.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    @Inject(TOKEN_VERIFIER) private readonly jwtService: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.isPublic(context)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      user?: RequestUser;
    }>();

    const apiKeyHeader = firstHeader(request.headers['x-api-key']);
    const authorization = firstHeader(request.headers.authorization);
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;

    if (apiKeyHeader && bearer) {
      throw ApiError.of(
        ErrorCode.UNAUTHENTICATED,
        'Send either an API key or a login token, not both.',
      );
    }

    const principal = apiKeyHeader
      ? await this.authenticateApiKey(apiKeyHeader)
      : await this.authenticateJwt(bearer);

    request.user = principal;
    setRequestContext({
      actorId: principal.id,
      actorType: principal.actorType,
      merchantId: principal.merchantId ?? undefined,
    });
    return true;
  }

  private isPublic(context: ExecutionContext): boolean {
    return !!this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
  }

  private async authenticateApiKey(rawKey: string): Promise<RequestUser> {
    const key = await this.prisma.apiKey.findUnique({ where: { hash: hashApiKey(rawKey) } });

    if (!key) {
      throw ApiError.of(ErrorCode.INVALID_API_KEY);
    }
    if (key.revokedAt) {
      throw ApiError.of(ErrorCode.TOKEN_REVOKED, 'This API key has been revoked.');
    }
    if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) {
      throw ApiError.of(ErrorCode.TOKEN_EXPIRED, 'This API key has expired.');
    }
    if (!key.merchantId) {
      throw ApiError.of(
        ErrorCode.FORBIDDEN,
        'This API key is not attached to a merchant and cannot call this endpoint.',
      );
    }

    const merchant = await this.prisma.merchants.findUnique({
      where: { id: key.merchantId },
      select: { status: true },
    });
    if (!merchant) {
      throw ApiError.of(ErrorCode.MERCHANT_NOT_FOUND);
    }
    if (merchant.status !== 'ACTIVE') {
      throw ApiError.of(
        ErrorCode.MERCHANT_NOT_ACTIVE,
        'This merchant account is not active.',
      );
    }

    // Fire-and-forget: a failure to record usage must never fail the request.
    void this.prisma.apiKey
      .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    return {
      actorType: ActorType.API_KEY,
      id: key.id,
      publicId: key.publicId,
      email: null,
      role: 'MERCHANT',
      status: merchant.status,
      countryCode: null,
      merchantId: key.merchantId,
      scopes: key.scopes,
    };
  }

  private async authenticateJwt(token: string | undefined): Promise<RequestUser> {
    if (!token) {
      throw ApiError.of(
        ErrorCode.UNAUTHENTICATED,
        'Please sign in. Send an API key or a login token.',
      );
    }

    const payload = await this.jwtService.verify(token);

    const user = await this.prisma.users.findUnique({ where: { id: payload.sub } });
    if (!user || user.deletedAt) {
      throw ApiError.of(ErrorCode.TOKEN_EXPIRED, 'Your login session is not valid. Please sign in again.');
    }

    return {
      actorType: ActorType.USER,
      id: user.id,
      publicId: user.publicId,
      email: user.email,
      role: user.role,
      status: user.status,
      countryCode: user.countryCode,
      merchantId: user.merchantId,
      scopes: [],
    };
  }
}


function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}