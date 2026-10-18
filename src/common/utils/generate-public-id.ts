import { randomUUID } from 'crypto';

export function generatePublicId(prefix: string): string {
  const normalizedPrefix = prefix?.trim();
  if (!normalizedPrefix) {
    throw new Error('Prefix is required to generate public id');
  }

  const id = randomUUID().replace(/-/g, '').substring(0, 8);
  return `${normalizedPrefix}-${id}`.toUpperCase();
}
