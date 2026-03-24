export function toPaisa(amount: number): bigint {
  return BigInt(Math.round(amount * 100));
}

export function toRupees(amount: bigint): number {
  return Number(amount) / 100;
}