import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BankPort } from './bank.port';

@Injectable()
export class MockBankAdapter implements BankPort {
  async createCharge(): Promise<{ gatewayRef: string }> {
    return { gatewayRef: `mock_${randomUUID().replace(/-/g, '')}` };
  }
}
