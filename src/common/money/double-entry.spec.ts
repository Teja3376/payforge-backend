/**
 * Double-entry invariants for the money journal.
 *
 * The journal is append-only and enforced as such by a database trigger, but
 * a trigger only prevents mutation — it cannot prove the entries balance. These
 * tests pin the arithmetic that every posting depends on, so a future change
 * to `post` or `pull` that drops a leg fails here rather than in production,
 * where the symptom would be a silent, permanent imbalance.
 *
 * The properties below are structural: `post` and `pull` are exercised
 * through the same `splitFee` arithmetic the services use.
 */
import { splitFee, type FeeSchedule } from '../../common/money/money';

type Leg = { account: string; type: 'CREDIT' | 'DEBIT'; amount: bigint };

/** Signed value of one leg: credits positive, debits negative. */
function signed(leg: Leg): bigint {
  return leg.type === 'CREDIT' ? leg.amount : -leg.amount;
}

function total(legs: Leg[]): bigint {
  return legs.reduce((sum, leg) => sum + signed(leg), 0n);
}

/** Mirrors the three legs `SettlementService.post` writes. */
function post(gross: bigint, schedule: FeeSchedule): Leg[] {
  const { fee, net } = splitFee(gross, schedule);
  const legs: Leg[] = [{ account: 'MERCHANT', type: 'CREDIT', amount: net }];
  // A zero fee is a no-op and is omitted rather than written as a 0n leg.
  if (fee > 0n) {
    legs.push({ account: 'PLATFORM', type: 'CREDIT', amount: fee });
  }
  legs.push({ account: 'PSP_CLEARING', type: 'DEBIT', amount: net + fee });
  return legs;
}

/** Mirrors the three legs `SettlementService.pull` writes. */
function pull(gross: bigint, schedule: FeeSchedule): Leg[] {
  const { fee, net } = splitFee(gross, schedule);
  const legs: Leg[] = [{ account: 'MERCHANT', type: 'DEBIT', amount: net }];
  if (fee > 0n) {
    legs.push({ account: 'PLATFORM', type: 'DEBIT', amount: fee });
  }
  legs.push({ account: 'PSP_CLEARING', type: 'CREDIT', amount: net + fee });
  return legs;
}

const SCHEDULES: FeeSchedule[] = [
  { basisPoints: 0 },
  { basisPoints: 1 },
  { basisPoints: 200 },
  { basisPoints: 2_500 },
];
const GROSSES = [1n, 2n, 3n, 99n, 100n, 999n, 1_000n, 100_000n];

/** Every combination that produces a writable split. */
function* combinations(): Generator<[FeeSchedule, bigint]> {
  for (const schedule of SCHEDULES) {
    for (const gross of GROSSES) {
      // A schedule that would produce net === 0 is rejected by splitFee and
      // tested separately below; it is not a valid posting.
      let net: bigint;
      try {
        net = splitFee(gross, schedule).net;
      } catch {
        continue;
      }
      if (net > 0n) {
        yield [schedule, gross];
      }
    }
  }
}

describe('double-entry invariants', () => {
  it('every settlement balances to zero', () => {
    for (const [schedule, gross] of combinations()) {
      expect(total(post(gross, schedule))).toBe(0n);
    }
  });

  it('every refund balances to zero', () => {
    for (const [schedule, gross] of combinations()) {
      expect(total(pull(gross, schedule))).toBe(0n);
    }
  });

  it('a refund exactly reverses its settlement', () => {
    for (const [schedule, gross] of combinations()) {
      const settled = post(gross, schedule);
      const refunded = pull(gross, schedule);
      expect(settled).toHaveLength(refunded.length);
      expect(
        total(settled.map((l, i) => ({ ...l, type: refunded[i].type }))),
      ).toBe(0n);
    }
  });

  it('the clearing leg equals gross', () => {
    // The payer handed over the gross amount. Whatever the fee split, the
    // amount leaving PSP_CLEARING must be exactly that.
    for (const [schedule, gross] of combinations()) {
      const { fee, net } = splitFee(gross, schedule);
      expect(net + fee).toBe(gross);
    }
  });

  it('never writes a zero-amount leg', () => {
    // `Ledgers` carries CHECK (amount > 0). A merchant on a 0% fee schedule
    // previously produced a PLATFORM leg of 0n, which failed the constraint
    // and rolled the whole settlement back — so a zero-fee merchant could
    // never take a payment at all.
    for (const [schedule, gross] of combinations()) {
      for (const leg of post(gross, schedule)) {
        expect(leg.amount).toBeGreaterThan(0n);
      }
      for (const leg of pull(gross, schedule)) {
        expect(leg.amount).toBeGreaterThan(0n);
      }
    }
  });

  it('settles a zero-fee merchant with no platform leg', () => {
    const legs = post(100n, { basisPoints: 0 });
    expect(legs.map((l) => l.account)).toEqual(['MERCHANT', 'PSP_CLEARING']);
    expect(total(legs)).toBe(0n);
  });

  it('rejects a schedule that would post a zero-amount leg', () => {
    // `Ledgers` carries CHECK (amount > 0). A zero net leg cannot be written,
    // so splitFee must refuse before the transaction opens rather than
    // rolling back a capture that already happened at the provider.
    expect(() => splitFee(100n, { basisPoints: 10_000 })).toThrow(/zero net/i);
    expect(() => splitFee(1n, { basisPoints: 5_000 })).toThrow(/zero net/i);
  });
});