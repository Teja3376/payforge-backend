#!/usr/bin/env node
/**
 * `payforge` — local development toolkit for PayForge integrations.
 *
 * Commands:
 *   payforge login                 store an API key for this machine
 *   payforge listen                forward webhook events to your local server
 *   payforge cards                 print test card numbers
 *   payforge doctor                check your environment and key scopes
 *   payforge webhook verify        verify a captured webhook payload
 */

import { createInterface } from 'node:readline/promises';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const CONFIG_DIR = join(homedir(), '.payforge');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const TEST_CARDS = [
  { brand: 'Visa', number: '4111111111111111', cvv: '123', expiry: '12/34' },
  { brand: 'Mastercard', number: '5555555555554444', cvv: '123', expiry: '12/34' },
  { brand: 'Amex', number: '378282246310005', cvv: '1234', expiry: '12/34' },
  { brand: 'RuPay', number: '6011111111111117', cvv: '123', expiry: '12/34' },
  { brand: 'Declines', number: '4000000000000002', cvv: '123', expiry: '12/34' },
];

type Config = { apiKey?: string; baseUrl?: string; localUrl?: string; webhookSecret?: string };

function readConfig(): Config {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Config;
  } catch {
    return {};
  }
}

function writeConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

const baseUrl = (config: Config) => config.baseUrl ?? 'https://api.payforge.dev/v1';

async function cmdLogin(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const existing = readConfig();

  const apiKey = (await rl.question('API key (pf_live_… / pf_test_…): ')).trim();
  if (!apiKey.startsWith('pf_')) {
    console.error('That does not look like a PayForge API key.');
    process.exitCode = 1;
    return;
  }

  const config: Config = { ...existing, apiKey };

  try {
    const response = await fetch(`${baseUrl(existing)}/api-keys`, {
      headers: { 'x-api-key': apiKey, accept: 'application/json' },
    });
    if (!response.ok) {
      const body = (await response.json()) as { message?: string };
      console.error(`Could not verify the key: ${body.message ?? response.status}`);
      process.exitCode = 1;
      return;
    }
    console.log('Key verified.');
  } catch {
    console.warn('Could not reach the API — the key was still saved.');
  }

  writeConfig(config);
  console.log(`Saved to ${CONFIG_FILE} (mode 600).`);
  rl.close();
}

async function cmdDoctor(): Promise<void> {
  const config = readConfig();
  if (!config.apiKey) {
    console.error('No API key stored. Run: payforge login');
    process.exitCode = 1;
    return;
  }

  console.log(`Base URL: ${baseUrl(config)}`);
  try {
    const [keyResponse, healthResponse] = await Promise.all([
      fetch(`${baseUrl(config)}/api-keys`, {
        headers: { 'x-api-key': config.apiKey, accept: 'application/json' },
      }),
      fetch(`${baseUrl(config).replace(/\/v1$/, '')}/health/ready`),
    ]);

    console.log(`Health: ${healthResponse.ok ? 'ok' : `unreachable (${healthResponse.status})`}`);

    if (!keyResponse.ok) {
      const body = (await keyResponse.json()) as { code?: string; message?: string };
      console.error(`Key rejected: ${body.code ?? keyResponse.status} — ${body.message ?? ''}`);
      process.exitCode = 1;
      return;
    }

    const keys = (await keyResponse.json()) as Array<{ name: string; scopes: string[]; mode: string }>;
    console.log('\nYour keys:');
    for (const key of keys) {
      console.log(`  ${key.name} [${key.mode}] → ${key.scopes.join(', ')}`);
    }

    const mode = keys.some((key) => key.mode === 'TEST');
    console.log(
      mode
        ? '\nYou have test keys. Test cards are accepted; no money moves.'
        : '\nYou have live keys. Test card numbers will be rejected.',
    );
  } catch (error) {
    console.error(`Could not reach the API: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

async function cmdCards(): Promise<void> {
  console.log('Test cards (require a TEST-mode API key):\n');
  console.log('  Brand        Number                CVV    Expiry');
  for (const card of TEST_CARDS) {
    console.log(
      `  ${card.brand.padEnd(12)} ${card.number.padEnd(20)} ${card.cvv.padEnd(6)} ${card.expiry}`,
    );
  }
}

async function cmdVerify(args: string[]): Promise<void> {
  const [payloadPath, headerPath] = args;
  if (!payloadPath || !headerPath) {
    console.error('Usage: payforge webhook verify <payload.json> <signature-header>');
    process.exitCode = 1;
    return;
  }

  const config = readConfig();
  const secret = process.env.PAYFORGE_WEBHOOK_SECRET ?? config.webhookSecret;
  if (!secret) {
    console.error('No webhook secret. Set PAYFORGE_WEBHOOK_SECRET or run payforge webhook secret.');
    process.exitCode = 1;
    return;
  }

  const payload = readFileSync(payloadPath, 'utf8');
  const event = JSON.parse(payload) as { id?: string };
  const header = readFileSync(headerPath, 'utf8').trim();

  const parts: Record<string, string> = {};
  for (const segment of header.split(',')) {
    const index = segment.indexOf('=');
    if (index > -1) parts[segment.slice(0, index).trim()] = segment.slice(index + 1).trim();
  }

  const timestamp = Number(parts.t);
  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (age > 300) {
    console.error(`Signature is ${age}s old — outside the 300s tolerance window.`);
    process.exitCode = 1;
    return;
  }

  const expected = Buffer.from(
    createHmac('sha256', secret).update(`${timestamp}.${event.id ?? ''}.${payload}`).digest('hex'),
  );
  const actual = Buffer.from(parts.v1 ?? '');

  const ok = expected.length === actual.length && timingSafeEqual(expected, actual);
  console.log(ok ? 'Signature is valid.' : 'Signature does NOT match.');
  if (!ok) process.exitCode = 1;
}

function usage(): void {
  console.log(`payforge — local development toolkit

  payforge login                 store an API key for this machine
  payforge doctor                check your environment and key scopes
  payforge cards                 print test card numbers
  payforge listen                forward webhook events to your local server
  payforge webhook verify        verify a captured webhook payload`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'login':
      return cmdLogin();
    case 'doctor':
      return cmdDoctor();
    case 'cards':
      return cmdCards();
    case 'webhook':
      if (args[0] === 'verify') return cmdVerify(args.slice(1));
      return usage();
    case 'listen':
      console.log(
        '`payforge listen` needs a running tunnel daemon. Point your webhook endpoint\n' +
          'at the forwarded URL it prints, or use `ngrok http 3000` directly.',
      );
      return;
    default:
      return usage();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

export { TEST_CARDS, readConfig, writeConfig, CONFIG_FILE };