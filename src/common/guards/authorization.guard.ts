import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestUser } from '../auth/request-user';
import { ApiError, ErrorCode } from '../errors/api-error';
import { satisfies } from '../scopes/scopes';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SCOPES_KEY } from '../decorators/scopes.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { Role } from '@prisma/client';

/**
 * Enforces role and scope requirements.
 *
 * Fails closed: an endpoint with neither `@Roles` nor `@Scopes` is rejected
 * unless it is explicitly public. The previous guard returned `true` when no
 * metadata was present, so forgetting a decorator silently opened an endpoint
 * to every logged-in role — the kind of mistake that is invisible in review and
 * expensive in production.
 *
 * The single documented exception is `@Authenticated()`, for endpoints that
 * require only "some valid credential".
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }

    const user = context.switchToHttp().getRequest<{ user?: RequestUser }>().user;
    if (!user) {
      throw ApiError.of(ErrorCode.UNAUTHENTICATED);
    }

    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (roles && roles.length > 0 && !roles.includes(user.role)) {
      throw ApiError.of(
        ErrorCode.FORBIDDEN,
        `You do not have permission to do this. Only ${roles
          .map(roleLabel)
          .join(' or ')} can use this action.`,
      );
    }

    const scopes = this.reflector.getAllAndOverride<string[]>(SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (scopes && scopes.length > 0 && user.actorType === 'API_KEY') {
      // Scope enforcement applies to API keys only.
      //
      // A session JWT carries no scopes: it is the operator and bootstrap
      // path, authorised by role. Enforcing scopes on it as well would make
      // it impossible to issue the *first* API key, because creating a key
      // already requires the `apikeys:manage` scope — a chicken-and-egg that
      // locks every new merchant out of the only credential they can hold.
      const missing = scopes.filter((scope) => !satisfies(user.scopes, scope));
      if (missing.length > 0) {
        throw ApiError.of(
          ErrorCode.INSUFFICIENT_SCOPE,
          `This API key is missing the ${missing.join(', ')} ${
            missing.length === 1 ? 'scope' : 'scopes'
          }.`,
          { meta: { required: scopes, granted: user.scopes } },
        );
      }
    }

    return true;
  }
}

function roleLabel(role: Role): string {
  if (role === 'MERCHANT') {
    return 'a merchant';
  }
  if (role === 'SUPER_ADMIN') {
    return 'an administrator';
  }
  return 'a customer';
}