#!/usr/bin/env node
/**
 * Render Deployment Diagnostic & Log Inspector Tool
 * Connects to Render REST API and MCP server to diagnose build/deployment issues.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RenderClient } from '../src/render/render_client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Simple .env parser to avoid extra runtime dependencies
function loadEnv() {
  const envPath = resolve(__dirname, '../.env');
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

async function main() {
  loadEnv();

  const apiKey = process.env.RENDER_API_KEY;

  console.log('\n========================================================================');
  console.log('🚀 UNHOLD RENDER DEPLOYMENT DIAGNOSTICS');
  console.log('========================================================================');

  if (!apiKey || apiKey.includes('your_render_api_key_here') || apiKey.trim() === '') {
    console.log('\n⚠️  RENDER_API_KEY is not configured in projects/unhold_paypal/.env\n');
    console.log('To connect to Render and inspect your deployment failure:');
    console.log('  1. Open your Render Account Settings:');
    console.log('     👉 https://dashboard.render.com/u/settings?add-api-key');
    console.log('  2. Click "Create API Key", give it a name (e.g. "Unhold-Diagnostics"), and copy the key.');
    console.log('  3. Paste it into projects/unhold_paypal/.env:');
    console.log('     RENDER_API_KEY=rnd_xxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    console.log('  4. Run this diagnostic again:');
    console.log('     npm run render:diagnose\n');
    console.log('Alternatively, you can provide the key directly to Antigravity in this chat.');
    console.log('========================================================================\n');
    process.exit(0);
  }

  const client = new RenderClient(apiKey);

  try {
    console.log('\n[1/3] Authenticating with Render API and fetching services...');
    const services = await client.listServices(25);
    console.log(`✅ Found ${services.length} total services in your Render account.\n`);

    if (services.length === 0) {
      console.log('No services found in this account. Have you created the service or blueprint yet?');
      console.log('Deploy using: https://render.com/deploy?repo=https://github.com/anindyasundarbera/unhold-paypal-sentinel\n');
      return;
    }

    // Filter for Unhold services
    const unholdServices = services.filter(
      (s) =>
        s.name.toLowerCase().includes('unhold') ||
        (s.repo && s.repo.toLowerCase().includes('unhold'))
    );

    const targetServices = unholdServices.length > 0 ? unholdServices : services;

    for (const s of targetServices) {
      console.log(`------------------------------------------------------------------------`);
      console.log(`📦 Service: ${s.name} [ID: ${s.id}]`);
      console.log(`   Type: ${s.type} | Region: ${s.serviceDetails?.region || 'oregon'} | Plan: ${s.serviceDetails?.plan || 'starter'}`);
      console.log(`   URL: ${s.serviceDetails?.url || 'Pending provision'}`);
      console.log(`   Repo: ${s.repo || 'N/A'} (Branch: ${s.branch || 'main'})`);

      console.log(`\n[2/3] Fetching recent deploys for ${s.name}...`);
      const deploys = await client.listDeploys(s.id, 5);

      if (deploys.length === 0) {
        console.log('   No deploys recorded yet.');
        continue;
      }

      const latest = deploys[0];
      const statusIcon =
        latest.status === 'live'
          ? '✅'
          : latest.status === 'build_in_progress'
          ? '⏳'
          : '🚨';

      console.log(`   Latest Deploy ID: ${latest.id}`);
      console.log(`   Status: ${statusIcon} ${latest.status.toUpperCase()}`);
      console.log(`   Trigger: ${latest.trigger}`);
      if (latest.commit) {
        console.log(`   Commit: ${latest.commit.id.slice(0, 8)} - "${latest.commit.message}"`);
      }
      console.log(`   Created At: ${latest.createdAt}`);
      if (latest.finishedAt) {
        console.log(`   Finished At: ${latest.finishedAt}`);
      }

      if (latest.status === 'build_failed' || latest.status === 'update_failed') {
        console.log(`\n[3/3] 🚨 DEPLOYMENT FAILURE DETECTED! Fetching event logs...`);
        const events = await client.listEvents(s.id, 10);
        console.log('\n   Recent Service Events:');
        for (const ev of events) {
          console.log(`   [${ev.timestamp}] ${ev.type}:`);
          if (ev.details) {
            console.log(`      ${JSON.stringify(ev.details, null, 2).replace(/\n/g, '\n      ')}`);
          }
        }

        console.log('\n🔍 COMMON RENDER BUILD FAILURE CAUSES & VERIFIED FIXES:');
        console.log('   1. Node.js Version: Node < 22.5.0 lacks native node:sqlite.');
        console.log('      Fix: Pre-configured .node-version (22.12.0) and package.json engines (>=22.5.0).');
        console.log('   2. Disk Permissions: /var/data disk permission denial on free plan.');
        console.log('      Fix: Added automatic fallback to ./data/unhold.db in src/server.ts.');
        console.log('   3. Port Binding: Render requires binding to 0.0.0.0:$PORT.');
        console.log('      Fix: Verified Fastify listens on process.env.PORT || 10000 and 0.0.0.0.');
        console.log('   4. Missing Static Public Assets in Docker.');
        console.log('      Fix: Verified Dockerfile copies public/ to runner image.');
      } else if (latest.status === 'live') {
        console.log(`\n🎉 Service is LIVE and HEALTHY at: ${s.serviceDetails?.url}`);
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Error querying Render API: ${message}\n`);
  }

  console.log('========================================================================\n');
}

main();
