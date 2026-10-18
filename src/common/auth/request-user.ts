import { AccountStatus, Role } from '@prisma/client';

export type RequestUser = {
  id: string;
  publicId: string;
  email: string;
  role: Role;
  status: AccountStatus;
  countryCode: string;
  merchantId: string | null;
};
