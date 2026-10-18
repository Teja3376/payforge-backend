import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../database/prisma.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { RequestUser } from '../auth/request-user';

type JwtPayload = { sub: string; role: string };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      user?: RequestUser;
    }>();
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) {
      throw new UnauthorizedException('Please sign in. This request has no login token.');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Your login session is not valid. Please sign in again.');
    }

    const user = await this.prisma.users.findUnique({ where: { id: payload.sub } });
    if (!user) {
      throw new UnauthorizedException('Your login session is not valid. Please sign in again.');
    }

    request.user = {
      id: user.id,
      publicId: user.publicId,
      email: user.email,
      role: user.role,
      status: user.status,
      countryCode: user.countryCode,
      merchantId: user.merchantId,
    };
    return true;
  }
}
