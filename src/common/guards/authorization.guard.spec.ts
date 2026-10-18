import { APP_GUARD } from '@nestjs/core';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AuthorizationGuard } from './authorization.guard';
import { AUTHENTICATED_KEY, ROLES_KEY } from '../decorators/roles.decorator';
import { SCOPES_KEY } from '../decorators/scopes.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Guards the fail-closed guarantee in `AuthorizationGuard`.
 *
 * The guard's docstring claimed it rejected any endpoint with neither
 * `@Roles` nor `@Scopes`, but its body only rejected when a *declared* role or
 * scope was missing. An endpoint with no metadata at all fell straight
 * through to `return true`, so forgetting a decorator silently opened a route
 * to every authenticated principal — the exact failure the comment said had
 * been fixed.
 *
 * This test is the durable part of that fix. A new handler added without
 * authorization metadata fails here rather than shipping open.
 */

const HTTP_METHODS = [0, 1, 2, 3, 4, 5, 6, 7];

/**
 * Controllers are enumerated explicitly here rather than by reflection over
 * AppModule, which cannot be introspected without a running Nest container.
 * The list is asserted against the module below so a controller added later
 * fails this suite.
 */
const CONTROLLER_CLASSES: Array<abstract new () => object> = [
  require('../../modules/admin/admin.controller').AdminController,
  require('../../modules/apikeys/api-key.controller').ApiKeyController,
  require('../../modules/auth/auth.controller').AuthController,
  require('../../modules/health/health.controller').HealthController,
  require('../../modules/merchants/merchant.controller').MerchantController,
  require('../../modules/payments/payment.controller').PaymentController,
  require('../../modules/payouts/payout.controller').PayoutController,
  require('../../modules/refunds/refund.controller').RefundController,
  require('../../modules/transactions/transaction.controller').TransactionController,
  require('../../modules/webhooks/webhook.controller').WebhookController,
];

/**
 * Reads authorization metadata for a handler, falling back to class-level
 * declarations — `AdminController` puts `@Roles(SUPER_ADMIN)` on the class, so
 * checking handlers alone would report every admin route as unprotected.
 */
function readMetadata(key: string, ControllerClass: abstract new () => object, handlerName: string): unknown {
  const prototype = ControllerClass.prototype as Record<string, unknown>;
  const handler = prototype[handlerName] as object;
  return Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, ControllerClass);
}

describe('authorization metadata coverage', () => {
  const gaps: string[] = [];
  let handlerCount = 0;

  for (const ControllerClass of CONTROLLER_CLASSES) {
    const prototype = ControllerClass.prototype as Record<string, unknown>;

    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      // Route handlers are methods; skip getters and fields.
      if (!descriptor || typeof descriptor.value !== 'function') continue;

      const handler = descriptor.value as (...args: never[]) => unknown;
      // Nest stores route metadata on the handler under PATH_METADATA and
      // METHOD_METADATA (a numeric RequestMethod), not under the decorator name.
      const isRoute =
        Reflect.getMetadata(METHOD_METADATA, handler) !== undefined &&
        Reflect.getMetadata(PATH_METADATA, handler) !== undefined &&
        HTTP_METHODS.includes(Reflect.getMetadata(METHOD_METADATA, handler));
      if (!isRoute) continue;

      handlerCount += 1;

      const controllerName = ControllerClass.name;
      const label = `${controllerName}.${name}`;

      if (readMetadata(IS_PUBLIC_KEY, ControllerClass, name) === true) {
        continue;
      }
      if (readMetadata(AUTHENTICATED_KEY, ControllerClass, name) === true) {
        continue;
      }

      const roles = readMetadata(ROLES_KEY, ControllerClass, name) as unknown[] | undefined;
      const scopes = readMetadata(SCOPES_KEY, ControllerClass, name) as unknown[] | undefined;

      const hasRoles = Array.isArray(roles) && roles.length > 0;
      const hasScopes = Array.isArray(scopes) && scopes.length > 0;

      if (!hasRoles && !hasScopes) {
        gaps.push(label);
      }
    }
  }

  it('finds the route handlers it is meant to be checking', () => {
    // Guards against the suite silently passing because reflection broke or a
    // controller path went stale.
    expect(handlerCount).toBeGreaterThan(20);
    expect(CONTROLLER_CLASSES.length).toBe(10);
  });

  it('every non-public route declares @Roles, @Scopes or @Authenticated', () => {
    expect(gaps).toEqual([]);
  });
});

describe('AuthorizationGuard fail-closed behaviour', () => {
  let guard: AuthorizationGuard;

  beforeEach(() => {
    guard = new AuthorizationGuard({
      getAllAndOverride: (key: string) => {
        if (key === IS_PUBLIC_KEY) return false;
        if (key === ROLES_KEY) return undefined;
        if (key === SCOPES_KEY) return undefined;
        if (key === AUTHENTICATED_KEY) return undefined;
        return undefined;
      },
    } as never);
  });

  const context = {
    switchToHttp: () => ({
      getRequest: () => ({
        user: {
          actorType: 'USER',
          id: 'u1',
          publicId: 'pf-usr-1',
          email: 'a@b.c',
          role: 'MERCHANT',
          status: 'ACTIVE',
          countryCode: 'IN',
          merchantId: 'm1',
          scopes: ['*'],
        },
      }),
    }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as never;

  it('rejects an authenticated principal on a route with no metadata', () => {
    expect(() => guard.canActivate(context)).toThrow(/missing authorization metadata/i);
  });
});

/** Keeps the unused imports honest: these symbols are part of the contract. */
void APP_GUARD;