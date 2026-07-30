// ABOUTME: Input validators for proof-post claims and NIP-05 names, plus the
// ABOUTME: SSRF guard that keeps upstream fetches off private/internal hosts.
export function isValidProof(proof: string): boolean {
  if (typeof proof !== 'string' || proof.length === 0 || proof.length > 500) return false
  if (/[<>"'{}|\\^`;]/.test(proof)) return false
  // Block control characters
  if (/[\x00-\x1f\x7f]/.test(proof)) return false
  return true
}

export function isValidIdentity(identity: string): boolean {
  if (typeof identity !== 'string' || identity.length === 0 || identity.length > 500) return false
  if (/[<>"'{}|\\^`;]/.test(identity)) return false
  if (/[\x00-\x1f\x7f]/.test(identity)) return false
  return true
}

/** Check if a hostname is a private/internal address that should not be fetched */
export function isPrivateHostname(hostname: string): boolean {
  // Block IP addresses (v4 and v6)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    const parts = hostname.split('.').map(Number)
    // Block all private ranges: 10.x, 172.16-31.x, 192.168.x, 127.x, 0.x, 169.254.x
    if (parts[0] === 10) return true
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
    if (parts[0] === 192 && parts[1] === 168) return true
    if (parts[0] === 127) return true
    if (parts[0] === 0) return true
    if (parts[0] === 169 && parts[1] === 254) return true
    // Block all IP addresses for safety — only allow domain names
    return true
  }
  // Block IPv6
  if (hostname.startsWith('[') || hostname.includes(':')) return true
  // Block localhost variants
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  // Block internal/common private TLDs
  if (hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.corp')) return true
  return false
}

export function validateNip05Name(name: string): { local: string; domain: string } | null {
  if (!name || typeof name !== 'string') return null
  const parts = name.split('@')
  if (parts.length !== 2) return null
  const [local, domain] = parts
  if (!local || !domain) return null
  // domain: valid hostname with at least one dot, no leading/trailing/consecutive dots or hyphens
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/.test(domain)) return null
  if (isPrivateHostname(domain)) return null
  // local part: alphanumeric, underscores, hyphens, dots, or _ for root
  if (!/^[a-zA-Z0-9._-]+$/.test(local)) return null
  return { local, domain }
}
