#!/usr/bin/env node
/**
 * Writes vercel.json with an optional /api/* reverse proxy to BACKEND_URL.
 * Set BACKEND_URL in Vercel project env (or locally before deploy) to your public API origin.
 */
const fs = require('fs');
const path = require('path');

const backend = (process.env.BACKEND_URL || process.env.AURA_BACKEND_URL || '').replace(/\/$/, '');

const rewrites = [];

if (backend) {
  rewrites.push({
    source: '/api/(.*)',
    destination: `${backend}/$1`,
  });
}

rewrites.push({
  source: '/(.*)',
  destination: '/index.html',
});

const config = {
  version: 2,
  buildCommand: 'node scripts/generate-vercel-config.cjs && cd apps/operator-console && npx vite build',
  outputDirectory: 'apps/operator-console/dist',
  framework: 'vite',
  rewrites,
};

const outPath = path.join(__dirname, '..', 'vercel.json');
fs.writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(
  backend
    ? `Wrote vercel.json with API proxy -> ${backend}`
    : 'Wrote vercel.json without API proxy (set BACKEND_URL to enable)',
);
