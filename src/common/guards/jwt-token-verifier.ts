import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiError, ErrorCode } from '../errors/api-error';
import type { TokenVerifier } from './auth.guard';

/**
 * Binds the `TokenVerifier` interface used by `AuthGuard` to the real
 * `JwtService`.
 *
 * Verification is configured in `AuthModule` with an explicit `algorithms`
 * allowlist and `issuer`/`audience` binding, so a token minted by another
 * service sharing the secret is rejected rather than accepted.
 */
@Injectable()
export class JwtTokenVerifier implements TokenVerifier {
  constructor(private readonly jwt: JwtService) {}

  async verify(token: string): Promise<{ sub: string; sid?: string }> {
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; sid?: string }>(token);
      if (!payload?.sub) {
        throw ApiError.of(ErrorCode.TOKEN_EXPIRED, 'Your login session is not valid. Please sign in again.');
      }
      return payload;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      // Never distinguish an expired token from a forged one: telling the
      // caller which it was is free information for an attacker.
      throw ApiError.of(
        ErrorCode.TOKEN_EXPIRED,
        'Your login session is not valid. Please sign in again.',
      );
    }
  }
}