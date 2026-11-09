import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PayPalClient } from './client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Read existing .env
const candidateEnvPaths = [
  join(process.cwd(), '.env'),
  join(__dirname, '../.env'),
  join(__dirname, '../../.env'),
  join(__dirname, '../../../.env')
];
const env: Record<string, string> = {};
let primaryEnvPath = candidateEnvPaths[0];
let primaryEnvContent = '';

for (const p of candidateEnvPaths) {
  if (existsSync(p)) {
    primaryEnvPath = p;
    primaryEnvContent = readFileSync(p, 'utf8');
    for (const line of primaryEnvContent.split('\n')) {
      if (line.includes('=') && !line.startsWith('#')) {
        const idx = line.indexOf('=');
        env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    break;
  }
}

const clientId = env.PAYPAL_CLIENT_ID;
const clientSecret = env.PAYPAL_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('ERROR: PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET not found in .env');
  process.exit(1);
}

const targetUrl = process.argv[2] || 'https://unhold-api.onrender.com/webhooks/paypal';

const EVENT_TYPES = [
  { name: 'PAYMENT.CAPTURE.PENDING' },
  { name: 'PAYMENT.CAPTURE.COMPLETED' },
  { name: 'PAYMENT.CAPTURE.REFUNDED' },
  { name: 'PAYMENT.CAPTURE.DENIED' },
  { name: 'CUSTOMER.DISPUTE.CREATED' },
  { name: 'CUSTOMER.DISPUTE.RESOLVED' },
  { name: 'CUSTOMER.DISPUTE.UPDATED' },
  { name: 'CHECKOUT.ORDER.COMPLETED' },
  { name: 'CHECKOUT.ORDER.APPROVED' }
];

async function main() {
  console.log(`Connecting to PayPal Sandbox with Client ID ending in ...${clientId.slice(-4)}`);
  const client = new PayPalClient({
    clientId,
    clientSecret,
    environment: 'sandbox'
  });

  const token = await client.getAccessToken();
  console.log('Authentication successful.');

  console.log(`Registering webhook for URL: ${targetUrl}`);
  const response = await fetch('https://api-m.sandbox.paypal.com/v1/notifications/webhooks', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      url: targetUrl,
      event_types: EVENT_TYPES
    })
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`Failed to create webhook (${response.status}):`, err);
    process.exit(1);
  }

  const webhook = (await response.json()) as { id: string; url: string };
  console.log('\n=========================================');
  console.log('SUCCESS! Webhook created in PayPal Sandbox:');
  console.log('Webhook ID:', webhook.id);
  console.log('Target URL:', webhook.url);
  console.log('=========================================\n');

  // Update .env automatically
  let updatedEnv = primaryEnvContent;
  if (updatedEnv.includes('PAYPAL_WEBHOOK_ID=')) {
    updatedEnv = updatedEnv.replace(/PAYPAL_WEBHOOK_ID=.*/, `PAYPAL_WEBHOOK_ID=${webhook.id}`);
  } else {
    updatedEnv += `\nPAYPAL_WEBHOOK_ID=${webhook.id}\n`;
  }

  writeFileSync(primaryEnvPath, updatedEnv, 'utf8');
  console.log(`Updated ${primaryEnvPath} with new PAYPAL_WEBHOOK_ID.`);
}

main().catch(console.error);
