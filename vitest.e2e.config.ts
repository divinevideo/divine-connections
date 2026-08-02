// ABOUTME: Vitest config for the end-to-end suite, which runs in plain Node and
// ABOUTME: talks to a real deployment over the network — no workers pool, no stubs.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    environment: 'node',
    // Every assertion here crosses the public internet: the deployed worker,
    // then whatever upstream API that request fans out to. Cloudflare cold
    // starts and GitHub rate-limit backoff both land well inside 30s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The suite hits shared live infrastructure and asserts on rate-limit
    // behaviour, so parallel files would race each other.
    fileParallelism: false,
  },
})
