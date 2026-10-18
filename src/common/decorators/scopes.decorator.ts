import { SetMetadata } from '@nestjs/common';

export const SCOPES_KEY = 'payforge:scopes';

/**
 * Declare the API-key scopes an endpoint requires.
 *
 * Session JWTs are unaffected — a signed-in operator is authorised by role.
 * Only `x-api-key` requests are checked against this list.
 */
export const Scopes = (...scopes: string[]) => SetMetadata(SCOPES_KEY, scopes);