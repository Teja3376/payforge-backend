import { v4 as uuidv4 } from 'uuid';

export function generatePublicId(prefix: string): string {
  const normalizedPrefix = prefix?.trim();
  if (!normalizedPrefix) {
    throw new Error('Prefix is required to generate public id');
  }

  const uuid = uuidv4().replace(/-/g, '');
  const id = uuid.substring(0, 8);

  return `${normalizedPrefix}-${id}`.toUpperCase();
}
