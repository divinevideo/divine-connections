import { describe, expect, it } from 'vitest'
import { PlatformAdapterError, normalizeProviderError } from './adapter'

describe('platform adapter errors', () => {
  it('maps auth provider statuses to needs_reauth', async () => {
    const error = await normalizeProviderError(
      'instagram',
      new Response(JSON.stringify({ error: 'denied' }), { status: 401 }),
    )

    expect(error).toBeInstanceOf(PlatformAdapterError)
    expect(error).toMatchObject({ code: 'needs_reauth', providerStatus: 401, platform: 'instagram' })
  })

  it('maps rate limit responses to rate_limited', async () => {
    await expect(
      normalizeProviderError('tiktok', new Response(JSON.stringify({ error: 'too many' }), { status: 429 })),
    ).resolves.toMatchObject({ code: 'rate_limited', providerStatus: 429, platform: 'tiktok' })
  })

  it('maps media rejection responses to media_rejected', async () => {
    await expect(
      normalizeProviderError(
        'youtube',
        new Response(JSON.stringify({ error: { code: 'media_rejected', message: 'media rejected' } }), {
          status: 400,
        }),
      ),
    ).resolves.toMatchObject({ code: 'media_rejected', providerStatus: 400, platform: 'youtube' })
  })

  it('maps unexpected non-2xx responses to unknown_platform_error', async () => {
    await expect(
      normalizeProviderError('x', new Response(JSON.stringify({ error: 'oops' }), { status: 500 })),
    ).resolves.toMatchObject({ code: 'unknown_platform_error', providerStatus: 500, platform: 'x' })
  })
})

it('recognizes Instagram invalid or expired tokens even when Meta returns HTTP 400', async () => {
  const error = await normalizeProviderError('instagram', Response.json({ error: { code: 190, error_subcode: 463, message: 'Session has expired' } }, { status: 400 }))
  expect(error.code).toBe('needs_reauth')
})

it.each(['x', 'instagram', 'tiktok', 'youtube'] as const)('classifies %s HTTP 402 independently of the provider body', async (platform) => {
  const error = await normalizeProviderError(platform, Response.json({ error: { message: 'invalid_media private-sentinel' } }, { status: 402 }))
  expect(error).toMatchObject({ code: 'provider_payment_required', providerStatus: 402, platform })
  expect(error.message).not.toContain('private-sentinel')
})
