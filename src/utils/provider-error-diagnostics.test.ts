// ABOUTME: Verifies YouTube quota reasons remain useful without arbitrary provider text.
// ABOUTME: Uses only synthetic errors and the real bounded diagnostic extractor.
import { expect, it } from 'vitest'
import { PlatformAdapterError } from '../platforms/adapter'
import { providerErrorDiagnostics } from './provider-error-diagnostics'

it.each(['quotaExceeded', 'uploadLimitExceeded'])('retains documented YouTube reason %s in diagnostics', (reason) => {
  const error = new PlatformAdapterError('youtube', 'provider_quota_exceeded', 'Safe quota message', 403, { error: { errors: [{ reason }] } })
  expect(providerErrorDiagnostics(error)).toMatchObject({ reason })
})
it('does not retain arbitrary reasons or reinterpret another provider', () => {
  for (const [platform, reason] of [['youtube', 'synthetic-private-reason'], ['instagram', 'quotaExceeded']] as const) {
    const diagnostic = providerErrorDiagnostics(new PlatformAdapterError(platform, 'unknown_platform_error', 'safe', 403, { error: { errors: [{ reason }] } }))
    expect(diagnostic).toBeNull()
  }
})
