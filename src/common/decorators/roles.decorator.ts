import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export const ROLES_KEY = 'roles';

export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Require any valid credential but no specific role or scope.
 *
 * The authorization guard fails closed, so an endpoint with no `@Roles` and no
 * `@Scopes` is unreachable. Use this to opt an endpoint back in.
 */
export const AUTHENTICATED_KEY = 'payforge:authenticated';
export const Authenticated = () => SetMetadata(AUTHENTICATED_KEY, true);