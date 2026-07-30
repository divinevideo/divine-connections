// ABOUTME: PlatformVerifier interface for the stateless proof-post verifiers.
// ABOUTME: Each implementation checks one platform's proof content for the claimant's npub.
import type { VerificationMethod, VerificationProvenance } from './identity-link'

export interface PlatformVerifier {
  readonly name: string
  readonly label: string
  verify(
    identity: string,
    proof: string,
    npub: string
  ): Promise<{
    verified: boolean
    error?: string
    method?: VerificationMethod
    provenance?: VerificationProvenance
  }>
}
