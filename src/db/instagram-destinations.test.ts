// ABOUTME: Tests persisted Instagram defaults and immutable job selections.
// ABOUTME: Uses real D1 transactions and the production query functions.
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations, connection, job, PUBKEY_A } from './test-helpers'
import { upsertConnection } from './connections'
import { getPreferences, setPreference } from './preferences'
import { createOrGetJob, getJob, claimJobForPublish } from './jobs'

describe('Instagram destinations', () => {
  let db: D1Database
  beforeEach(async () => {
    db = await applyMigrations()
    await upsertConnection(db, connection({ platform: 'instagram' }))
  })
  it('preserves a saved destination through mode-only preference updates', async () => {
    const preference = { pubkey: PUBKEY_A, platform: 'instagram' as const, connectionId: 'conn_1', mode: 'manual' as const, automaticEnabledAt: null, createdAt: 1000, updatedAt: 1000 }
    await setPreference(db, { ...preference, instagramDestination: 'story' })
    await setPreference(db, { ...preference, mode: 'automatic', updatedAt: 2000 })
    expect(await getPreferences(db, PUBKEY_A)).toEqual([expect.objectContaining({ mode: 'automatic', instagramDestination: 'story' })])
  })
  it('snapshots the destination atomically and retains it on duplicate requests and claims', async () => {
    const first = await createOrGetJob(db, job({ platform: 'instagram', instagramDestination: 'story' }))
    expect(first.job.instagramDestination).toBe('story')
    const duplicate = await createOrGetJob(db, job({ id: 'job_duplicate', platform: 'instagram', instagramDestination: 'reel_feed' }))
    expect(duplicate).toMatchObject({ created: false, job: { id: first.job.id, instagramDestination: 'story' } })
    expect(await getJob(db, first.job.id)).toMatchObject({ instagramDestination: 'story' })
    expect(await claimJobForPublish(db, first.job.id, 2000)).toMatchObject({ instagramDestination: 'story' })
    expect(await db.prepare('SELECT * FROM instagram_job_options').all()).toMatchObject({ results: [{ job_id: first.job.id, destination: 'story' }] })
  })
  it('rolls back the job when storing its destination fails', async () => {
    await expect(createOrGetJob(db, job({ platform: 'instagram', instagramDestination: 'invalid' as 'story' }))).rejects.toThrow()
    expect(await getJob(db, 'job_1')).toBeNull()
  })
  it('keeps exactly one destination when duplicate requests race', async () => {
    const results = await Promise.all([
      createOrGetJob(db, job({ id: 'job_story', platform: 'instagram', instagramDestination: 'story' })),
      createOrGetJob(db, job({ id: 'job_reel', platform: 'instagram', instagramDestination: 'reel' })),
    ])
    expect(results.filter((result) => result.created)).toHaveLength(1)
    expect(results[0].job).toEqual(results[1].job)
    expect((await db.prepare('SELECT * FROM instagram_job_options').all()).results).toHaveLength(1)
  })
  it('keeps legacy jobs without an explicit destination', async () => {
    const result = await createOrGetJob(db, job({ platform: 'instagram' }))
    expect(result.job.instagramDestination).toBeNull()
  })
})
