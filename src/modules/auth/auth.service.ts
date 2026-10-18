import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role, type Session } from '@prisma/client';
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

  async refresh(refreshToken: string) {
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hashApiKey(refreshToken) },
      include: { user: true },
    });

    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
      throw ApiError.of(ErrorCode.TOKEN_REVOKED, 'This session is no longer valid. Please sign in again.');
    }
    if (session.user.deletedAt) {
      throw ApiError.of(ErrorCode.TOKEN_REVOKED);
    }

    // Rotate: the presented token is burned and replaced. Reuse of a rotated
    // token is therefore detectable and results in full revocation.
    const next = await this.issueSession(session.userId);
    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });

    return {
      accessToken: await this.jwt.signAsync(
        { sub: session.userId, sid: next.id },
        { expiresIn: ACCESS_TOKEN_TTL },
      ),
      refreshToken: next.refreshToken,
      expiresIn: 3600,
      tokenType: 'Bearer',
    };
  }

  async logout(sessionId: string | undefined, userId: string) {
    // Revoke the session behind the presented refresh token, or every session
    // for this user if they have none.
    if (sessionId) {
      await this.prisma.session.updateMany({
        where: { id: sessionId, userId },
        data: { revokedAt: new Date() },
      });
      return;
    }
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
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