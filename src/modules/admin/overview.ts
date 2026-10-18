import { calendarMonthsInclusive } from '../../common/money/money';

export type OverviewPayment = {
  merchantId: string;
  settlementAmount: bigint;
  settlementCurrency: string;
  createdAt: Date;
};

export type OverviewLedger = {
  currency: string;
  amount: bigint;
  type: 'CREDIT' | 'DEBIT';
  createdAt: Date;
};

export type OverviewMerchant = {
  id: string;
  publicId: string;
  name: string;
  createdAt: Date;
};

function signed(entry: OverviewLedger): bigint {
  return entry.type === 'CREDIT' ? entry.amount : -entry.amount;
}

function sameUtcMonth(left: Date, right: Date): boolean {
  return left.getUTCFullYear() === right.getUTCFullYear() && left.getUTCMonth() === right.getUTCMonth();
}

function add(map: Map<string, bigint>, currency: string, amount: bigint) {
  map.set(currency, (map.get(currency) ?? 0n) + amount);
}

export function platformFeeTotals(entries: OverviewLedger[], now: Date) {
  const thisMonth = new Map<string, bigint>();
  const allTime = new Map<string, bigint>();
  for (const entry of entries) {
    const amount = signed(entry);
    add(allTime, entry.currency, amount);
    if (sameUtcMonth(entry.createdAt, now)) {
      add(thisMonth, entry.currency, amount);
    }
  }
  return { thisMonth, allTime };
}

export function merchantMoney(merchants: OverviewMerchant[], payments: OverviewPayment[], now: Date) {
  return merchants.map((merchant) => {
    const months = calendarMonthsInclusive(merchant.createdAt, now);
    const totals = new Map<string, bigint>();
    const monthTotals = new Map<string, bigint>();
    for (const payment of payments) {
      if (payment.merchantId !== merchant.id) {
        continue;
      }
      add(totals, payment.settlementCurrency, payment.settlementAmount);
      if (sameUtcMonth(payment.createdAt, now)) {
        add(monthTotals, payment.settlementCurrency, payment.settlementAmount);
      }
    }
    const currencies = new Set([...totals.keys(), ...monthTotals.keys()]);
    return {
      publicId: merchant.publicId,
      name: merchant.name,
      months,
      byCurrency: [...currencies].sort().map((currency) => ({
        currency,
        thisMonthMinor: monthTotals.get(currency) ?? 0n,
        averageMinor: (totals.get(currency) ?? 0n) / BigInt(months),
      })),
    };
  });
}
