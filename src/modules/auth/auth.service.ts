import { ConflictException, Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import bcrypt from 'bcrypt';
import { generatePublicId } from '../../common/utils/generate-public-id';
import { PrismaService } from '../../database/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterMerchantDto } from './dto/register-merchant.dto';
import { RegisterUserDto } from './dto/register-user.dto';

@Injectable()
export class AuthService implements OnModuleInit {
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
        passwordHash: await bcrypt.hash(this.config.getOrThrow<string>('SUPER_ADMIN_PASSWORD'), 10),
        countryCode: 'IN',
        role: Role.SUPER_ADMIN,
      },
    });
  }

  async registerUser(dto: RegisterUserDto) {
    await this.ensureEmailAvailable(dto.email);
    const user = await this.prisma.users.create({
      data: {
        publicId: generatePublicId('pf-usr'),
        email: dto.email,
        passwordHash: await bcrypt.hash(dto.password, 10),
        countryCode: dto.countryCode,
        role: Role.USER,
      },
    });
    return this.profile(user);
  }

  async registerMerchant(dto: RegisterMerchantDto) {
    await this.ensureEmailAvailable(dto.email);
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const created = await this.prisma.$transaction(async (tx) => {
      const merchant = await tx.merchants.create({
        data: {
          publicId: generatePublicId('pf-mer'),
          name: dto.name,
          email: dto.email,
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
    }, { maxWait: 10000, timeout: 20000 });

    return {
      ...this.profile(created.user),
      merchant: {
        publicId: created.merchant.publicId,
        name: created.merchant.name,
        status: created.merchant.status,
      },
    };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.users.findUnique({
      where: { email: dto.email },
      include: { merchant: { select: { publicId: true } } },
    });
    const matches = user ? await bcrypt.compare(dto.password, user.passwordHash) : false;
    if (!user || !matches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const accessToken = await this.jwt.signAsync({ sub: user.id, role: user.role });
    return {
      accessToken,
      user: {
        ...this.profile(user),
        merchantPublicId: user.merchant?.publicId ?? null,
      },
    };
  }

  private async ensureEmailAvailable(email: string) {
    const existing = await this.prisma.users.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('Email is already registered');
    }
  }

  private profile(user: { publicId: string; email: string; role: Role; countryCode: string; status: string }) {
    return {
      publicId: user.publicId,
      email: user.email,
      role: user.role,
      countryCode: user.countryCode,
      status: user.status,
    };
  }
}
