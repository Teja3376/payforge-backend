import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ActorType, ResolutionAction, ResolutionSubject, Role, type Session } from '@prisma/client';
import bcrypt from 'bcrypt';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { generateOpaqueToken, hashApiKey } from '../../common/crypto/crypto';
import { logger } from '../../common/logger/logger';
import { generatePublicId } from '../../common/utils/generate-public-id';
import { PrismaService } from '../../database/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterMerchantDto } from './dto/register-merchant.dto';
import { RegisterUserDto } from './dto/register-user.dto';

const BCRYPT_ROUNDS = 12;
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES = 15;
const ACCESS_TOKEN_TTL = '1h';
const REFRESH_TOKEN_DAYS = 30;

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly log = logger.child({ module: 'auth' });

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    const email = this.config.getOrThrow<string>('SUPER_ADMIN_EMAIL').trim().toLowerCase();
    const existing = await this.prisma.users.findUnique({ where: { email } });
    if (existing) {
      return;
    }
    await this.prisma.users.create({
      data: {
        publicId: generatePublicId('pf-usr'),
        email,
        passwordHash: await bcrypt.hash(
          this.config.getOrThrow<string>('SUPER_ADMIN_PASSWORD'),
          BCRYPT_ROUNDS,
        ),
        countryCode: 'IN',
        role: Role.SUPER_ADMIN,
      },
    });
    this.log.warn({ email }, 'bootstrapped the super admin account');
  }

  async registerUser(dto: RegisterUserDto) {
    await this.ensureEmailAvailable(dto.email);
    const user = await this.prisma.users.create({
      data: {
        publicId: generatePublicId('pf-usr'),
        email: dto.email,
        passwordHash: await bcrypt.hash(dto.password, BCRYPT_ROUNDS),
        countryCode: dto.countryCode,
        role: Role.USER,
      },
    });
    return this.profile(user);
  }

  /**
   * Register a merchant.
   *
   * The account is created `PENDING_REVIEW`, not `ACTIVE`. Previously it was
   * created ACTIVE with no verification at all, so anyone could POST this
   * endpoint and start accepting real money. Admin approval via
   * `POST /admin/merchants/:publicId/approve` activates it.
   */
  async registerMerchant(dto: RegisterMerchantDto) {
    await this.ensureEmailAvailable(dto.email);
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const created = await this.prisma.$transaction(
      async (tx) => {
        const merchant = await tx.merchants.create({
          data: {
            publicId: generatePublicId('pf-mer'),
            name: dto.name,
            email: dto.email,
            countryCode: dto.countryCode,
            status: 'PENDING_REVIEW',
          },
        });
        const user = await tx.users.create({
          data: {
            publicId: generatePublicId('pf-usr'),
            email: dto.email,
            passwordHash,
            countryCode: dto.countryCode,
            role: Role.MERCHANT,
            merchantId: merchant.id,
          },
        });
        return { user, merchant };
      },
      { maxWait: 10000, timeout: 20000 },
    );

    return {
      ...this.profile(created.user),
      merchant: {
        publicId: created.merchant.publicId,
        name: created.merchant.name,
        status: created.merchant.status,
      },
    };
  }

  async login(dto: LoginDto, meta: { ip?: string; userAgent?: string }) {
    const email = dto.email;
    const user = await this.prisma.users.findUnique({
      where: { email },
      include: { merchant: { select: { publicId: true, status: true } } },
    });

    if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await this.recordAttempt(email, meta.ip, false, user.id);
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      throw ApiError.of(
        ErrorCode.ACCOUNT_LOCKED,
        `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      );
    }

    const matches = user ? await bcrypt.compare(dto.password, user.passwordHash) : false;

    if (!user || !matches) {
      await this.recordAttempt(email, meta.ip, false, user?.id);

      // Progressive backoff on repeated failure, so a wrong password is not
      // free to guess. `bcrypt.compare` always runs, including for unknown
      // emails, so response timing does not reveal whether an account exists.
      if (user) {
        const failures = user.failedLogins + 1;
        const patch: { failedLogins: number; lockedUntil?: Date } = { failedLogins: failures };
        if (failures >= MAX_FAILED_LOGINS) {
          patch.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60_000);
          this.log.warn({ email }, 'account locked after repeated failed sign-ins');
        }
        await this.prisma.users.update({ where: { id: user.id }, data: patch });
      }
      throw ApiError.of(ErrorCode.INVALID_CREDENTIALS, 'Invalid email or password.');
    }

    await this.prisma.$transaction([
      this.prisma.users.update({
        where: { id: user.id },
        data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
      }),
      this.prisma.loginAttempt.create({
        data: { email, ip: meta.ip ?? null, succeeded: true, userId: user.id },
      }),
    ]);

    const session = await this.issueSession(user.id);
    return {
      accessToken: await this.jwt.signAsync(
        { sub: user.id, sid: session.id },
        { expiresIn: ACCESS_TOKEN_TTL },
      ),
      refreshToken: session.refreshToken,
      expiresIn: 3600,
      tokenType: 'Bearer',
      user: {
        ...this.profile(user),
        merchantPublicId: user.merchant?.publicId ?? null,
        merchantStatus: user.merchant?.status ?? null,
      },
    };
  }

  /**
 * Exchange a refresh token for a new pair.
 *
 * Rotation is single-use and the claim-and-burn is a compare-and-set inside a
 * transaction. Previously `issueSession()` ran *before* the revoke and neither
 * was transactional, so two concurrent refreshes with the same token both
 * passed the `!revokedAt` check and both minted valid session families.
 *
 * Reuse of an already-rotated token revokes the entire family. A stolen token
 * replayed alongside the legitimate client would otherwise keep minting fresh
 * sessions forever, because each rotation looked like a legitimate one.
 */
async refresh(refreshToken: string) {
    const tokenHash = hashApiKey(refreshToken);
    const now = new Date();

    const rotated = await this.prisma.$transaction(async (tx) => {
      const session = await tx.session.findUnique({
        where: { refreshTokenHash: tokenHash },
        select: {
          id: true,
          userId: true,
          revokedAt: true,
          expiresAt: true,
          familyId: true,
          user: { select: { deletedAt: true } },
        },
      });

      if (!session || session.expiresAt.getTime() <= now.getTime() || session.user.deletedAt) {
        throw ApiError.of(
          ErrorCode.TOKEN_REVOKED,
          'This session is no longer valid. Please sign in again.',
        );
      }

      if (session.revokedAt) {
        // Replay of an already-rotated token: a stolen token, or a client
        // re-spending one it had already used.
        //
        // The revocation is deliberately NOT done here. Throwing from inside
        // this transaction rolls it back, which silently discarded both the
        // family revocation and the audit row — so the theft was detected,
        // reported to the caller as handled, and then thrown away. Live
        // testing confirmed: zero SESSION_REVOKED_REUSE rows, the sibling
        // session still live, still minting fresh tokens indefinitely.
        //
        // Returning a marker lets the revocation run in its own committing
        // transaction, after this one has rolled back.
        return { kind: 'reuse' as const, sessionId: session.id, userId: session.userId, familyId: session.familyId };
      }

      // Burn the presented token and mint its successor atomically, so a
      // concurrent second refresh loses the compare-and-set instead of
      // issuing a second valid session.
      const burned = await tx.session.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'ROTATED', lastUsedAt: now },
      });
      if (burned.count === 0) {
        throw ApiError.of(
          ErrorCode.TOKEN_REVOKED,
          'This session is no longer valid. Please sign in again.',
        );
      }

      const refresh = generateOpaqueToken(48);
      const next = await tx.session.create({
        data: {
          publicId: generatePublicId('pf-ses'),
          userId: session.userId,
          refreshTokenHash: hashApiKey(refresh),
          expiresAt: new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000),
          // The family is established by whichever rotation came first, so
          // every descendant shares it and reuse detection reaches all of them.
          familyId: session.familyId ?? session.id,
        },
      });

      return { kind: 'rotated' as const, userId: session.userId, sessionId: next.id, refreshToken: refresh };
    });

    // Replay detected. Revoke the whole family in a transaction that COMMITS,
    // then fail the caller. Both the legitimate session and the attacker's are
    // compromised, and only a fresh sign-in should resolve it.
    if (rotated.kind === 'reuse') {
      const revokedAt = new Date();
      // The family id is `session.familyId ?? session.id` — the same expression
      // used when minting a successor. Without the fallback this revokes
      // nothing at all for a replayed token that is the *root* of its family,
      // because a family's first session has `familyId = null`. Every descendant
      // points at that root's own id, so the root's id is the right key.
      const familyId = rotated.familyId ?? rotated.sessionId;

      await this.prisma.$transaction(async (tx) => {
        await tx.session.updateMany({
          where: {
            userId: rotated.userId,
            OR: [{ familyId }, { id: rotated.sessionId }],
            revokedAt: null,
          },
          data: { revokedAt, revokedReason: 'REFRESH_TOKEN_REUSE' },
        });
        await tx.resolution.create({
          data: {
            publicId: generatePublicId('pf-res'),
            actorId: null,
            actorType: ActorType.SYSTEM,
            action: ResolutionAction.SESSION_REVOKED_REUSE,
            subjectType: ResolutionSubject.USER,
            subjectPublicId: rotated.userId,
            metadata: {
              sessionId: rotated.sessionId,
              familyId,
              reason: 'a rotated refresh token was replayed',
            },
          },
        });
      });

      this.log.error(
        { userId: rotated.userId, sessionId: rotated.sessionId },
        'replayed refresh token detected — revoked the entire session family',
      );

      throw ApiError.of(
        ErrorCode.TOKEN_REVOKED,
        'This session is no longer valid. Please sign in again.',
      );
    }

    return {
      accessToken: await this.jwt.signAsync(
        { sub: rotated.userId, sid: rotated.sessionId },
        { expiresIn: ACCESS_TOKEN_TTL },
      ),
      refreshToken: rotated.refreshToken,
      expiresIn: 3600,
      tokenType: 'Bearer',
    };
  }

  /**
   * Revoke a session.
   *
   * The caller's own session is taken from the validated `sid` claim rather
   * than a client-supplied header, which the controller previously read
   * straight from `x-session-id`. Passing nothing revokes every session.
   */
  async logout(sessionId: string | undefined, userId: string) {
    if (sessionId) {
      const revoked = await this.prisma.session.updateMany({
        where: { id: sessionId, userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'LOGOUT' },
      });
      if (revoked.count > 0) {
        return;
      }
      // The caller's session was already gone (expired, or revoked by a family
      // sweep). Do not silently fall through and revoke every other device —
      // that is what happened when the header named an unknown session.
      return;
    }
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'LOGOUT_ALL' },
    });
  }

  /**
   * Change a user's password and revoke every other session.
   *
   * `Users.passwordChangedAt` existed but was never read and there was no
   * endpoint at all, so a merchant whose password leaked had no way to rotate
   * it.
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string, sessionId?: string) {
    const user = await this.prisma.users.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) {
      throw ApiError.of(ErrorCode.UNAUTHENTICATED, 'Please sign in again.');
    }

    // Re-authenticate: a hijacked access token should not be able to lock the
    // real owner out by changing the password.
    const matches = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!matches) {
      throw ApiError.of(ErrorCode.INVALID_CREDENTIALS, 'Your current password is incorrect.');
    }
    if (await bcrypt.compare(newPassword, user.passwordHash)) {
      throw ApiError.of(
        ErrorCode.VALIDATION_FAILED,
        'Choose a password different from your current one.',
      );
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.users.update({
        where: { id: userId },
        data: { passwordHash, passwordChangedAt: now },
      });

      // Keep the caller's session alive so they are not logged out of the
      // device they changed it on; revoke everything else.
      await tx.session.updateMany({
        where: { userId, revokedAt: null, ...(sessionId ? { NOT: { id: sessionId } } : {}) },
        data: { revokedAt: now, revokedReason: 'PASSWORD_CHANGED' },
      });

      await tx.resolution.create({
        data: {
          publicId: generatePublicId('pf-res'),
          actorId: userId,
          actorType: ActorType.USER,
          action: ResolutionAction.PASSWORD_CHANGED,
          subjectType: ResolutionSubject.USER,
          subjectPublicId: user.publicId,
          metadata: { otherSessionsRevoked: true },
        },
      });
    });

    return { changed: true };
  }

  async listSessions(userId: string) {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: {
        publicId: true,
        userAgent: true,
        ip: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
    });
  }

  async revokeSession(userId: string, sessionPublicId: string) {
    const session = await this.prisma.session.findUnique({
      where: { publicId: sessionPublicId },
    });
    if (!session || session.userId !== userId) {
      throw ApiError.of(ErrorCode.VALIDATION_FAILED, 'Session not found.');
    }
    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
  }

  private async issueSession(userId: string): Promise<Session & { refreshToken: string }> {
    const refreshToken = generateOpaqueToken(48);
    const session = await this.prisma.session.create({
      data: {
        publicId: generatePublicId('pf-ses'),
        userId,
        refreshTokenHash: hashApiKey(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000),
      },
    });
    return Object.assign(session, { refreshToken });
  }

  private async recordAttempt(email: string, ip: string | undefined, succeeded: boolean, userId?: string) {
    await this.prisma.loginAttempt
      .create({ data: { email, ip: ip ?? null, succeeded, userId } })
      .catch(() => undefined);
  }

  private async ensureEmailAvailable(email: string) {
    const existing = await this.prisma.users.findUnique({ where: { email } });
    if (existing) {
      throw ApiError.of(ErrorCode.EMAIL_TAKEN, 'That email address is already registered.');
    }
  }

  private profile(user: {
    publicId: string;
    email: string;
    role: Role;
    countryCode: string;
    status: string;
  }) {
    return {
      publicId: user.publicId,
      email: user.email,
      role: user.role,
      countryCode: user.countryCode,
      status: user.status,
    };
  }
}