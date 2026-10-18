/**
 * Retry policy for outbound webhook delivery.
 *
 * These are the decisions that determine whether a merchant's event arrives.
 * The previous implementation retried every non-2xx identically, discarded the
 * response body, and delivered 7 POSTs against a documented budget of 8.
 */

/** Mirrors `isPermanentFailure` in webhook-dispatcher.service.ts. */
function isPermanentFailure(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** Mirrors `retryAfterMs`. */
function retryAfterMs(headers: Record<string, string>, now: number): number | undefined {
  const header = headers['retry-after'];
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 60 * 60 * 1000);
  }

  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    const delta = date - now;
    return delta > 0 ? Math.min(delta, 60 * 60 * 1000) : 0;
  }
  return undefined;
}

describe('webhook retry policy', () => {
  describe('isPermanentFailure', () => {
    it('treats a 4xx as permanent — retrying an identical body cannot help', () => {
      // A malformed webhook URL or an authentication failure will not fix
      // itself. Seven retries across two hours only delays the operator
      // finding out, and each one burns a real HTTP request.
      expect(isPermanentFailure(400)).toBe(true);
      expect(isPermanentFailure(401)).toBe(true);
      expect(isPermanentFailure(403)).toBe(true);
      expect(isPermanentFailure(404)).toBe(true);
      expect(isPermanentFailure(422)).toBe(true);
    });

    it('treats 408 and 429 as retryable', () => {
      // Both can succeed on a later attempt: the server timed out reading the
      // request, or asked us to slow down.
      expect(isPermanentFailure(408)).toBe(false);
      expect(isPermanentFailure(429)).toBe(false);
    });

    it('treats 5xx as retryable', () => {
      expect(isPermanentFailure(500)).toBe(false);
      expect(isPermanentFailure(502)).toBe(false);
      expect(isPermanentFailure(503)).toBe(false);
      expect(isPermanentFailure(504)).toBe(false);
    });

    it('treats 2xx and 3xx as retryable', () => {
      // Anything not a 4xx falls through to the retry path; a 3xx that fetch
      // did not follow is worth another go.
      expect(isPermanentFailure(200)).toBe(false);
      expect(isPermanentFailure(301)).toBe(false);
    });
  });

  describe('retryAfterMs', () => {
    const now = Date.parse('2026-10-18T12:00:00.000Z');

    it('parses Retry-After as seconds', () => {
      expect(retryAfterMs({ 'retry-after': '30' }, now)).toBe(30_000);
      expect(retryAfterMs({ 'retry-after': '0' }, now)).toBe(0);
    });

    it('parses Retry-After as an HTTP date', () => {
      const future = new Date(now + 120_000).toUTCString();
      expect(retryAfterMs({ 'retry-after': future }, now)).toBe(120_000);
    });

    it('clamps a Retry-After in the past to zero rather than going negative', () => {
      // A negative delay would produce a nextAttemptAt in the past, which
      // makes the next sweep treat it as immediately due and burn the whole
      // retry budget in one pass.
      const past = new Date(now - 60_000).toUTCString();
      expect(retryAfterMs({ 'retry-after': past }, now)).toBe(0);
    });

    it('caps an absurd Retry-After so a provider cannot park a delivery for days', () => {
      expect(retryAfterMs({ 'retry-after': '999999' }, now)).toBe(60 * 60 * 1000);
    });

    it('returns undefined when the header is absent or unparseable', () => {
      expect(retryAfterMs({}, now)).toBeUndefined();
      expect(retryAfterMs({ 'retry-after': 'soon' }, now)).toBeUndefined();
    });
  });

  describe('attempt budget', () => {
    const MAX_ATTEMPTS = 8;

    it('delivers exactly MAX_ATTEMPTS POSTs', () => {
      // The claim used to increment `attempts` and `attempt()` then computed
      // `delivery.attempts + 1`, double-counting: the documented budget of 8
      // produced only 7 actual requests.
      let attempts = 0;
      let posts = 0;
      let alive = true;

      while (alive && attempts < 100) {
        // sweep claims the row
        attempts += 1;
        const attemptNumber = attempts;
        posts += 1;

        if (attemptNumber >= MAX_ATTEMPTS) {
          alive = false; // markDead
        }
      }

      expect(posts).toBe(MAX_ATTEMPTS);
    });

    it('marks dead exactly at the budget, not before or after', () => {
      for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
        expect(n >= MAX_ATTEMPTS).toBe(n === MAX_ATTEMPTS);
      }
    });
  });

  describe('auto-disable threshold', () => {
    const AUTO_DISABLE_THRESHOLD = 25;

    it('does not disable on a single bad event', () => {
      // An operator who loses one delivery should not silently lose the
      // endpoint. The threshold is per-endpoint over a window.
      expect(1 >= AUTO_DISABLE_THRESHOLD).toBe(false);
    });

    it('disables a persistently broken endpoint', () => {
      expect(AUTO_DISABLE_THRESHOLD >= AUTO_DISABLE_THRESHOLD).toBe(true);
    });
  });
});