export interface BankPort {
  createCharge(): Promise<{ gatewayRef: string }>;
}

export const BANK_PORT = Symbol('BANK_PORT');
