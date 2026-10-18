import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { RequestUser } from '../auth/request-user';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles || roles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: RequestUser }>();
    if (!request.user || !roles.includes(request.user.role)) {
      throw new ForbiddenException(
        `You do not have permission to do this. Only ${roles.map(roleLabel).join(' or ')} can use this action.`,
      );
    }
    return true;
  }
}

function roleLabel(role: Role): string {
  if (role === Role.MERCHANT) {
    return 'a merchant';
  }
  if (role === Role.SUPER_ADMIN) {
    return 'an administrator';
  }
  return 'a customer';
}
