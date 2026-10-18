import { AccountStatus, ActorType, Role } from '@prisma/client';

/**
 * The authenticated principal on a request.
 *
 * PayForge accepts two credential types:
 *  - a session JWT, issued to a human who signed in (operator/dashboard use)
 *  - an API key, issued to a merchant's own server (integration use)
 *
 * Both resolve to this shape so controllers do not branch on credential type.
 * `actorType` records which was used, and lands in the audit log.
 */
export type RequestUser = {
  actorType: ActorType;
  /** Users.id, or ApiKey.id for key-authenticated requests. */
  id: string;
  publicId: string;
  email: string | null;
  role: Role;
  status: AccountStatus;
  countryCode: string | null;
  merchantId: string | null;
  /** Granted scopes. Always populated for API-key requests; empty for JWT. */
  scopes: string[];
};

export function isApiKeyActor(user: RequestUser): boolean {
  return user.actorType === 'API_KEY';
}

export function isSuperAdmin(user: RequestUser): boolean {
  return user.role === Role.SUPER_ADMIN;
}