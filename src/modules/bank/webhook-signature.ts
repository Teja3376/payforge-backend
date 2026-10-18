import { createHmac, timingSafeEqual } from 'crypto';

export type WebhookBody = {
  gatewayRef: string;
  status: 'SUCCESS' | 'FAILED';
};

export function canonicalWebhookBody(body: WebhookBody): string {
  return JSON.stringify({ gatewayRef: body.gatewayRef, status: body.status });
}

export function signWebhook(body: WebhookBody, secret: string): string {
  return createHmac('sha256', secret).update(canonicalWebhookBody(body)).digest('hex');
}

export function verifyWebhook(body: WebhookBody, signature: string | undefined, secret: string): boolean {
  if (!signature) {
    return false;
  }
  const expected = signWebhook(body, secret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
