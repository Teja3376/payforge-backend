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
  /**
   * The id of whatever authenticated: `Users.id` for a session JWT, or
   * `ApiKey.id` for key authentication.
   *
   * This is an *actor* identity and is suitable for audit trails. It is NOT
   * safe to write into a column that references `Users` — see `ownerUserId`.
   */
  id: string;
  publicId: string;
  email: string | null;
  role: Role;
  status: AccountStatus;
  countryCode: string | null;
  merchantId: string | null;
  /** Granted scopes. Always populated for API-key requests; empty for JWT. */
  scopes: string[];
  /**
   * A real `Users.id` that owns anything this principal creates.
   *
   * `Payments.userId`, `Transactions.userId` and `Resolution.actorId` are
   * foreign keys onto `Users`. Writing an ApiKey id into them raised a foreign
   * key violation, which surfaced as an opaque 500 on every money-write
   * endpoint — so the merchant-server integration path, the one the OpenAPI
   * description advertises, did not work at all with an API key.
   *
   * For a session this is the user themselves. For an API key it is the
   * merchant's owner account, which also makes idempotency merchant-scoped:
   * two different keys on the same merchant writing the same order key
   * collapse onto one row rather than minting two payments.
   */
  ownerUserId: string;
  /**
   * The `sid` claim of the presented JWT, i.e. the Session row it belongs to.
   *
   * Present so a handler can revoke the caller's own session without trusting
   * a client-supplied header — `POST /auth/logout` previously read
   * `x-session-id` straight from the request.
   */
  sessionId?: string;
};

export function isApiKeyActor(user: RequestUser): boolean {
  return user.actorType === 'API_KEY';
}

export function isSuperAdmin(user: RequestUser): boolean {
  return user.role === Role.SUPER_ADMIN;
}