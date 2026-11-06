// ABOUTME: Runs the real setup helper against an isolated synthetic command runner.
// ABOUTME: Invalid credentials and an empty home prevent any cached Cloudflare access.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')

function run(provider, input, fail = false) {
  const dir = mkdtempSync(join(tmpdir(), 'provider-setup-test-'))
  const runner = join(dir, 'mock-runner')
  const capture = join(dir, 'capture.json')
  writeFileSync(runner, `#!/usr/bin/env node\nlet input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{require('node:fs').writeFileSync(process.env.MOCK_CAPTURE,JSON.stringify({args:process.argv.slice(2),input}));console.log('synthetic-runner-secret');process.exit(${fail ? 1 : 0})});\n`, { mode: 0o700 })
  // Never inherit a real token, account, config or cached Wrangler OAuth home.
  const env = { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: dir, CLOUDFLARE_API_TOKEN: 'invalid-test-token', CLOUDFLARE_ACCOUNT_ID: 'invalid-test-account', PUBLISHING_SECRET_RUNNER: runner, MOCK_CAPTURE: capture }
  const result = spawnSync('bash', [resolve('scripts/install-publishing-secrets.sh'), provider], { input, env, encoding: 'utf8' })
  const call = existsSync(capture) ? JSON.parse(readFileSync(capture, 'utf8')) : null
  rmSync(dir, { recursive: true, force: true })
  return { ...result, call }
}
for (const [provider, keys] of [['youtube', ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']], ['tiktok', ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET']], ['snapchat', ['SNAPCHAT_CLIENT_ID', 'SNAPCHAT_CLIENT_SECRET']]]) {
  test(`${provider}: writes only a complete selected pair once through pinned bulk stdin`, () => {
    const result = run(provider, 'synthetic-id"\\\nsynthetic-secret $()\n')
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.call.args, ['--no-install', 'wrangler@4.107.0', 'secret', 'bulk', '--name', 'divine-crossposter'])
    assert.deepEqual(JSON.parse(result.call.input), { [keys[0]]: 'synthetic-id"\\', [keys[1]]: 'synthetic-secret $()' })
    for (const value of ['synthetic-id', 'synthetic-secret', 'synthetic-runner-secret']) assert.ok(!(result.stdout + result.stderr).includes(value))
  })
}
for (const input of ['synthetic-id\n', 'synthetic-id\n\n', '\nsynthetic-secret\n']) test('incomplete pair never invokes a writer: ' + JSON.stringify(input), () => {
  const result = run('youtube', input)
  assert.notEqual(result.status, 0)
  assert.equal(result.call, null)
  assert.ok(!(result.stdout + result.stderr).includes('synthetic-id'))
})
test('unknown provider never invokes a writer', () => {
  const result = run('instagram', 'synthetic-id\nsynthetic-secret\n')
  assert.notEqual(result.status, 0)
  assert.equal(result.call, null)
})
test('bulk failure emits a safe summary without runner output', () => {
  const result = run('youtube', 'synthetic-id\nsynthetic-secret\n', true)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /installation failed/i)
  assert.ok(!(result.stdout + result.stderr).includes('synthetic-runner-secret'))
})
