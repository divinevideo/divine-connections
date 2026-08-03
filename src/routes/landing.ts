// ABOUTME: Verifier landing page: self-service identity verification UI served at
// ABOUTME: the verifier host root. Quick Connect runs on connections OAuth; proof-post
// and kind-10011 publish flows are unchanged from the legacy page.
import { Hono } from 'hono'
import { getProviderSummaries } from '../platforms/registry'
import { EMBED_BRIDGE_SCRIPT } from '../embed-bridge'
import type { Env } from '../types'
import { PLATFORMS, PROOF_VALUE_OVERRIDES, type PlatformCapability } from './platform-matrix'


export function renderLandingPage(env: Env, origin: string): string {
  const divineLoginUrl = `https://login.divine.video/login?return_url=${encodeURIComponent(`${origin}/#verify-here`)}`

  // Quick Connect offers only providers whose OAuth app is configured; the
  // proof-post platform list is static (YouTube needs its API key).
  const oauthEnabled = new Set(getProviderSummaries(env).filter((p) => p.enabled).map((p) => p.platform))

  // Every platform-facing string below derives from PLATFORMS so the chips, the
  // copy, the proof form and the API table always agree.
  const canProof = (p: PlatformCapability) =>
    p.proofFormat !== null && (!p.proofRequiresSecret || Boolean(env[p.proofRequiresSecret]))
  // Two items take no comma ("A and B"); three or more keep the serial comma
  // ("A, B, and C"). The unconditional version read "Twitter / X, and Instagram".
  const joinList = (names: string[], conjunction: 'and' | 'or') => {
    if (names.length < 2) return names[0] ?? ''
    if (names.length === 2) return `${names[0]} ${conjunction} ${names[1]}`
    return `${names.slice(0, -1).join(', ')}, ${conjunction} ${names[names.length - 1]}`
  }

  const platformChips = PLATFORMS.map(
    (p) => `      <a class="platform-pill" href="#verify-here">
        <svg viewBox="0 0 24 24" fill="#333" aria-hidden="true"><path d="${p.icon}"/></svg>
        ${p.label}
      </a>`,
  ).join('\n')

  const platformTableRows = PLATFORMS.map((p) => {
    const proofCell = p.proofFormat === null
      ? 'Not supported — connect the account instead'
      : p.proofRequiresSecret
        ? `${p.proofFormat} (needs <code>${p.proofRequiresSecret}</code>)`
        : p.proofFormat
    const connectCell = p.connect ? 'Yes' : (p.connectDeferred ?? 'No')
    return `        <tr><td><code>${p.key}</code></td><td>${p.identity}</td><td>${proofCell}</td><td>${connectCell}</td></tr>`
  }).join('\n')

  const connectPlatforms = PLATFORMS.filter((p) => p.connect)
  const extraLookupPlatforms = ",'youtube','tiktok'"
  const choosePlatforms = `Choose ${joinList(PLATFORMS.map((p) => p.label), 'or')}.`
  const noPostingPlatforms = `No posting required for ${joinList(connectPlatforms.map((p) => p.label), 'and')}.`
  const oauthPlatformOptions = connectPlatforms
    .filter((p) => oauthEnabled.has(p.key as 'x' | 'instagram' | 'tiktok' | 'youtube'))
    .map((p) => `<option value="${p.key}">${p.label}</option>`)
    .join('')
  // GitHub stays the default selection; the rest follow the matrix order.
  const proofCapable = PLATFORMS.filter(canProof)
  const proofOrdered = [
    ...proofCapable.filter((p) => p.key === 'github'),
    ...proofCapable.filter((p) => p.key !== 'github'),
  ]
  const proofPlatformOptions = proofOrdered
    .map((p) => `<option value="${PROOF_VALUE_OVERRIDES[p.key] ?? p.key}">${p.label}</option>`)
    .join('')
  // Every platform in one list, each carrying how *it* can be verified on this
  // deployment. The old page split them across "Quick Connect" and an
  // "Advanced" disclosure, which asked the reader to understand our
  // implementation before they could find their own account.
  type VerifyMethod = 'oauth' | 'proof' | 'unavailable'
  const methodFor = (p: PlatformCapability): VerifyMethod => {
    if (p.connect && oauthEnabled.has(p.key as 'x' | 'instagram' | 'tiktok' | 'youtube')) return 'oauth'
    if (canProof(p)) return 'proof'
    return 'unavailable'
  }
  const unavailableReason = (p: PlatformCapability): string => {
    if (p.proofRequiresSecret && !env[p.proofRequiresSecret]) {
      return `${p.label} verification is not switched on for this site yet.`
    }
    if (p.connect) {
      return `${p.label} needs an account connection, which is not switched on for this site yet.`
    }
    return `${p.label} cannot be verified here yet.`
  }
  const connectNames = PLATFORMS.filter((p) => methodFor(p) === 'oauth').map((p) => p.label)
  const proofNames = PLATFORMS.filter((p) => methodFor(p) === 'proof').map((p) => p.label)
  const offNames = PLATFORMS.filter((p) => methodFor(p) === 'unavailable').map((p) => p.label)
  // Written from the matrix rather than hardcoded, because the previous copy
  // promised "for X, Instagram, TikTok and YouTube just sign in" on a
  // deployment where three of those four had no credentials installed.
  const howToVerifySummary = connectNames.length
    ? `For ${joinList(connectNames, 'and')} you just sign in to the account &mdash; nothing gets posted. Everything else asks you to post something containing your npub and paste the link back.`
    : 'Post something containing your npub on that platform, then paste the link back here.'
  const howToVerifyNote = [
    connectNames.length ? `<strong>No posting needed for ${joinList(connectNames, 'and')}.</strong>` : '',
    proofNames.length ? `${joinList(proofNames, 'and')} ${proofNames.length === 1 ? 'asks' : 'ask'} for a post or link.` : '',
    offNames.length ? `${joinList(offNames, 'and')} ${offNames.length === 1 ? 'is' : 'are'} not switched on for this site yet.` : '',
  ].filter(Boolean).join(' ')

  // Ordered so the reader meets what they can actually do first.
  const verifyOrdered = [
    ...PLATFORMS.filter((p) => methodFor(p) === 'oauth'),
    ...PLATFORMS.filter((p) => methodFor(p) === 'proof'),
    ...PLATFORMS.filter((p) => methodFor(p) === 'unavailable'),
  ]
  const firstAvailable = verifyOrdered.findIndex((p) => methodFor(p) !== 'unavailable')
  const verifyPlatformChoices = verifyOrdered
    .map((p, index) => {
      const method = methodFor(p)
      const value = PROOF_VALUE_OVERRIDES[p.key] ?? p.key
      const selected = index === firstAvailable
      // A platform with both paths still offers the proof form, via a link in
      // the connect panel, so nothing that used to be possible is lost.
      return `            <button type="button" class="platform-choice${method === 'unavailable' ? ' platform-choice-off' : ''}" role="radio" data-verify-platform="${value}" data-method="${method}" data-can-proof="${canProof(p) ? 'yes' : 'no'}" data-label="${p.label}" data-reason="${unavailableReason(p)}" aria-checked="${selected ? 'true' : 'false'}" tabindex="${selected ? '0' : '-1'}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${p.icon}"/></svg>
              <span>${p.label}</span>
            </button>`
    })
    .join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Divine Identity Verification — Prove You Are Who You Say You Are</title>
  <meta name="description" content="Verify your identity across platforms. Link your Twitter, GitHub, Bluesky, Mastodon, and more to your Nostr profile to prevent impersonation and build trust.">
  <meta property="og:title" content="Divine Identity Verification">
  <meta property="og:description" content="Prove you are who you say you are. Link your social accounts to your Nostr identity to prevent impersonation.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${origin}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=Inter:wght@400;500;600;700&display=swap">
  <style>
    :root {
      --green: #27C58B;
      --dark: #07241B;
      --mint: #D0FBCB;
      --off: #F9F7F6;
      --yellow: #FFF140;
      --pink: #FF7FAF;
      --orange: #FF7640;
      --violet: #A3A9FF;
      color-scheme: dark;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      background: var(--dark); color: var(--off);
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      font-size: 17px; line-height: 1.55;
      -webkit-font-smoothing: antialiased;
    }
    h1, h2, h3, h4 {
      font-family: 'Bricolage Grotesque', 'Inter', sans-serif;
      font-weight: 800; letter-spacing: -0.02em; line-height: 1.05;
    }
    .container { max-width: 960px; margin: 0 auto; padding: 0 clamp(20px, 4vw, 32px); }

    /* Top brand bar */
    .topbar {
      display: flex; justify-content: space-between; align-items: center;
      padding: 24px 0; gap: 16px; flex-wrap: wrap;
    }
    .brand {
      display: inline-flex; align-items: center; gap: 12px;
      color: var(--off);
      font-family: 'Bricolage Grotesque', sans-serif; font-weight: 800; font-size: 1.3rem;
      text-decoration: none;
    }
    .logomark {
      width: 26px; height: 26px; border-radius: 50%;
      background: var(--green); border: 2px solid var(--off);
      position: relative; display: inline-block;
    }
    .logomark::after {
      content: ""; position: absolute; inset: 5px;
      background: var(--dark); border-radius: 50%;
    }
    .nav-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: flex-end; }
    .nav-link {
      font-size: 0.92rem; color: var(--mint);
      border-bottom: 1.5px solid rgba(208, 251, 203, 0.4); padding-bottom: 1px;
      text-decoration: none;
    }
    .nav-link:hover { color: var(--green); border-bottom-color: var(--green); }

    /* Hero */
    .hero { padding: 32px 0 24px; text-align: left; }
    .hero h1 {
      font-size: clamp(2.2rem, 6vw, 3.8rem);
      color: var(--off); max-width: 18ch; margin-bottom: 18px;
    }
    .hero h1 .punct { color: var(--green); }
    .hero .subtitle {
      max-width: 60ch; color: var(--mint);
      font-size: 1.05rem; line-height: 1.5; margin-bottom: 1.5rem;
    }
    .hero .subtitle a { color: var(--off); border-bottom: 1.5px solid rgba(249, 247, 246, 0.35); padding-bottom: 1px; text-decoration: none; }
    .hero .subtitle a:hover { color: var(--green); border-bottom-color: var(--green); }
    .hero .cta-row { display: flex; gap: 12px; justify-content: flex-start; flex-wrap: wrap; margin-top: 4px; }

    /* Buttons */
    .btn {
      display: inline-flex; align-items: center; justify-content: center;
      min-height: 44px; padding: 10px 18px; border-radius: 999px;
      font-family: 'Bricolage Grotesque', sans-serif;
      font-size: 0.96rem; font-weight: 800; line-height: 1;
      text-decoration: none; cursor: pointer;
      border: 2px solid transparent;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .btn-primary { background: var(--green); color: var(--dark); border-color: var(--green); }
    .btn-primary:hover { transform: translate(-2px, -2px); box-shadow: 4px 4px 0 var(--off); text-decoration: none; }
    .btn-outline { background: transparent; color: var(--mint); border-color: rgba(208, 251, 203, 0.4); }
    .btn-outline:hover { color: var(--off); border-color: var(--mint); transform: translate(-2px, -2px); box-shadow: 4px 4px 0 var(--green); text-decoration: none; }

    /* Value props */
    .value-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 14px; margin: 2rem 0;
    }
    .value-card {
      background: var(--off); color: var(--dark);
      border: 2px solid var(--dark); border-radius: 22px; padding: 22px;
      box-shadow: 6px 6px 0 var(--green);
    }
    .value-card .icon { font-size: 2rem; margin-bottom: 0.75rem; }
    .value-card h3 { font-size: 1.15rem; color: var(--dark); margin-bottom: 0.5rem; }
    .value-card p { font-size: 0.95rem; color: rgba(7, 36, 27, 0.78); margin: 0; line-height: 1.5; }

    /* How it works */
    .steps {
      display: grid; grid-template-columns: repeat(4, 1fr);
      gap: 16px; margin: 1.25rem 0;
    }
    @media (max-width: 820px) {
      .steps { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 460px) {
      .steps { grid-template-columns: 1fr; }
    }
    .step {
      padding: 16px;
      border: 2px solid rgba(7, 36, 27, 0.12);
      border-radius: 16px;
      background: rgba(208, 251, 203, 0.35);
    }
    .step-number {
      display: inline-flex; align-items: center; justify-content: center;
      width: 36px; height: 36px; border-radius: 50%;
      background: var(--dark); color: var(--mint);
      font-family: 'Bricolage Grotesque', sans-serif; font-weight: 800; font-size: 1.05rem;
      margin-bottom: 0.75rem;
    }
    .step h4 { color: var(--dark); margin-bottom: 6px; font-size: 1rem; }
    .step p { color: rgba(7, 36, 27, 0.78); font-size: 0.9rem; margin: 0; line-height: 1.45; }
    .step a { color: var(--dark); border-bottom: 1.5px solid rgba(7, 36, 27, 0.4); padding-bottom: 1px; text-decoration: none; font-weight: 600; }
    .step a:hover { border-bottom-color: var(--green); }

    /* Platform pills */
    .platform-grid {
      display: flex; flex-wrap: wrap; gap: 10px; justify-content: center;
      margin: 1.5rem auto;
      max-width: 640px;
    }
    .platform-pill {
      display: inline-flex; align-items: center; gap: 0.5rem;
      background: var(--off); color: var(--dark);
      border: 2px solid var(--dark); border-radius: 999px;
      padding: 8px 14px; font-size: 0.92rem; font-weight: 600;
      box-shadow: 3px 3px 0 var(--green);
    }
    .platform-pill svg { width: 18px; height: 18px; flex-shrink: 0; fill: var(--dark); }

    /* Platform picker: the real control for proof verification. */
    .platform-picker {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
      gap: 10px; margin: 0.35rem 0 1rem;
    }
    .platform-choice {
      display: flex; align-items: center; gap: 0.5rem;
      background: var(--off); color: var(--dark);
      border: 2px solid var(--dark); border-radius: 14px;
      padding: 10px 12px; font-size: 0.92rem; font-weight: 600;
      font-family: inherit; text-align: left; cursor: pointer;
      box-shadow: 3px 3px 0 rgba(7,36,27,0.18);
    }
    .platform-choice svg { width: 20px; height: 20px; flex-shrink: 0; fill: var(--dark); }
    .platform-choice span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .platform-choice:hover { transform: translate(-1px, -1px); box-shadow: 4px 4px 0 rgba(7,36,27,0.22); }
    .platform-choice[aria-checked="true"] {
      background: var(--green); box-shadow: 3px 3px 0 var(--dark);
    }
    /* Selection must survive without colour: the border weight and the check
       carry it for anyone who cannot distinguish the fill. */
    .platform-choice[aria-checked="true"]::after { content: '✓'; margin-left: auto; font-weight: 800; }
    .platform-choice:focus-visible { outline: 3px solid var(--violet); outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) {
      .platform-choice:hover { transform: none; }
    }

    /* Sections (cards) */
    section {
      background: var(--off); color: var(--dark);
      border: 2px solid var(--dark); border-radius: 22px;
      padding: 24px; margin-bottom: 18px;
      box-shadow: 6px 6px 0 var(--green);
    }
    section h2 {
      font-size: 1.45rem; color: var(--dark);
      margin-bottom: 0.85rem; padding-bottom: 0.5rem;
      border-bottom: 2px solid rgba(7, 36, 27, 0.12);
    }
    section h3 { font-size: 1.05rem; color: var(--dark); margin: 1.25rem 0 0.5rem; }
    section h4 { font-size: 0.95rem; color: rgba(7, 36, 27, 0.78); margin: 0.75rem 0 0.25rem; }
    section p { margin-bottom: 0.55rem; color: rgba(7, 36, 27, 0.78); font-size: 0.95rem; line-height: 1.5; }
    section ul { margin: 0.4rem 0 0.6rem 1.25rem; color: rgba(7, 36, 27, 0.78); font-size: 0.95rem; }
    section li { margin-bottom: 0.25rem; }
    section a { color: var(--dark); border-bottom: 1.5px solid rgba(7, 36, 27, 0.4); padding-bottom: 1px; text-decoration: none; font-weight: 600; }
    section a:hover { border-bottom-color: var(--green); color: var(--dark); }
    section strong { color: var(--dark); }

    code {
      background: rgba(7, 36, 27, 0.08); color: var(--dark);
      padding: 1px 6px; border-radius: 6px;
      font-size: 0.88em; font-family: 'SF Mono', Menlo, Consolas, monospace;
    }
    pre {
      background: var(--dark); color: var(--mint);
      padding: 1rem; border-radius: 14px;
      overflow-x: auto; font-size: 0.82rem; margin: 0.5rem 0 0.75rem;
      font-family: 'SF Mono', Menlo, Consolas, monospace; line-height: 1.5;
      border: 2px solid var(--dark);
    }
    pre .comment { color: rgba(208, 251, 203, 0.55); }

    .endpoint { margin-bottom: 1.5rem; padding-bottom: 1.5rem; border-bottom: 1px solid rgba(7, 36, 27, 0.1); }
    .endpoint:last-child { border-bottom: none; padding-bottom: 0; margin-bottom: 0; }
    .method {
      display: inline-block; padding: 2px 8px; border-radius: 6px;
      font-family: 'Bricolage Grotesque', sans-serif;
      font-size: 0.72rem; font-weight: 800; margin-right: 0.5rem; color: var(--dark);
      letter-spacing: 0.02em;
    }
    .get { background: var(--green); }
    .post { background: var(--mint); }
    .head { background: var(--violet); }

    /* Wide API/result tables scroll inside their own card; the page body must
       never scroll sideways, which shifted the whole layout on phones. */
    section { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; margin: 0.5rem 0; }
    th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid rgba(7, 36, 27, 0.12); font-size: 0.9rem; }
    th { color: rgba(7, 36, 27, 0.6); font-weight: 700; font-family: 'Bricolage Grotesque', sans-serif; }
    td code { font-size: 0.82rem; }

    .note {
      background: var(--mint); color: var(--dark);
      border-left: 4px solid var(--green); padding: 0.7rem 0.9rem;
      border-radius: 0 12px 12px 0; margin: 0.75rem 0; font-size: 0.92rem;
    }
    .note strong { color: var(--dark); }

    /* Divider */
    .section-divider {
      text-align: center; padding: 2.25rem 0 1rem;
      color: var(--mint); font-size: 0.82rem;
      font-family: 'Bricolage Grotesque', sans-serif; font-weight: 700;
      letter-spacing: 0.08em; text-transform: uppercase;
    }
    .section-divider span {
      background: var(--dark); padding: 0 1rem; position: relative;
    }
    .section-divider::before {
      content: ''; display: block; height: 1px;
      background: rgba(208, 251, 203, 0.2);
      position: relative; top: 0.7rem;
    }

    /* Verify flow */
    .verify-here {
      box-shadow: 6px 6px 0 var(--yellow);
      background: var(--off);
    }
    .verify-lead { font-size: 1rem; color: var(--dark); margin-bottom: 1rem; }
    .verify-step-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 14px;
    }
    .verify-card {
      background: var(--mint); color: var(--dark);
      border: 2px solid var(--dark); border-radius: 16px;
      padding: 16px;
    }
    .step-pill {
      display: inline-block;
      background: var(--dark); color: var(--mint);
      border-radius: 999px; padding: 4px 10px;
      font-family: 'Bricolage Grotesque', sans-serif;
      font-size: 0.7rem; font-weight: 800;
      letter-spacing: 0.04em; text-transform: uppercase;
      margin-bottom: 0.7rem;
    }
    .field-label {
      display: block; font-size: 0.82rem; color: var(--dark);
      margin-bottom: 0.3rem; font-weight: 700;
    }
    .field-input, .field-select {
      width: 100%; padding: 10px 12px;
      border: 2px solid var(--dark); border-radius: 12px;
      font-size: 0.95rem; font-family: 'Inter', sans-serif;
      margin-bottom: 0.6rem;
      background: var(--off); color: var(--dark);
      outline: none; transition: box-shadow 0.15s ease;
    }
    .field-input:focus, .field-select:focus {
      box-shadow: 3px 3px 0 var(--green);
    }
    .field-help {
      color: rgba(7, 36, 27, 0.65); font-size: 0.82rem;
      margin-top: -0.1rem; margin-bottom: 0.55rem;
    }
    .status-row {
      display: none; padding: 10px 14px;
      border-radius: 12px; margin-top: 0.75rem;
      font-size: 0.9rem; line-height: 1.4;
      border: 1px solid transparent;
    }
    .verify-btn {
      padding: 10px 16px; border-radius: 12px;
      border: 2px solid var(--dark);
      background: var(--dark); color: var(--mint);
      font-family: 'Bricolage Grotesque', sans-serif;
      font-size: 0.95rem; font-weight: 700;
      cursor: pointer;
      transition: transform 0.15s ease, box-shadow 0.15s ease, opacity 0.2s;
    }
    .verify-btn:hover:not(:disabled) { transform: translate(-2px, -2px); box-shadow: 4px 4px 0 var(--green); }
    .verify-btn:disabled { cursor: not-allowed; opacity: 0.55; }
    .verify-btn-primary { background: var(--green); color: var(--dark); }
    .verify-btn-primary:hover:not(:disabled) { box-shadow: 4px 4px 0 var(--dark); }
    .verify-btn-success { background: var(--yellow); color: var(--dark); }
    .verify-btn-success:hover:not(:disabled) { box-shadow: 4px 4px 0 var(--dark); }
    .advanced-proof {
      margin-top: 1rem;
      border: 2px dashed rgba(7, 36, 27, 0.25);
      border-radius: 16px; padding: 14px 16px;
      background: rgba(7, 36, 27, 0.04);
    }
    .advanced-proof summary {
      cursor: pointer; font-weight: 800; color: var(--dark);
      font-family: 'Bricolage Grotesque', sans-serif;
      outline: none;
    }
    .advanced-proof-inner { margin-top: 0.85rem; }

    /* Lookup section */
    .lookup-input {
      flex: 1; min-width: 200px;
      padding: 10px 14px;
      border: 2px solid var(--dark); border-radius: 12px;
      font-size: 0.95rem; font-family: 'Inter', sans-serif;
      background: var(--off); color: var(--dark);
      outline: none; transition: box-shadow 0.15s ease;
    }
    .lookup-input:focus { box-shadow: 3px 3px 0 var(--green); }
    .lookup-btn {
      padding: 10px 22px;
      background: var(--dark); color: var(--mint);
      border: 2px solid var(--dark); border-radius: 12px;
      font-family: 'Bricolage Grotesque', sans-serif;
      font-size: 0.95rem; font-weight: 800;
      cursor: pointer;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .lookup-btn:hover { transform: translate(-2px, -2px); box-shadow: 4px 4px 0 var(--green); }
    .lookup-status {
      display: none; padding: 10px 14px;
      border-radius: 12px; margin-bottom: 0.85rem;
      font-size: 0.9rem; border: 1px solid transparent;
    }

    /* Footer */
    footer {
      text-align: center; padding: 56px 0 40px;
      color: var(--mint); font-size: 0.92rem;
      border-top: 1px solid rgba(208, 251, 203, 0.14);
      margin-top: 32px;
    }
    footer a { color: var(--off); border-bottom: 1.5px solid rgba(249, 247, 246, 0.35); padding-bottom: 1px; text-decoration: none; }
    footer a:hover { color: var(--green); border-bottom-color: var(--green); }

    @media (max-width: 640px) {
      .container { padding: 0 18px; }
      .hero { padding: 18px 0 16px; }
      .nav-actions { width: 100%; justify-content: flex-start; }
      section { padding: 18px; }
    }
  </style>
</head>
<body>
  <div class="container">

    <!-- TOP BAR -->
    <nav class="topbar">
      <a class="brand" href="/"><span class="logomark" aria-hidden="true"></span><span>Divine Identity</span></a>
      <div class="nav-actions">
        <a class="nav-link" href="#check">Look up</a>
        <a class="nav-link" href="#how-to-verify">Get verified</a>
        <a class="nav-link" href="https://divine.video">divine.video</a>
      </div>
    </nav>

    <!-- HERO -->
    <div class="hero">
      <h1>Prove it's really you<span class="punct">.</span></h1>
      <p class="subtitle">Link your social accounts to your <a href="https://divine.video">Divine</a> profile so people know it's actually you. Like a verified badge &mdash; but one you own, and anyone can check.</p>
      <div class="cta-row">
        <a href="#how-to-verify" class="btn btn-primary">Get verified</a>
        <a href="#manage" class="btn btn-outline">Manage my links</a>
        <a href="#check" class="btn btn-outline">Look up someone</a>
      </div>
    </div>

    <!-- WHY VERIFY -->
    <div class="value-grid">
      <div class="value-card">
        <div class="icon">&#128274;</div>
        <h3>Stop Impersonation</h3>
        <p>Anyone can copy your name and photo on a new platform. When you verify, you create a link between your accounts that nobody else can fake &mdash; because only you can post from your real accounts.</p>
      </div>
      <div class="value-card">
        <div class="icon">&#9989;</div>
        <h3>Build Trust</h3>
        <p>When someone finds your Divine profile, they can see that your Twitter, GitHub, Bluesky, and other accounts are all confirmed to be you. No guessing, no doubt.</p>
      </div>
      <div class="value-card">
        <div class="icon">&#127760;</div>
        <h3>You're in Control</h3>
        <p>Unlike platform-specific blue checkmarks, these verifications don't depend on any company. They're open, transparent, and portable &mdash; they go wherever you go.</p>
      </div>
    </div>

    <!-- SUPPORTED PLATFORMS -->
    <div style="text-align:center;margin:2.25rem 0 1rem;">
      <h3 style="font-family:'Bricolage Grotesque',sans-serif;font-weight:700;font-size:0.85rem;letter-spacing:0.08em;text-transform:uppercase;color:var(--mint);">Works with the platforms you already use</h3>
    </div>
    <div class="platform-grid">
${platformChips}
    </div>

    <!-- HOW IT WORKS -->
    <section id="how-it-works">
      <h2>How Does It Work?</h2>
      <p>Think of it like a handshake between two accounts:</p>
      <ul>
        <li><strong>Your Divine profile says</strong> "I'm @alice on Twitter"</li>
        <li><strong>Your Twitter account confirms</strong> "Yes, that Divine profile is mine"</li>
      </ul>
      <p>We check both sides automatically. If they match, you're verified. The beauty of this system is that <strong>nobody can fake it</strong> &mdash; an impersonator might copy your name and photo, but they can't post from your real Twitter account.</p>
      <p>This is the same approach used by <a href="https://keybase.io">Keybase</a> &mdash; a proven method for cross-platform identity verification, now available for Divine and the broader Nostr ecosystem.</p>
    </section>

    <!-- HOW TO VERIFY -->
    <section id="how-to-verify">
      <h2>How to Get Verified</h2>
      <p>Most people finish in under a minute. You are just confirming that your Divine account and your account somewhere else belong to the same person.</p>

      <div class="steps">
        <div class="step">
          <div class="step-number">1</div>
          <h4>Sign in first</h4>
          <p>Scroll to <a href="#verify-here">Verify Here</a> and connect your Nostr signer so this app can publish your verified links.</p>
        </div>
        <div class="step">
          <div class="step-number">2</div>
          <h4>Pick a platform</h4>
          <p>${choosePlatforms}</p>
        </div>
        <div class="step">
          <div class="step-number">3</div>
          <h4>Do the one thing it asks</h4>
          <p>${howToVerifySummary}</p>
        </div>
        <div class="step">
          <div class="step-number">4</div>
          <h4>Done &mdash; you're verified</h4>
          <p>A checkmark shows up on your profile. Anyone can click it to confirm the link is real. We publish it for you.</p>
        </div>
      </div>

      <div class="note">
        ${howToVerifyNote}
      </div>
    </section>

    <section id="verify-here" class="verify-here">
      <h2>Verify Here</h2>
      <p class="verify-lead">Yes, login is required. Connect your Nostr signer first so verified links can be published to your profile.</p>

      <div class="verify-step-grid">
        <div class="verify-card">
          <span class="step-pill">Step 1</span>
          <h3 style="margin-top:0;" id="signin-heading">Sign in to your Divine account</h3>
          <div id="signed-in-panel" style="display:none;">
            <p style="margin-bottom:0.35rem;">You're signed in and ready to verify an account below.</p>
            <p id="signed-in-identity" class="field-help" style="margin-bottom:0.75rem;"></p>
            <button id="sign-out-btn" class="verify-btn" type="button">Sign in as someone else</button>
          </div>
          <div id="signin-controls">
          <p>Signing in lets us publish the final verification tag into your Nostr identity event (NIP-39). Most people should use their Divine account; the other options are for people who already run their own signer.</p>
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.6rem;align-items:center;">
            <button id="connect-keycast-btn" class="verify-btn verify-btn-primary" type="button">Sign in with Divine</button>
            <button id="connect-nostr-btn" class="verify-btn" type="button">Use browser signer (NIP-07)</button>
          </div>
          <p class="field-help" style="margin-bottom:0.6rem;">Sign-in not opening? <a href="${divineLoginUrl}" target="_blank" rel="noopener noreferrer">Open login.divine.video in a new tab</a>.</p>
          <label for="verify-pubkey-input" class="field-label">Account (auto-filled after login; manual paste fallback)</label>
          <input id="verify-pubkey-input" class="field-input" type="text" placeholder="alice@divine.video or npub1...">
          <p id="signer-session-summary" class="field-help" style="display:none;"></p>
          <p class="field-help">If a signer session is not available, you can still paste your Divine address, npub, profile URL, or 64-char key.</p>
          <details class="advanced-proof" id="remote-signer-details" style="margin-top:0.75rem;">
            <summary>Remote signer options: bunker and Nostr Connect</summary>
            <div class="advanced-proof-inner">
              <p style="margin-bottom:0.75rem;">Paste a bunker URL or bunker NIP-05, or generate a Nostr Connect URI for your signer app.</p>
              <label for="bunker-input" class="field-label">Bunker URL or bunker NIP-05</label>
              <input id="bunker-input" class="field-input" type="text" placeholder="bunker://... or signer@example.com">
              <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.75rem;">
                <button id="connect-bunker-btn" class="verify-btn" type="button">Connect bunker</button>
                <button id="start-nostr-connect-btn" class="verify-btn" type="button">Start Nostr Connect</button>
              </div>
              <div id="nostr-connect-wrap" style="display:none;margin-top:0.85rem;">
                <label for="nostr-connect-uri-input" class="field-label">Nostr Connect URI</label>
                <textarea id="nostr-connect-uri-input" class="field-input" rows="3" readonly style="min-height:6.5rem;resize:vertical;"></textarea>
                <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.75rem;">
                  <button id="copy-nostr-connect-btn" class="verify-btn" type="button">Copy URI</button>
                  <a id="open-nostr-connect-link" class="verify-btn" href="#" rel="noopener noreferrer">Open signer app</a>
                  <button id="cancel-nostr-connect-btn" class="verify-btn" type="button">Cancel</button>
                </div>
                <p class="field-help" style="margin-top:0.5rem;">Open this URI in your signer app, or copy it into a bunker / Nostr Connect client.</p>
              </div>
            </div>
          </details>
          </div>
          <div id="verify-login-status" class="status-row"></div>
          <div id="verify-global-status" class="status-row"></div>
        </div>

      </div>

      <div class="verify-card" style="margin-top:14px;">
        <span class="step-pill">Step 2</span>
        <h3 style="margin-top:0;" id="verify-platform-label">Choose the account you want to verify</h3>
        <p>Pick a platform and we'll show you the one way to verify it. You can repeat this for as many accounts as you like.</p>
        <div class="platform-picker" role="radiogroup" aria-labelledby="verify-platform-label">
${verifyPlatformChoices}
        </div>

        ${oauthPlatformOptions ? `<select id="oauth-platform-select" hidden aria-hidden="true" tabindex="-1">${oauthPlatformOptions}</select>` : ''}
        <select id="proof-platform-select" class="field-select" hidden aria-hidden="true" tabindex="-1">
          ${proofPlatformOptions}
        </select>

        <div id="method-unavailable" style="display:none;">
          <p id="method-unavailable-reason" class="field-help"></p>
          <p class="field-help">Pick another platform above, or check back later.</p>
        </div>

        ${oauthPlatformOptions ? `<div id="method-oauth" style="display:none;">
          <p>Sign in to <strong id="oauth-platform-name">the platform</strong> and you'll come straight back here. Nothing is posted, and we never see your password.</p>
          <button id="oauth-start-btn" class="verify-btn verify-btn-primary" type="button">Continue to secure sign-in</button>
          <p class="field-help" id="oauth-proof-alternative" style="display:none;margin-top:0.6rem;">Would rather not connect the account? <button type="button" class="link-button" id="use-proof-instead-btn">Verify by post or link instead</button></p>
          <div id="oauth-status" class="status-row"></div>
        </div>` : '<div id="method-oauth" style="display:none;"><div id="oauth-status" class="status-row"></div></div>'}

        <div id="method-proof" style="display:none;">
          <p style="margin-bottom:0.75rem;">Post something containing your npub on <strong id="proof-platform-name">the platform</strong>, then paste the link here. A full URL is fine, we'll pull the ID out of it.</p>
          <label for="proof-identity-input" class="field-label">Your account name on that platform</label>
          <input id="proof-identity-input" class="field-input" type="text" placeholder="e.g. octocat or alice.bsky.social">
          <label id="proof-label" for="proof-proof-input" class="field-label">Post link or proof ID</label>
          <input id="proof-proof-input" class="field-input" type="text" placeholder="Paste full post URL or just the ID">
          <p id="proof-helper" class="field-help">Tip: for Twitter and Bluesky, paste the full post URL.</p>
          <button id="proof-verify-btn" class="verify-btn verify-btn-success" type="button">Verify this link</button>
          <div id="proof-status" class="status-row"></div>
        </div>

        <!-- Publishing is the step that makes a verification visible on the
             profile, and it used to be a separate button people never found:
             verification succeeded, nothing changed, and it read as broken.
             It now runs automatically on success, and this stays only as a
             manual retry for when the signer was unavailable at that moment. -->
        <div id="publish-row" style="display:none;margin-top:0.75rem;">
          <div id="publish-status" class="status-row"></div>
          <button id="publish-kind0-btn" class="verify-btn" type="button">Publish to my profile again</button>
          <p class="field-help">This writes your identity tag into your signed Nostr profile event (NIP-39), which is what makes the checkmark visible to other people.</p>
        </div>
        <pre id="proof-result" style="display:none;margin-top:0.75rem;"></pre>
      </div>
    </section>

    <!-- MANAGE LINKED VERIFICATIONS -->
    <section id="manage" style="box-shadow: 6px 6px 0 var(--violet);">
      <h2>Manage verified links</h2>
      <p>View and remove your linked identity verifications. Paste your account or sign in to load.</p>
      <button id="load-links-btn" class="verify-btn verify-btn-primary" type="button" onclick="loadLinkedVerifications()">Load my links</button>
      <div id="manage-links-container" style="margin-top:1rem;"></div>
      <div id="manage-status" class="status-row"></div>
      <div id="remove-confirm-dialog" style="display:none;margin-top:1rem;padding:16px;background:rgba(255,127,175,0.18);border:2px solid var(--dark);border-radius:16px;">
        <h4 style="margin-bottom:0.5rem;color:var(--dark);">Remove this verification?</h4>
        <p>This unlinks <strong id="remove-confirm-claim"></strong> from your Nostr profile.</p>
        <p class="field-help">Relay updates may take a short moment.</p>
        <div style="display:flex;gap:10px;margin-top:0.75rem;flex-wrap:wrap;">
          <button class="verify-btn" type="button" onclick="cancelRemove()">Cancel</button>
          <button class="verify-btn" type="button" style="background:var(--pink);color:var(--dark);" onclick="executeRemoveVerification()">Remove verification</button>
        </div>
      </div>
    </section>

    <!-- CHECK TOOL -->
    <section id="check" style="box-shadow: 6px 6px 0 var(--pink);">
      <h2>Look up someone</h2>
      <p>Want to know if a profile is real? Enter their Divine address (like <code>alice@divine.video</code>) or their public key to see which accounts they've verified.</p>

      <div style="display:flex;gap:10px;margin-bottom:1rem;flex-wrap:wrap;">
        <input id="lookup-input" type="text" class="lookup-input" placeholder="alice@divine.video or npub1...">
        <button id="lookup-btn" class="lookup-btn" onclick="doLookup()">Check</button>
      </div>
      <div id="lookup-status" class="lookup-status"></div>
      <div id="lookup-results"></div>
    </section>

    <!-- DIVIDER -->
    <div class="section-divider"><span>API Documentation</span></div>

    <!-- API DOCS (for developers) -->
    <section id="api">
      <h2>Building on this?</h2>
      <p>The verification API is documented separately, with request and response examples for every endpoint, the full platform matrix, and the rate limits.</p>
      <p style="margin-top:0.75rem;"><a class="verify-btn verify-btn-primary" href="/docs">Read the API reference</a></p>
    </section>

    <script>
    // Install a postMessage-based window.nostr (NIP-07) shim when this page
    // is loaded inside an iframe of a trusted Divine origin. The host
    // (divine.video) honors signEvent / getPublicKey / getRelays requests
    // using whichever signer the user has attached to their Divine session,
    // so the embedded verifyer flow does not require its own login.
    ${EMBED_BRIDGE_SCRIPT}

    const API = '${origin}';
    const DIVINE_LOGIN_URL = '${divineLoginUrl}';
    const KEYCAST_BASE = 'https://login.divine.video';
    const KEYCAST_CLIENT_ID = 'Divine Identity Verification';
    const KEYCAST_SCOPE = 'policy:social';
    const KEYCAST_SESSION_KEY = 'verifyer_keycast_session_v1';
    const KEYCAST_PKCE_KEY = 'verifyer_keycast_pkce_v1';
    const KEYCAST_STATE_KEY = 'verifyer_keycast_state_v1';
    const KEYCAST_HASH_KEY = 'verifyer_keycast_hash_v1';
    const NOSTR_TOOLS_NIP46_URL = 'https://esm.sh/nostr-tools@2.23.3/nip46?bundle';
    const NOSTR_TOOLS_PURE_URL = 'https://esm.sh/nostr-tools@2.23.3/pure?bundle';
    const PROFILE_RELAYS = ['wss://relay.divine.video', 'wss://relay.damus.io', 'wss://relay.nostr.band'];
    // NIP-46 traffic needs relays that accept kind 24133 events.
    const REMOTE_SIGNER_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social', 'wss://relay.primal.net'];
    let signerPubkeyHex = null;
    let activeSigner = null;
    let activeSignerSource = null;
    let nostrToolsPromise = null;
    let nostrConnectAbortController = null;

    function npubToHex(npub) {
      const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
      const data = npub.slice(5); // strip "npub1"
      const values = [];
      for (const c of data) {
        const v = CHARSET.indexOf(c);
        if (v === -1) throw new Error('Invalid npub character');
        values.push(v);
      }
      // bech32 decode: strip checksum (last 6), convert 5-bit to 8-bit
      const words = values.slice(0, values.length - 6);
      let bits = 0, value = 0;
      const result = [];
      for (const w of words) {
        value = (value << 5) | w;
        bits += 5;
        while (bits >= 8) {
          bits -= 8;
          result.push((value >> bits) & 0xff);
        }
      }
      return result.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

    function bech32Checksum(hrp, data) {
      const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
      const polymod = (values) => {
        let chk = 1;
        for (const v of values) {
          const top = chk >> 25;
          chk = ((chk & 0x1ffffff) << 5) ^ v;
          for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
        }
        return chk;
      };
      const expanded = [];
      for (const c of hrp) expanded.push(c.charCodeAt(0) >> 5);
      expanded.push(0);
      for (const c of hrp) expanded.push(c.charCodeAt(0) & 31);
      const mod = polymod(expanded.concat(data).concat([0, 0, 0, 0, 0, 0])) ^ 1;
      const out = [];
      for (let i = 0; i < 6; i++) out.push((mod >> (5 * (5 - i))) & 31);
      return out;
    }

    // Raw hex is not an identity anybody recognises. npub is at least the form
    // people paste and compare, so it is the fallback when a profile has no name.
    function hexToNpub(hex) {
      if (!/^[0-9a-f]{64}$/i.test(hex || '')) return '';
      const bytes = [];
      for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
      const words = [];
      let acc = 0, bits = 0;
      for (const b of bytes) {
        acc = (acc << 8) | b;
        bits += 8;
        while (bits >= 5) { bits -= 5; words.push((acc >> bits) & 31); }
      }
      if (bits > 0) words.push((acc << (5 - bits)) & 31);
      const full = words.concat(bech32Checksum('npub', words));
      return 'npub1' + full.map(w => BECH32_CHARSET[w]).join('');
    }

    function shortNpub(npub) {
      return npub ? npub.slice(0, 12) + '...' + npub.slice(-6) : '';
    }

    // Resolves the signed-in pubkey to something a person recognises, using the
    // same kind 0 metadata the lookup tool reads. Runs after the panel is
    // already on screen, so a slow or unreachable relay never blocks sign-in.
    async function resolveSignerDisplayName(pubkey) {
      for (const relay of PROFILE_RELAYS) {
        try {
          const profile = await fetchProfileLegacy(relay, pubkey);
          const content = profile ? tryParseJSON(profile.content) : null;
          if (!content) continue;
          const name = content.display_name || content.name || '';
          const nip05 = content.nip05 || '';
          if (name && nip05) return name + ' (' + nip05 + ')';
          if (nip05) return nip05;
          if (name) return name;
        } catch { /* try the next relay */ }
      }
      return '';
    }

    // One picker for every platform. Choosing one reveals the single way that
    // platform can be verified here, rather than asking the reader to know the
    // difference between connecting an account and posting a proof, and then
    // find their platform inside whichever box holds it.
    function bindVerifyPlatformPicker() {
      const picker = document.querySelector('[aria-labelledby="verify-platform-label"]');
      if (!picker) return;
      const choices = Array.from(picker.querySelectorAll('.platform-choice'));
      const proofSelect = document.getElementById('proof-platform-select');
      const oauthSelect = document.getElementById('oauth-platform-select');

      function setSelectIfPresent(select, value) {
        if (!select) return false;
        const has = Array.from(select.options).some((o) => o.value === value);
        if (has) select.value = value;
        return has;
      }

      function showPanel(name) {
        for (const id of ['method-oauth', 'method-proof', 'method-unavailable']) {
          const el = document.getElementById(id);
          if (el) el.style.display = id === 'method-' + name ? 'block' : 'none';
        }
      }

      function choosePlatform(choice, { showProofInstead = false } = {}) {
        for (const c of choices) {
          const on = c === choice;
          c.setAttribute('aria-checked', on ? 'true' : 'false');
          c.tabIndex = on ? 0 : -1;
        }

        const platform = choice.dataset.verifyPlatform;
        const label = choice.dataset.label || 'the platform';
        const method = showProofInstead ? 'proof' : choice.dataset.method;

        setSelectIfPresent(oauthSelect, platform);
        if (setSelectIfPresent(proofSelect, platform)) {
          // Re-run the existing per-platform field labels and placeholders.
          proofSelect.dispatchEvent(new Event('change'));
        }

        const oauthName = document.getElementById('oauth-platform-name');
        if (oauthName) oauthName.textContent = label;
        const proofName = document.getElementById('proof-platform-name');
        if (proofName) proofName.textContent = label;

        const alt = document.getElementById('oauth-proof-alternative');
        if (alt) alt.style.display = choice.dataset.canProof === 'yes' ? 'block' : 'none';

        const reason = document.getElementById('method-unavailable-reason');
        if (reason) reason.textContent = choice.dataset.reason || '';

        // A fresh platform means the previous result no longer applies.
        clearStatus('proof-status');
        clearStatus('publish-status');
        const publishRow = document.getElementById('publish-row');
        if (publishRow) publishRow.style.display = 'none';
        const result = document.getElementById('proof-result');
        if (result) result.style.display = 'none';

        showPanel(method);
      }

      for (const choice of choices) {
        choice.addEventListener('click', () => choosePlatform(choice));
      }

      picker.addEventListener('keydown', (event) => {
        const index = choices.indexOf(document.activeElement);
        if (index === -1) return;
        let next = null;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = choices[(index + 1) % choices.length];
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = choices[(index - 1 + choices.length) % choices.length];
        if (event.key === ' ' || event.key === 'Enter') next = choices[index];
        if (!next) return;
        event.preventDefault();
        choosePlatform(next);
        next.focus();
      });

      const useProof = document.getElementById('use-proof-instead-btn');
      if (useProof) {
        useProof.addEventListener('click', () => {
          const current = choices.find((c) => c.getAttribute('aria-checked') === 'true');
          if (current) choosePlatform(current, { showProofInstead: true });
        });
      }

      const initial = choices.find((c) => c.getAttribute('aria-checked') === 'true') || choices[0];
      if (initial) choosePlatform(initial);

      // Lets the OAuth return path select the platform it just connected.
      window.__selectVerifyPlatform = (platform) => {
        const match = choices.find((c) => c.dataset.verifyPlatform === platform);
        if (match) choosePlatform(match);
      };
    }

    function setStatus(elId, msg, type) {
      const el = document.getElementById(elId);
      if (!el) return;
      el.style.display = 'block';
      el.textContent = msg;
      // brand-aligned status palette: ok=green, err=pink, loading=mint
      el.style.background = type === 'error' ? 'rgba(255,127,175,0.18)' : type === 'loading' ? 'rgba(208,251,203,0.5)' : 'rgba(39,197,139,0.18)';
      el.style.color = type === 'error' ? '#7a1133' : type === 'loading' ? '#07241B' : '#0a4f37';
      el.style.borderColor = type === 'error' ? 'rgba(255,127,175,0.55)' : type === 'loading' ? 'rgba(7,36,27,0.18)' : 'rgba(39,197,139,0.45)';
    }

    function clearStatus(elId) {
      const el = document.getElementById(elId);
      if (el) el.style.display = 'none';
    }

    function signerSourceLabel(source) {
      if (source === 'browser') return 'browser signer';
      if (source === 'keycast') return 'login.divine.video';
      if (source === 'bunker') return 'bunker';
      if (source === 'nostrconnect') return 'Nostr Connect';
      return '';
    }

    function updateSignerSummary() {
      // Signing in is a mode change, not a status line. Once there is an active
      // key the whole sign-in apparatus — three buttons, the paste field, its
      // fallback copy, the remote-signer disclosure — has nothing left to
      // offer, so swap it for a statement of who you are and a way back out.
      const signedIn = !!signerPubkeyHex;
      const controls = document.getElementById('signin-controls');
      const panel = document.getElementById('signed-in-panel');
      const heading = document.getElementById('signin-heading');
      if (controls) controls.style.display = signedIn ? 'none' : 'block';
      if (panel) panel.style.display = signedIn ? 'block' : 'none';
      if (heading) heading.textContent = signedIn ? 'Signed in' : 'Sign in to your Divine account';

      const identity = document.getElementById('signed-in-identity');
      if (identity) {
        if (!signedIn) {
          identity.textContent = '';
        } else {
          const via = activeSignerSource ? ' via ' + signerSourceLabel(activeSignerSource) : '';
          const npub = hexToNpub(signerPubkeyHex);
          identity.textContent = (shortNpub(npub) || signerPubkeyHex.slice(0, 12) + '...') + via;
          // Then upgrade to a human name if the profile has one. Keyed to the
          // pubkey that was current when the lookup started, so a fast
          // account switch cannot leave the previous name on screen.
          const resolvingFor = signerPubkeyHex;
          resolveSignerDisplayName(resolvingFor).then((name) => {
            if (!name || signerPubkeyHex !== resolvingFor) return;
            identity.textContent = name + via;
          }).catch(() => { /* keep the npub */ });
        }
      }

      const el = document.getElementById('signer-session-summary');
      if (!el) return;
      const parts = [];
      if (activeSignerSource) {
        parts.push('Connected via ' + signerSourceLabel(activeSignerSource) + '.');
      }
      if (signerPubkeyHex) {
        parts.push('Active key: ' + signerPubkeyHex.slice(0, 12) + '...' + signerPubkeyHex.slice(-8));
      }
      if (parts.length === 0) {
        el.style.display = 'none';
        el.textContent = '';
        return;
      }
      el.style.display = 'block';
      el.textContent = parts.join(' ');
    }

    async function signOutSigner() {
      const previous = activeSigner;
      activeSigner = null;
      activeSignerSource = null;
      signerPubkeyHex = null;
      clearKeycastSession();
      setAccountInputValue('');
      updateSignerSummary();
      setStatus('verify-login-status', 'Signed out. Choose how to sign in again.', 'ok');
      if (previous) await maybeCloseSigner(previous);
    }

    function isBrowserSignerAvailable() {
      return !!window.nostr &&
        typeof window.nostr.getPublicKey === 'function' &&
        typeof window.nostr.signEvent === 'function';
    }

    function createBrowserSigner() {
      return {
        async getPublicKey() {
          return (await window.nostr.getPublicKey()).toLowerCase();
        },
        async signEvent(event) {
          return await window.nostr.signEvent(event);
        },
      };
    }

    async function maybeCloseSigner(signer) {
      if (!signer) return;
      if (typeof signer.close === 'function') {
        try {
          await signer.close();
        } catch {}
      }
    }

    async function activateSigner(signer, source, successMessage) {
      const pubkey = String(await signer.getPublicKey()).toLowerCase();
      if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
        throw new Error('Signer returned an invalid pubkey.');
      }
      const previousSigner = activeSigner;
      activeSigner = signer;
      activeSignerSource = source;
      signerPubkeyHex = pubkey;
      setAccountInputValue(pubkey);
      updateSignerSummary();
      if (previousSigner && previousSigner !== signer) {
        await maybeCloseSigner(previousSigner);
      }
      if (successMessage) {
        setStatus('verify-login-status', successMessage, 'ok');
      }
      return pubkey;
    }

    function bytesToBase64Url(bytes) {
      let binary = '';
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
    }

    function randomBase64Url(size) {
      const bytes = new Uint8Array(size);
      crypto.getRandomValues(bytes);
      return bytesToBase64Url(bytes);
    }

    async function sha256Base64Url(text) {
      const data = new TextEncoder().encode(text);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
      return bytesToBase64Url(digest);
    }

    async function createKeycastPkce() {
      const verifier = randomBase64Url(32);
      const challenge = await sha256Base64Url(verifier);
      return { verifier: verifier, challenge: challenge };
    }

    function getKeycastRedirectUrl() {
      return window.location.origin + window.location.pathname;
    }

    function normalizeStoredKeycastSession(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const accessToken = raw.accessToken || raw.access_token || '';
      if (!accessToken) return null;
      const expiresAt = raw.expiresAt || (raw.expires_in ? Date.now() + Number(raw.expires_in) * 1000 : null);
      return {
        accessToken: accessToken,
        refreshToken: raw.refreshToken || raw.refresh_token || '',
        bunkerUrl: raw.bunkerUrl || raw.bunker_url || '',
        authorizationHandle: raw.authorizationHandle || raw.authorization_handle || '',
        expiresAt: expiresAt || null,
      };
    }

    function loadKeycastSession() {
      try {
        return normalizeStoredKeycastSession(JSON.parse(localStorage.getItem(KEYCAST_SESSION_KEY) || 'null'));
      } catch {
        return null;
      }
    }

    function saveKeycastSession(session) {
      localStorage.setItem(KEYCAST_SESSION_KEY, JSON.stringify(session));
    }

    function clearKeycastSession() {
      localStorage.removeItem(KEYCAST_SESSION_KEY);
    }

    function clearKeycastFlowState() {
      sessionStorage.removeItem(KEYCAST_PKCE_KEY);
      sessionStorage.removeItem(KEYCAST_STATE_KEY);
      sessionStorage.removeItem(KEYCAST_HASH_KEY);
    }

    function shouldRefreshKeycastSession(session) {
      return !!session &&
        !!session.refreshToken &&
        !!session.expiresAt &&
        Date.now() >= Number(session.expiresAt) - 5 * 60 * 1000;
    }

    function hasExpiredKeycastSession(session) {
      return !!session && !!session.expiresAt && Date.now() >= Number(session.expiresAt);
    }

    async function postKeycastTokenRequest(body) {
      const resp = await fetch(KEYCAST_BASE + '/api/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      let data = {};
      try {
        data = await resp.json();
      } catch {}
      if (!resp.ok) {
        throw new Error(data.error_description || data.error || 'login.divine.video token exchange failed.');
      }
      return data;
    }

    async function getValidKeycastSession(session) {
      let nextSession = session || loadKeycastSession();
      if (!nextSession) return null;
      if (shouldRefreshKeycastSession(nextSession)) {
        let refreshed;
        try {
          refreshed = await postKeycastTokenRequest({
            grant_type: 'refresh_token',
            refresh_token: nextSession.refreshToken,
            client_id: KEYCAST_CLIENT_ID,
          });
        } catch (err) {
          clearKeycastSession();
          throw err;
        }
        nextSession = normalizeStoredKeycastSession(refreshed);
        if (!nextSession) throw new Error('login.divine.video returned an unusable session.');
        saveKeycastSession(nextSession);
        return nextSession;
      }
      if (hasExpiredKeycastSession(nextSession)) {
        clearKeycastSession();
        return null;
      }
      return nextSession;
    }

    async function callKeycastRpc(sessionRef, method, params) {
      sessionRef.session = await getValidKeycastSession(sessionRef.session);
      if (!sessionRef.session || !sessionRef.session.accessToken) {
        throw new Error('Your login.divine.video session expired. Connect again.');
      }
      const resp = await fetch(KEYCAST_BASE + '/api/nostr', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + sessionRef.session.accessToken,
        },
        body: JSON.stringify({ method: method, params: params }),
      });
      let data = {};
      try {
        data = await resp.json();
      } catch {}
      if (!resp.ok) {
        throw new Error(data.error || data.message || 'login.divine.video signer request failed.');
      }
      if (!data || data.result === undefined) {
        throw new Error('login.divine.video signer returned no result.');
      }
      return data.result;
    }

    function createKeycastSigner(session) {
      const sessionRef = { session: session };
      return {
        async getPublicKey() {
          return await callKeycastRpc(sessionRef, 'get_public_key', []);
        },
        async signEvent(event) {
          return await callKeycastRpc(sessionRef, 'sign_event', [event]);
        },
      };
    }

    function showNostrConnectUi(uri) {
      const wrap = document.getElementById('nostr-connect-wrap');
      const input = document.getElementById('nostr-connect-uri-input');
      const link = document.getElementById('open-nostr-connect-link');
      if (!wrap || !input || !link) return;
      wrap.style.display = 'block';
      input.value = uri;
      link.href = uri;
      document.getElementById('remote-signer-details').open = true;
    }

    function hideNostrConnectUi() {
      const wrap = document.getElementById('nostr-connect-wrap');
      const input = document.getElementById('nostr-connect-uri-input');
      const link = document.getElementById('open-nostr-connect-link');
      if (wrap) wrap.style.display = 'none';
      if (input) input.value = '';
      if (link) link.href = '#';
    }

    async function loadNostrTools() {
      if (!nostrToolsPromise) {
        nostrToolsPromise = Promise.all([
          import(NOSTR_TOOLS_NIP46_URL),
          import(NOSTR_TOOLS_PURE_URL),
        ]).then(function(modules) {
          return { nip46: modules[0], pure: modules[1] };
        });
      }
      return await nostrToolsPromise;
    }

    function safeDecodeText(input) {
      try {
        return decodeURIComponent(input);
      } catch {
        return input;
      }
    }

    async function resolveNip05ToHex(identifier) {
      const normalized = (identifier || '').trim().toLowerCase();
      const parts = normalized.split('@');
      if (parts.length !== 2) {
        throw new Error('That address does not look valid. Use format name@domain.');
      }
      const local = parts[0] || '_';
      const domain = parts[1];
      const resp = await fetch('https://' + domain + '/.well-known/nostr.json?name=' + encodeURIComponent(local));
      if (!resp.ok) {
        throw new Error('Could not find "' + normalized + '". Check spelling and try again.');
      }
      const data = await resp.json();
      const key = data && data.names ? data.names[local] : null;
      if (!key || !/^[0-9a-f]{64}$/i.test(key)) {
        throw new Error('That address did not resolve to a usable Nostr key.');
      }
      return key.toLowerCase();
    }

    function extractHexFromText(text) {
      const match = (text || '').match(/([0-9a-fA-F]{64})/);
      return match ? match[1].toLowerCase() : null;
    }

    function extractNpubFromText(text) {
      const match = (text || '').toLowerCase().match(/(npub1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+)/);
      return match ? match[1] : null;
    }

    async function normalizePubkeyInput(raw) {
      const input = (raw || '').trim();
      if (!input) throw new Error('Enter your Divine address or npub first.');

      const decoded = safeDecodeText(input);
      const hex = extractHexFromText(decoded);
      if (hex) return hex;

      const npub = extractNpubFromText(decoded);
      if (npub) return npubToHex(npub);

      const nip05Match = decoded.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,})/);
      if (nip05Match) return await resolveNip05ToHex(nip05Match[1]);

      throw new Error('Could not read your key. Paste a Divine address, npub, profile URL, or 64-character key.');
    }

    function setAccountInputValue(value) {
      const inputEl = document.getElementById('verify-pubkey-input');
      if (!inputEl) return;
      inputEl.value = value;
      if (value) localStorage.setItem('verifyer_account_input', value);
    }

    function inferLoginQueryPubkey(params) {
      const keys = ['npub', 'pubkey', 'nostr_pubkey', 'key'];
      for (const key of keys) {
        const value = params.get(key);
        if (!value) continue;
        const hex = extractHexFromText(value);
        if (hex) return hex;
        const npub = extractNpubFromText(value);
        if (npub) return npubToHex(npub);
      }
      return null;
    }

    function applyLoginQueryHint() {
      const params = new URLSearchParams(window.location.search);
      const hintPubkey = inferLoginQueryPubkey(params);
      if (!hintPubkey) return;
      signerPubkeyHex = hintPubkey;
      activeSignerSource = null;
      setAccountInputValue(hintPubkey);
      updateSignerSummary();
      setStatus('verify-login-status', 'Logged in. Nostr key detected from return URL.', 'ok');
      params.delete('npub');
      params.delete('pubkey');
      params.delete('nostr_pubkey');
      params.delete('key');
      const cleanUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '') + window.location.hash;
      window.history.replaceState({}, '', cleanUrl);
    }

    async function connectBrowserSigner() {
      const browserSigner = createBrowserSigner();
      // The server-side NIP-98 login endpoint is retired; the browser signer
      // only needs its own key locally (proof-post publish signs kind 10011).
      const signerPubkey = await browserSigner.getPublicKey();
      if (!signerPubkey) {
        throw new Error('Browser signer did not return a public key.');
      }

      await activateSigner(browserSigner, 'browser', 'Signed in with your browser signer.');
    }

    async function startKeycastLogin() {
      const pkce = await createKeycastPkce();
      const state = randomBase64Url(24);
      sessionStorage.setItem(KEYCAST_PKCE_KEY, JSON.stringify(pkce));
      sessionStorage.setItem(KEYCAST_STATE_KEY, state);
      sessionStorage.setItem(KEYCAST_HASH_KEY, window.location.hash || '#verify-here');

      const session = loadKeycastSession();
      const url = new URL(KEYCAST_BASE + '/api/oauth/authorize');
      url.searchParams.set('client_id', KEYCAST_CLIENT_ID);
      url.searchParams.set('redirect_uri', getKeycastRedirectUrl());
      url.searchParams.set('scope', KEYCAST_SCOPE);
      url.searchParams.set('code_challenge', pkce.challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('state', state);
      // No default_register: keycast reads that param to choose which form to
      // open on, and sending 'true' put people who clicked "sign in" on the
      // Create account form. Its login view already links to registration.
      if (session && session.authorizationHandle) {
        url.searchParams.set('authorization_handle', session.authorizationHandle);
      }
      window.location.href = url.toString();
    }

    function cleanKeycastCallbackParams() {
      const params = new URLSearchParams(window.location.search);
      params.delete('code');
      params.delete('state');
      params.delete('error');
      params.delete('error_description');
      const nextHash = sessionStorage.getItem(KEYCAST_HASH_KEY) || window.location.hash;
      const cleanUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '') + (nextHash || '');
      window.history.replaceState({}, '', cleanUrl);
      clearKeycastFlowState();
    }

    async function maybeHandleKeycastCallback() {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      const error = params.get('error');
      if (!code && !error) return false;

      clearStatus('verify-global-status');
      setStatus('verify-login-status', 'Finishing login.divine.video session...', 'loading');
      try {
        if (error) {
          throw new Error(params.get('error_description') || error);
        }

        const expectedState = sessionStorage.getItem(KEYCAST_STATE_KEY);
        const receivedState = params.get('state');
        if (!expectedState || !receivedState || expectedState !== receivedState) {
          throw new Error('login.divine.video returned an invalid state token.');
        }

        let pkce;
        try {
          pkce = JSON.parse(sessionStorage.getItem(KEYCAST_PKCE_KEY) || 'null');
        } catch {
          pkce = null;
        }
        if (!pkce || !pkce.verifier) {
          throw new Error('Missing PKCE verifier. Start login again.');
        }

        const tokenData = await postKeycastTokenRequest({
          grant_type: 'authorization_code',
          code: code,
          client_id: KEYCAST_CLIENT_ID,
          redirect_uri: getKeycastRedirectUrl(),
          code_verifier: pkce.verifier,
        });
        const session = normalizeStoredKeycastSession(tokenData);
        if (!session) {
          throw new Error('login.divine.video did not return a usable signer session.');
        }
        saveKeycastSession(session);
        await activateSigner(createKeycastSigner(session), 'keycast', 'Signed in with Divine.');
      } catch (e) {
        clearKeycastSession();
        setStatus('verify-login-status', e.message || 'Could not connect login.divine.video.', 'error');
      } finally {
        cleanKeycastCallbackParams();
      }
      return true;
    }

    async function restoreKeycastSession() {
      const session = await getValidKeycastSession();
      if (!session) return false;
      try {
        // Silent: the reader did not do anything, and the signed-in panel
        // already states who they are.
        await activateSigner(createKeycastSigner(session), 'keycast', '');
        return true;
      } catch {
        clearKeycastSession();
        return false;
      }
    }

    async function connectKeycastSigner() {
      clearStatus('verify-login-status');
      setStatus('verify-login-status', 'Opening secure login.divine.video...', 'loading');
      await startKeycastLogin();
    }

    async function connectBunkerSigner() {
      clearStatus('verify-login-status');
      const input = document.getElementById('bunker-input').value.trim();
      if (!input) {
        setStatus('verify-login-status', 'Paste a bunker URL or bunker NIP-05 first.', 'error');
        return;
      }
      try {
        setButtonLoading('connect-bunker-btn', true, 'Connecting...');
        setStatus('verify-login-status', 'Connecting to bunker signer...', 'loading');
        const tools = await loadNostrTools();
        const parsed = await tools.nip46.parseBunkerInput(input);
        if (!parsed) {
          throw new Error('Could not read that bunker URL or bunker NIP-05.');
        }
        const signer = tools.nip46.BunkerSigner.fromBunker(tools.pure.generateSecretKey(), parsed);
        await signer.connect();
        hideNostrConnectUi();
        await activateSigner(signer, 'bunker', 'Connected with bunker signer.');
      } catch (e) {
        setStatus('verify-login-status', e.message || 'Could not connect bunker signer.', 'error');
      } finally {
        setButtonLoading('connect-bunker-btn', false, '');
      }
    }

    async function startNostrConnect() {
      clearStatus('verify-login-status');
      try {
        setButtonLoading('start-nostr-connect-btn', true, 'Waiting...');
        setStatus('verify-login-status', 'Preparing Nostr Connect session...', 'loading');
        const tools = await loadNostrTools();
        const clientSecretKey = tools.pure.generateSecretKey();
        const secret = randomBase64Url(18);
        const uri = tools.nip46.createNostrConnectURI({
          clientPubkey: tools.pure.getPublicKey(clientSecretKey),
          relays: REMOTE_SIGNER_RELAYS,
          secret: secret,
          perms: ['get_public_key', 'sign_event'],
          name: 'Divine Verification',
          url: window.location.origin,
        });
        if (nostrConnectAbortController) {
          nostrConnectAbortController.abort();
        }
        nostrConnectAbortController = new AbortController();
        showNostrConnectUi(uri);
        setStatus('verify-login-status', 'Waiting for your signer to approve the Nostr Connect request...', 'loading');
        const signer = await tools.nip46.BunkerSigner.fromURI(
          clientSecretKey,
          uri,
          {},
          nostrConnectAbortController.signal
        );
        nostrConnectAbortController = null;
        hideNostrConnectUi();
        await activateSigner(signer, 'nostrconnect', 'Connected with Nostr Connect.');
      } catch (e) {
        const aborted = e && (e.name === 'AbortError' || String(e.message || '').toLowerCase().includes('aborted'));
        if (aborted) {
          clearStatus('verify-login-status');
        } else {
          setStatus('verify-login-status', e.message || 'Could not connect with Nostr Connect.', 'error');
        }
      } finally {
        setButtonLoading('start-nostr-connect-btn', false, '');
      }
    }

    function cancelNostrConnect() {
      if (nostrConnectAbortController) {
        nostrConnectAbortController.abort();
        nostrConnectAbortController = null;
      }
      hideNostrConnectUi();
      clearStatus('verify-login-status');
    }

    async function copyNostrConnectUri() {
      const input = document.getElementById('nostr-connect-uri-input');
      if (!input || !input.value) return;
      try {
        await navigator.clipboard.writeText(input.value);
        setStatus('verify-login-status', 'Nostr Connect URI copied.', 'ok');
      } catch {
        setStatus('verify-login-status', 'Could not copy the Nostr Connect URI.', 'error');
      }
    }

    async function connectNostrSigner() {
      clearStatus('verify-login-status');
      try {
        setButtonLoading('connect-nostr-btn', true, 'Signing in...');
        if (isBrowserSignerAvailable()) {
          await connectBrowserSigner();
          return;
        }
        setStatus('verify-login-status', 'No browser signer found — opening login.divine.video instead...', 'loading');
        await connectKeycastSigner();
      } catch (e) {
        setStatus('verify-login-status', e.message || 'Could not sign in with Nostr.', 'error');
      } finally {
        setButtonLoading('connect-nostr-btn', false, '');
      }
    }

    async function getActivePubkey() {
      const accountInput = document.getElementById('verify-pubkey-input').value;
      if (accountInput && accountInput.trim()) {
        const parsed = await normalizePubkeyInput(accountInput);
        if (signerPubkeyHex && signerPubkeyHex !== parsed) {
          throw new Error('The typed account does not match your signed-in signer key.');
        }
        return parsed;
      }
      if (signerPubkeyHex) return signerPubkeyHex;
      throw new Error('Sign in above, or paste your account (alice@divine.video, npub, or 64-char key) first.');
    }

    function setButtonLoading(buttonId, isLoading, loadingText) {
      const button = document.getElementById(buttonId);
      if (!button) return;
      if (!button.dataset.defaultText) {
        button.dataset.defaultText = button.textContent || '';
      }
      button.disabled = isLoading;
      button.textContent = isLoading ? loadingText : button.dataset.defaultText;
    }

    function updateOAuthInputs() {
      // All Quick Connect providers start from the same button; nothing to toggle.
    }

    function updateProofInputs() {
      const platform = document.getElementById('proof-platform-select').value;
      const identityInput = document.getElementById('proof-identity-input');
      const proofLabel = document.getElementById('proof-label');
      const proofInput = document.getElementById('proof-proof-input');
      const helper = document.getElementById('proof-helper');

      if (platform === 'bluesky') {
        identityInput.placeholder = 'alice.bsky.social';
        proofLabel.textContent = 'Post link or proof ID (optional)';
        proofInput.placeholder = 'Paste full Bluesky post URL or leave blank for identity-link check';
        helper.textContent = 'Bluesky can verify by login or identity-link record, even without a post ID.';
      } else if (platform === 'github') {
        identityInput.placeholder = 'octocat';
        proofLabel.textContent = 'Gist link or Gist ID';
        proofInput.placeholder = 'https://gist.github.com/octocat/abc123... or abc123...';
        helper.textContent = 'Paste a gist URL and we will extract the ID for you.';
      } else if (platform === 'twitter') {
        identityInput.placeholder = 'jack';
        proofLabel.textContent = 'Post link or Tweet ID';
        proofInput.placeholder = 'https://x.com/jack/status/123... or 123...';
        helper.textContent = 'Paste an X/Twitter post URL for easiest setup.';
      } else if (platform === 'mastodon') {
        identityInput.placeholder = 'mastodon.social/@alice';
        proofLabel.textContent = 'Status link or Status ID';
        proofInput.placeholder = 'https://mastodon.social/@alice/123... or 123...';
        helper.textContent = 'Identity format is instance/@user. A full status URL also works.';
      } else if (platform === 'telegram') {
        identityInput.placeholder = 'mychannel';
        proofLabel.textContent = 'Message link or channel/message ID';
        proofInput.placeholder = 'https://t.me/mychannel/123 or mychannel/123';
        helper.textContent = 'Telegram proof should point to a public message that contains your npub.';
      } else if (platform === 'discord') {
        identityInput.placeholder = 'your Discord username';
        proofLabel.textContent = 'Message link';
        proofInput.placeholder = 'https://discord.com/channels/.../.../...';
        helper.textContent = 'Post a message containing your npub, then right-click it and Copy Message Link. A server invite cannot prove who owns an account.';
      } else if (platform === 'youtube') {
        identityInput.placeholder = 'UC... or @channelhandle';
        proofLabel.textContent = 'Video link or video ID';
        proofInput.placeholder = 'https://www.youtube.com/watch?v=... or 11-char ID';
        helper.textContent = 'We verify your npub inside the video description.';
      } else if (platform === 'tiktok') {
        identityInput.placeholder = 'username';
        proofLabel.textContent = 'Video link or video ID';
        proofInput.placeholder = 'https://www.tiktok.com/@user/video/123... or numeric ID';
        helper.textContent = 'Paste a TikTok video URL and we will extract the ID.';
      } else {
        identityInput.placeholder = 'Account identity';
        proofLabel.textContent = 'Post link or proof ID';
        proofInput.placeholder = 'Paste full URL or proof ID';
        helper.textContent = 'Paste a full link if available.';
      }
    }

    function tryMakeUrl(input) {
      const raw = (input || '').trim();
      if (!raw) return null;
      try {
        return new URL(raw);
      } catch {}
      if (/^[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}\\/.+/.test(raw)) {
        try {
          return new URL('https://' + raw);
        } catch {}
      }
      return null;
    }

    function parseProofUrl(platform, parsedUrl) {
      const host = parsedUrl.hostname.toLowerCase();
      const path = parsedUrl.pathname.split('/').filter(Boolean);

      if (platform === 'github' && host.includes('gist.github.com')) {
        if (path.length >= 2) {
          return { identity: path[0], proof: path[1] };
        }
      }

      if (platform === 'twitter' && (host === 'x.com' || host === 'www.x.com' || host === 'twitter.com' || host === 'www.twitter.com')) {
        const statusIdx = path.indexOf('status');
        if (statusIdx > 0 && path[statusIdx + 1]) {
          return { identity: path[statusIdx - 1].replace(/^@/, ''), proof: path[statusIdx + 1] };
        }
      }

      if (platform === 'bluesky' && host === 'bsky.app') {
        if (path[0] === 'profile' && path[1] && path[2] === 'post' && path[3]) {
          return { identity: path[1], proof: path[3] };
        }
      }

      if (platform === 'mastodon') {
        if (path.length >= 2 && path[0].startsWith('@')) {
          return { identity: host + '/' + path[0], proof: path[1] };
        }
        if (path[0] === 'users' && path[1] && path[2] === 'statuses' && path[3]) {
          return { identity: host + '/@' + path[1], proof: path[3] };
        }
      }

      if (platform === 'telegram' && (host === 't.me' || host === 'www.t.me')) {
        if (path[0] && path[1]) {
          const channel = path[0].replace(/^@/, '');
          return { identity: channel, proof: channel + '/' + path[1] };
        }
      }

      if (platform === 'youtube') {
        if ((host === 'youtube.com' || host === 'www.youtube.com') && parsedUrl.searchParams.get('v')) {
          return { proof: parsedUrl.searchParams.get('v') };
        }
        if ((host === 'youtube.com' || host === 'www.youtube.com') && path[0] === 'shorts' && path[1]) {
          return { proof: path[1] };
        }
        if ((host === 'youtu.be' || host === 'www.youtu.be') && path[0]) {
          return { proof: path[0] };
        }
      }

      if (platform === 'tiktok' && host.endsWith('tiktok.com')) {
        const userPart = path.find(part => part.startsWith('@'));
        const videoIdx = path.indexOf('video');
        if (videoIdx !== -1 && path[videoIdx + 1]) {
          return {
            identity: userPart ? userPart.slice(1) : undefined,
            proof: path[videoIdx + 1],
          };
        }
      }

      return {};
    }

    function normalizeProofInputs(platform, rawIdentity, rawProof) {
      let identity = (rawIdentity || '').trim();
      let proof = (rawProof || '').trim();

      const proofUrl = tryMakeUrl(proof);
      if (proofUrl) {
        const parsed = parseProofUrl(platform, proofUrl);
        if (parsed.identity && !identity) identity = parsed.identity;
        if (parsed.proof) proof = parsed.proof;
      } else if (!proof) {
        const identityUrl = tryMakeUrl(identity);
        if (identityUrl) {
          const parsed = parseProofUrl(platform, identityUrl);
          if (parsed.identity) identity = parsed.identity;
          if (parsed.proof) proof = parsed.proof;
        }
      }

      if (platform === 'twitter' || platform === 'telegram' || platform === 'tiktok') {
        identity = identity.replace(/^@/, '');
      }
      if (platform === 'bluesky') {
        identity = identity.replace(/^@/, '').toLowerCase();
      }
      proof = proof.replace(/^\\/+/, '').replace(/\\/+$/, '');
      return { identity, proof };
    }

    async function startOAuthVerification() {
      try {
        clearStatus('verify-global-status');
        clearStatus('oauth-status');
        // Reachable via the account field's Enter key even when Quick Connect
        // has no configured providers and therefore renders no platform select.
        const platformSelect = document.getElementById('oauth-platform-select');
        if (!platformSelect) {
          setStatus('oauth-status', 'Quick Connect is not available on this deployment. Use "verify by post/link proof" below instead.', 'error');
          return;
        }
        setButtonLoading('oauth-start-btn', true, 'Opening sign-in...');

        const platform = platformSelect.value;
        const session = await getValidKeycastSession();
        if (!session || !session.accessToken) {
          setStatus('oauth-status', 'Quick Connect needs a login.divine.video session. Use the login.divine.video button above first, then retry.', 'error');
          setButtonLoading('oauth-start-btn', false, '');
          return;
        }

        setStatus('oauth-status', 'Opening secure ' + platform + ' sign-in...', 'loading');
        const resp = await fetch(API + '/connections/' + platform + '/start', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + session.accessToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ returnUrl: window.location.origin + '/' }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.authorizationUrl) {
          throw new Error((data && data.error && data.error.message) || 'Could not start sign-in.');
        }
        window.location.href = data.authorizationUrl;
      } catch (e) {
        setStatus('oauth-status', e.message || 'Could not start sign-in.', 'error');
        setButtonLoading('oauth-start-btn', false, '');
      }
    }

    async function verifySingleHere() {
      const resultEl = document.getElementById('proof-result');
      resultEl.style.display = 'none';
      try {
        clearStatus('verify-global-status');
        clearStatus('publish-status');
        clearStatus('proof-status');
        setButtonLoading('proof-verify-btn', true, 'Checking...');
        setStatus('proof-status', 'Checking your account...', 'loading');

        const pubkey = await getActivePubkey();
        setAccountInputValue(pubkey);

        const platform = document.getElementById('proof-platform-select').value;
        const rawIdentity = document.getElementById('proof-identity-input').value;
        const rawProof = document.getElementById('proof-proof-input').value;
        const normalized = normalizeProofInputs(platform, rawIdentity, rawProof);

        document.getElementById('proof-identity-input').value = normalized.identity;
        document.getElementById('proof-proof-input').value = normalized.proof;

        if (!normalized.identity) throw new Error('Enter your account name for this platform.');
        if (platform !== 'bluesky' && !normalized.proof) throw new Error('Paste the post link or proof ID for this platform.');

        setStatus('proof-status', 'Verifying link now...', 'loading');
        const resp = await fetch(API + '/verify/single', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            platform,
            identity: normalized.identity,
            proof: normalized.proof,
            pubkey,
          }),
        });

        const data = await resp.json();
        if (!resp.ok || data.error) {
          setStatus('proof-status', data.error || 'Not verified yet.', 'error');
        } else if (data.verified) {
          const method = data.method ? ' via ' + data.method.replace('_', ' ') : '';
          setStatus('proof-status', 'Success. This account is verified' + method + '.', 'ok');
          // Publishing is what makes the verification visible to other people.
          // Leaving it to a separate button people never found is why a
          // successful verification read as "nothing happened".
          await publishAfterVerification();
        } else {
          setStatus('proof-status', data.error || 'Not verified yet.', 'error');
        }
        resultEl.textContent = JSON.stringify(data, null, 2);
        resultEl.style.display = 'block';
      } catch (e) {
        setStatus('proof-status', e.message || 'Verification failed.', 'error');
      } finally {
        setButtonLoading('proof-verify-btn', false, '');
      }
    }

    // Runs straight after a verification succeeds. A missing signer is a normal
    // situation here, not an error worth shouting about: the verification is
    // already stored and readable through the badge API, it just is not on the
    // profile event yet. Say that plainly and leave the manual button visible.
    async function publishAfterVerification() {
      const row = document.getElementById('publish-row');
      if (row) row.style.display = 'block';
      if (!activeSigner) {
        setStatus('publish-status', 'Verified. Sign in above to also publish this to your Nostr profile so others can see it.', 'loading');
        return;
      }
      try {
        await publishIdentityTagToNostr();
      } catch (e) {
        setStatus('publish-status', (e.message || 'Could not publish to your profile.') + ' Your verification is saved either way.', 'error');
      }
    }

    function currentProofContext() {
      const platform = document.getElementById('proof-platform-select').value;
      const normalized = normalizeProofInputs(
        platform,
        document.getElementById('proof-identity-input').value,
        document.getElementById('proof-proof-input').value
      );
      document.getElementById('proof-identity-input').value = normalized.identity;
      document.getElementById('proof-proof-input').value = normalized.proof;
      return { platform, identity: normalized.identity, proof: normalized.proof || 'oauth' };
    }

    function publishEventToRelay(relayUrl, event) {
      return new Promise((resolve) => {
        let settled = false;
        let ws = null;
        const done = (ok, message) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (ws) {
            try { ws.close(); } catch {}
          }
          resolve({ relay: relayUrl, ok, message });
        };

        const timer = setTimeout(() => done(false, 'timeout'), 7000);
        try {
          ws = new WebSocket(relayUrl);
        } catch {
          done(false, 'connect failed');
          return;
        }

        ws.onopen = () => {
          try {
            ws.send(JSON.stringify(['EVENT', event]));
          } catch {
            done(false, 'send failed');
          }
        };
        ws.onmessage = (msg) => {
          try {
            const data = JSON.parse(msg.data);
            if (data[0] === 'OK' && data[1] === event.id) {
              done(Boolean(data[2]), data[3] || (data[2] ? 'accepted' : 'rejected'));
            } else if (data[0] === 'NOTICE') {
              done(false, data[1] || 'notice');
            }
          } catch {}
        };
        ws.onerror = () => done(false, 'relay error');
        ws.onclose = () => done(false, 'closed');
      });
    }

    async function publishIdentityTagToNostr() {
      clearStatus('verify-global-status');
      clearStatus('publish-status');
      try {
        setButtonLoading('publish-kind0-btn', true, 'Publishing...');
        setStatus('publish-status', 'Checking signer and profile...', 'loading');

        if (!activeSigner || typeof activeSigner.signEvent !== 'function' || typeof activeSigner.getPublicKey !== 'function') {
          throw new Error('A signer session is required to publish. Connect a browser signer, login.divine.video, bunker, or Nostr Connect first.');
        }

        const activePubkey = await getActivePubkey();
        const signerPubkey = String(await activeSigner.getPublicKey()).toLowerCase();
        if (activePubkey !== signerPubkey) {
          throw new Error('Signed-in key and selected account do not match.');
        }
        signerPubkeyHex = signerPubkey;
        setAccountInputValue(signerPubkey);
        updateSignerSummary();

        const link = currentProofContext();
        if (!link.identity) {
          throw new Error('Enter the platform account name first.');
        }

        setStatus('publish-status', 'Loading identity event...', 'loading');
        let identityEvent = null;
        for (const relay of PROFILE_RELAYS) {
          try {
            identityEvent = await fetchIdentityEvent(relay, signerPubkey);
            if (identityEvent) break;
          } catch {}
        }
        // Fall back to kind 0 for pre-migration profiles
        if (!identityEvent) {
          for (const relay of PROFILE_RELAYS) {
            try {
              identityEvent = await fetchProfileLegacy(relay, signerPubkey);
              if (identityEvent) break;
            } catch {}
          }
        }

        const tags = Array.isArray(identityEvent?.tags) ? identityEvent.tags.filter(Array.isArray) : [];
        // Only carry forward i-tags (kind 10011 has no content or other tag types)
        const iTags = tags.filter(tag => tag[0] === 'i');
        const claimKey = link.platform + ':' + link.identity;
        const nextTags = iTags.filter(tag => !(typeof tag[1] === 'string' && tag[1].toLowerCase() === claimKey.toLowerCase()));
        nextTags.push(['i', claimKey, link.proof]);

        const unsignedEvent = {
          kind: 10011,
          created_at: Math.floor(Date.now() / 1000),
          tags: nextTags,
          content: '',
          pubkey: signerPubkey,
        };

        setStatus('publish-status', 'Requesting signature from your signer...', 'loading');
        const signedEvent = await activeSigner.signEvent(unsignedEvent);
        if (!signedEvent || !signedEvent.id || !signedEvent.sig) {
          throw new Error('Signer did not return a valid signed event.');
        }
        if (String(signedEvent.pubkey || '').toLowerCase() !== signerPubkey) {
          throw new Error('Signer returned an event for a different pubkey.');
        }

        setStatus('publish-status', 'Publishing identity event to relays...', 'loading');
        const relayResults = await Promise.all(PROFILE_RELAYS.map(relay => publishEventToRelay(relay, signedEvent)));
        const successCount = relayResults.filter(r => r.ok).length;
        if (successCount === 0) {
          const firstError = relayResults[0] && relayResults[0].message ? relayResults[0].message : 'no relay accepted the event';
          throw new Error('Publish failed: ' + firstError);
        }

        setStatus('publish-status', 'Published to ' + successCount + '/' + PROFILE_RELAYS.length + ' relays. Your Nostr profile link is now updated.', 'ok');
      } catch (e) {
        setStatus('publish-status', e.message || 'Could not publish to Nostr profile.', 'error');
      } finally {
        setButtonLoading('publish-kind0-btn', false, '');
      }
    }

    function handleOAuthCallbackMessage() {
      const params = new URLSearchParams(window.location.search);
      let shouldClean = false;
      if (params.get('connection') === 'connected') {
        const platform = params.get('platform') || 'account';
        setStatus('verify-global-status', 'Success. Your ' + platform + ' account is now connected and your badge is live. You can publish it to your Nostr profile below.', 'ok');

        // Pre-fill the Advanced section so the Publish button works for this result
        const proofPlatformEl = document.getElementById('proof-platform-select');
        const proofProofEl = document.getElementById('proof-proof-input');
        if (proofPlatformEl) {
          proofPlatformEl.value = platform;
          if (proofProofEl) proofProofEl.value = 'oauth';
        }
        // Returning from a connect flow is a successful verification, so it
        // publishes to the profile just like a proof post does rather than
        // dropping the reader next to a button they have to know to press.
        if (typeof window.__selectVerifyPlatform === 'function') {
          window.__selectVerifyPlatform(platform);
        }
        await publishAfterVerification();

        shouldClean = true;
      } else if (params.get('connection') === 'failed') {
        const reason = params.get('reason') || 'connection_failed';
        setStatus('verify-global-status', 'Sign-in was not completed: ' + reason, 'error');
        shouldClean = true;
      }
      if (shouldClean) {
        params.delete('connection');
        params.delete('platform');
        params.delete('reason');
        const cleanUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '') + window.location.hash;
        window.history.replaceState({}, '', cleanUrl);
      }
    }

    function showStatus(msg, type) {
      const el = document.getElementById('lookup-status');
      el.style.display = 'block';
      el.textContent = msg;
      // brand-aligned status palette
      el.style.background = type === 'error' ? 'rgba(255,127,175,0.18)' : type === 'loading' ? 'rgba(208,251,203,0.5)' : 'rgba(39,197,139,0.18)';
      el.style.color = type === 'error' ? '#7a1133' : type === 'loading' ? '#07241B' : '#0a4f37';
      el.style.borderColor = type === 'error' ? 'rgba(255,127,175,0.55)' : type === 'loading' ? 'rgba(7,36,27,0.18)' : 'rgba(39,197,139,0.45)';
    }

    function hideStatus() { clearStatus('lookup-status'); }

    function renderResults(results, pubkey) {
      const el = document.getElementById('lookup-results');
      if (!results || results.length === 0) {
        el.innerHTML = '<p style="color:rgba(7,36,27,0.65);font-size:0.92rem;">No identity claims found on this profile.</p>';
        return;
      }
      let html = '<table><tr><th>Platform</th><th>Identity</th><th>Status</th><th>Details</th></tr>';
      for (const r of results) {
        const icon = r.verified ? '&#9989;' : '&#10060;';
        const status = r.verified ? '<span style="color:#0a4f37;font-weight:700;">Verified</span>' : '<span style="color:#7a1133;font-weight:700;">Not verified</span>';
        const detail = r.error || (r.cached ? 'cached' : 'fresh check');
        html += '<tr><td><code>' + esc(r.platform) + '</code></td><td>' + esc(r.identity) + '</td><td>' + icon + ' ' + status + '</td><td style="font-size:0.82rem;color:rgba(7,36,27,0.6);">' + esc(detail) + '</td></tr>';
      }
      html += '</table>';
      el.innerHTML = html;
    }

    function esc(s) {
      const d = document.createElement('div');
      d.textContent = s || '';
      return d.innerHTML;
    }

    async function doLookup() {
      const input = document.getElementById('lookup-input').value.trim();
      if (!input) return;

      const resultsEl = document.getElementById('lookup-results');
      resultsEl.innerHTML = '';
      showStatus('Looking up...', 'loading');

      try {
        // Determine if npub or NIP-05
        let pubkey, nip05Name;
        if (input.startsWith('npub1')) {
          pubkey = npubToHex(input);
        } else if (input.includes('@')) {
          nip05Name = input;
          // First resolve NIP-05 to get the pubkey
          const parts = input.split('@');
          const domain = parts[1];
          const local = parts[0] || '_';
          const nip05Resp = await fetch('https://' + domain + '/.well-known/nostr.json?name=' + encodeURIComponent(local));
          if (!nip05Resp.ok) throw new Error('Could not fetch NIP-05 from ' + domain);
          const nip05Data = await nip05Resp.json();
          pubkey = nip05Data.names && nip05Data.names[local];
          if (!pubkey) throw new Error('NIP-05 name "' + local + '" not found at ' + domain);
        } else {
          // Try as raw hex pubkey
          if (/^[0-9a-f]{64}$/i.test(input)) {
            pubkey = input.toLowerCase();
          } else {
            throw new Error('Enter an npub, NIP-05 (user@domain), or 64-char hex pubkey');
          }
        }

        showStatus('Found pubkey: ' + pubkey.slice(0, 8) + '...' + pubkey.slice(-8) + '. Checking verified links...', 'loading');

        // Verifications this service recorded are authoritative and need no relay
        // round trip. Publishing a NIP-39 tag is a separate, signer-gated step, so
        // these must show even when the profile carries no i-tags at all.
        let storedResults = [];
        try {
          const storedResp = await fetch(API + '/verified/' + pubkey);
          if (storedResp.ok) {
            const stored = await storedResp.json();
            storedResults = (stored.verifications || []).map(v => ({
              platform: v.platform,
              identity: v.identity,
              verified: true,
              method: v.method,
              cached: true,
            }));
          }
        } catch { /* fall through to relay claims */ }

        const storedKey = r => r.platform + '|' + String(r.identity).toLowerCase();
        const storedKeys = new Set(storedResults.map(storedKey));

        // Show what we already know straight away. The relay round-trip below can take
        // tens of seconds when relays are slow or unreachable, and leaving the table
        // empty until then reads as "nothing was verified".
        if (storedResults.length > 0) {
          renderResults(storedResults, pubkey);
          showStatus('Checking relays for any additional NIP-39 claims...', 'loading');
        }

        // Fetch identity event (kind 10011) from Nostr relays, fall back to kind 0
        const relays = PROFILE_RELAYS;
        let identityEvent = null;
        let legacyProfile = null;

        for (const relay of relays) {
          try {
            if (!identityEvent) identityEvent = await fetchIdentityEvent(relay, pubkey);
            if (!legacyProfile) legacyProfile = await fetchProfileLegacy(relay, pubkey);
            if (identityEvent) break;
          } catch { /* try next relay */ }
        }

        const source = identityEvent || legacyProfile;
        if (!source) {
          if (storedResults.length > 0) {
            hideStatus();
            renderResults(storedResults, pubkey);
          } else {
            showStatus('Could not find identity claims on relays.', 'error');
          }
          return;
        }

        // Extract i-tags (NIP-39 identity claims)
        const iTags = (source.tags || []).filter(t => t[0] === 'i' && t[1] && t[2]);
        if (iTags.length === 0) {
          const profileContent = legacyProfile ? tryParseJSON(legacyProfile.content) : null;
          let results = storedResults.slice();
          if (profileContent && profileContent.nip05) {
            const nip05Resp = await fetch(API + '/nip05/verify?name=' + encodeURIComponent(profileContent.nip05) + '&pubkey=' + pubkey);
            const nip05Result = await nip05Resp.json();
            results = [{
              platform: 'nip05',
              identity: profileContent.nip05,
              verified: nip05Result.verified,
              error: nip05Result.error,
              cached: nip05Result.cached
            }, ...results];
          }
          if (results.length === 0) {
            showStatus('No linked identity claims found for this account.', 'error');
            return;
          }
          hideStatus();
          renderResults(results, pubkey);
          return;
        }

        // Parse i-tags into claims
        const claims = iTags.map(tag => {
          const [platform, ...rest] = tag[1].split(':');
          const identity = rest.join(':');
          return { platform, identity, proof: tag[2], pubkey };
        }).filter(c => ['github','twitter','mastodon','telegram','bluesky','discord'${extraLookupPlatforms}].includes(c.platform))
          .filter(c => !storedKeys.has(storedKey(c)));

        if (claims.length === 0) {
          if (storedResults.length > 0) {
            hideStatus();
            renderResults(storedResults, pubkey);
          } else {
            showStatus('Profile has identity tags but none for supported platforms.', 'error');
          }
          return;
        }

        showStatus('Verifying ' + claims.length + ' identity claim(s)...', 'loading');

        // Batch verify
        const verifyResp = await fetch(API + '/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ claims }),
        });
        const verifyData = await verifyResp.json();

        if (verifyData.error) {
          showStatus('Verification error: ' + verifyData.error, 'error');
          return;
        }

        // Also check NIP-05
        const content = legacyProfile ? tryParseJSON(legacyProfile.content) : null;
        let allResults = storedResults.concat(verifyData.results || []);
        if (content && content.nip05) {
          const nip05Resp = await fetch(API + '/nip05/verify?name=' + encodeURIComponent(content.nip05) + '&pubkey=' + pubkey);
          const nip05Result = await nip05Resp.json();
          allResults = [{
            platform: 'nip05',
            identity: content.nip05,
            verified: nip05Result.verified,
            error: nip05Result.error,
            cached: nip05Result.cached
          }, ...allResults];
        }

        hideStatus();
        renderResults(allResults, pubkey);

      } catch (e) {
        showStatus(e.message || 'Unknown error', 'error');
      }
    }

    function tryParseJSON(s) {
      try { return JSON.parse(s); } catch { return null; }
    }

    function fetchIdentityEvent(relayUrl, pubkey) {
      return fetchEventByKind(relayUrl, pubkey, 10011);
    }

    function fetchProfileLegacy(relayUrl, pubkey) {
      return fetchEventByKind(relayUrl, pubkey, 0);
    }

    function fetchEventByKind(relayUrl, pubkey, kind) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 8000);
        let ws;
        try {
          ws = new WebSocket(relayUrl);
        } catch { reject(new Error('ws failed')); return; }
        const subId = 'lookup_' + Math.random().toString(36).slice(2, 8);
        ws.onopen = () => {
          ws.send(JSON.stringify(['REQ', subId, { kinds: [kind], authors: [pubkey], limit: 1 }]));
        };
        ws.onmessage = (msg) => {
          try {
            const data = JSON.parse(msg.data);
            if (data[0] === 'EVENT' && data[1] === subId) {
              clearTimeout(timeout);
              ws.send(JSON.stringify(['CLOSE', subId]));
              ws.close();
              resolve(data[2]);
            } else if (data[0] === 'EOSE' && data[1] === subId) {
              clearTimeout(timeout);
              ws.close();
              resolve(null);
            }
          } catch {}
        };
        ws.onerror = () => { clearTimeout(timeout); reject(new Error('ws error')); };
      });
    }

    // --- Manage / Remove linked verifications ---

    async function connectionsApiFetch(path, options = {}) {
      const session = await getValidKeycastSession();
      if (!session || !session.accessToken) {
        throw new Error('Managing connections needs a login.divine.video session. Sign in above first.');
      }
      return fetch(API + path, {
        ...options,
        headers: {
          'Authorization': 'Bearer ' + session.accessToken,
          ...(options.headers || {}),
        },
      });
    }

    async function loadLinkedVerifications() {
      const container = document.getElementById('manage-links-container');
      container.textContent = 'Loading...';
      clearStatus('manage-status');

      try {
        const pubkey = await getActivePubkey();
        if (!pubkey) {
          container.textContent = 'Connect a signer first to see your linked accounts.';
          return;
        }

        const resp = await fetch(API + '/verified/' + pubkey);
        if (!resp.ok) throw new Error('Could not load your verified links.');
        const data = await resp.json();
        const verifications = (data && Array.isArray(data.verifications)) ? data.verifications : [];
        if (verifications.length === 0) {
          container.textContent = 'No linked verifications found.';
          return;
        }

        renderLinkedVerifications(verifications, container);
      } catch (e) {
        container.textContent = '';
        setStatus('manage-status', e.message || 'Failed to load linked verifications.', 'error');
      }
    }

    // Renders manage table using DOM methods for safety. All user data goes through
    // textContent (platform, identity, method come from the user's own verified rows).
    function renderLinkedVerifications(verifications, container) {
      container.textContent = '';
      const table = document.createElement('table');
      table.style.cssText = 'width:100%;border-collapse:collapse;font-size:0.9rem;';

      const thead = document.createElement('thead');
      const headerRow = document.createElement('tr');
      headerRow.style.cssText = 'border-bottom:2px solid rgba(7,36,27,0.2);text-align:left;';
      ['Platform', 'Identity', 'Method', ''].forEach(text => {
        const th = document.createElement('th');
        th.style.padding = '0.5rem';
        th.textContent = text;
        headerRow.appendChild(th);
      });
      thead.appendChild(headerRow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      for (const row of verifications) {
        const platform = row.platform || '';
        const identity = row.identity || '';
        const method = row.method || '';

        const tr = document.createElement('tr');
        tr.style.cssText = 'border-bottom:1px solid rgba(7,36,27,0.12);';

        const tdPlatform = document.createElement('td');
        tdPlatform.style.padding = '0.5rem';
        tdPlatform.textContent = platform;
        tr.appendChild(tdPlatform);

        const tdIdentity = document.createElement('td');
        tdIdentity.style.padding = '0.5rem';
        tdIdentity.textContent = identity;
        tr.appendChild(tdIdentity);

        const tdMethod = document.createElement('td');
        tdMethod.style.padding = '0.5rem';
        tdMethod.textContent = method === 'oauth' ? 'connected account' : 'public proof post';
        tr.appendChild(tdMethod);

        const tdAction = document.createElement('td');
        tdAction.style.padding = '0.5rem';
        if (method === 'oauth') {
          const removeBtn = document.createElement('button');
          removeBtn.className = 'verify-btn';
          removeBtn.style.cssText = 'background:#e53e3e;color:white;padding:0.3rem 0.75rem;font-size:0.85rem;';
          removeBtn.textContent = 'Remove';
          removeBtn.addEventListener('click', () => confirmRemoveVerification(platform, identity));
          tdAction.appendChild(removeBtn);
        } else {
          // Day-one revocation is disconnect-only: proof-post rows are durable
          // until an explicit re-verify replaces them.
          const note = document.createElement('span');
          note.style.cssText = 'font-size:0.8rem;color:rgba(7,36,27,0.55);';
          note.textContent = 'Verified by public post; re-verify to replace.';
          tdAction.appendChild(note);
        }
        tr.appendChild(tdAction);

        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      container.appendChild(table);
    }

    function confirmRemoveVerification(platform, identity) {
      const dialog = document.getElementById('remove-confirm-dialog');
      document.getElementById('remove-confirm-claim').textContent = platform + ':' + identity;
      dialog.dataset.platform = platform;
      dialog.dataset.identity = identity;
      dialog.style.display = 'block';
    }

    function cancelRemove() {
      document.getElementById('remove-confirm-dialog').style.display = 'none';
    }

    async function executeRemoveVerification() {
      const dialog = document.getElementById('remove-confirm-dialog');
      const platform = dialog.dataset.platform;
      const identity = dialog.dataset.identity;
      dialog.style.display = 'none';

      setStatus('manage-status', 'Removing verification...', 'loading');

      try {
        // Map platform -> connection_id so the disconnect (and badge revoke) is exact.
        const listResp = await connectionsApiFetch('/connections');
        if (!listResp.ok) throw new Error('Could not load your connected accounts.');
        const listData = await listResp.json();
        const rows = (listData && Array.isArray(listData.connections)) ? listData.connections : [];
        const matches = rows.filter(c => c && c.platform === platform);
        const exact = matches.find(c => String(c.externalAccountName || '').toLowerCase() === identity.toLowerCase()) || matches[0];
        if (!exact) {
          throw new Error('No connected ' + platform + ' account found to disconnect.');
        }

        const delResp = await connectionsApiFetch('/connections/' + platform + '/' + exact.id, { method: 'DELETE' });
        if (!delResp.ok) throw new Error('Disconnect did not complete.');

        setStatus('manage-status', 'Connection removed; the badge is revoked.', 'ok');
        await loadLinkedVerifications();
      } catch (e) {
        setStatus('manage-status', e.message || 'Could not remove verification.', 'error');
      }
    }

    // Verify Here wiring
    document.getElementById('sign-out-btn').addEventListener('click', signOutSigner);
    document.getElementById('connect-nostr-btn').addEventListener('click', connectNostrSigner);
    document.getElementById('connect-keycast-btn').addEventListener('click', async () => {
      clearStatus('verify-login-status');
      try {
        setButtonLoading('connect-keycast-btn', true, 'Opening...');
        await connectKeycastSigner();
      } catch (e) {
        setStatus('verify-login-status', e.message || 'Could not open login.divine.video.', 'error');
      } finally {
        setButtonLoading('connect-keycast-btn', false, '');
      }
    });
    document.getElementById('connect-bunker-btn').addEventListener('click', connectBunkerSigner);
    document.getElementById('start-nostr-connect-btn').addEventListener('click', startNostrConnect);
    document.getElementById('copy-nostr-connect-btn').addEventListener('click', copyNostrConnectUri);
    document.getElementById('cancel-nostr-connect-btn').addEventListener('click', cancelNostrConnect);
    ${
      oauthPlatformOptions
        ? `document.getElementById('oauth-platform-select').addEventListener('change', updateOAuthInputs);
    document.getElementById('oauth-start-btn').addEventListener('click', startOAuthVerification);`
        : '// Quick Connect controls are not rendered when no OAuth provider is configured.'
    }
    document.getElementById('proof-platform-select').addEventListener('change', updateProofInputs);
    bindVerifyPlatformPicker();
    document.getElementById('proof-verify-btn').addEventListener('click', verifySingleHere);
    document.getElementById('publish-kind0-btn').addEventListener('click', publishIdentityTagToNostr);
    document.getElementById('verify-pubkey-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') startOAuthVerification();
    });
    document.getElementById('proof-identity-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') verifySingleHere();
    });
    document.getElementById('proof-proof-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') verifySingleHere();
    });
    document.getElementById('bunker-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') connectBunkerSigner();
    });
    document.getElementById('verify-pubkey-input').addEventListener('blur', () => {
      const value = document.getElementById('verify-pubkey-input').value.trim();
      if (value) localStorage.setItem('verifyer_account_input', value);
    });
    const savedAccountInput = localStorage.getItem('verifyer_account_input');
    if (savedAccountInput) {
      document.getElementById('verify-pubkey-input').value = savedAccountInput;
    }
    updateOAuthInputs();
    updateProofInputs();
    handleOAuthCallbackMessage();
    updateSignerSummary();
    (async () => {
      const handledKeycast = await maybeHandleKeycastCallback();
      if (!handledKeycast) {
        applyLoginQueryHint();
        await restoreKeycastSession();
      }
      updateSignerSummary();
    })();

    // Lookup tool Enter key
    document.getElementById('lookup-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doLookup();
    });

    // When loaded inside a Divine-hosted iframe, the postMessage shim above
    // installs window.nostr unconditionally, so trigger the standard signer
    // connect flow without waiting for a button click.
    if (window.__divineEmbedded) {
      (async () => {
        try {
          await connectNostrSigner();
        } catch (e) {
          // Fall through silently — the user can still click the connect
          // button if the auto-connect fails for any reason.
        }
      })();
    }
    </script>

    <footer>
      <p>Part of <a href="https://divine.video">divine.video</a>. Open source. Own what you make.</p>
      <p><a href="https://divine.video/privacy">Privacy Policy</a> &middot; <a href="https://divine.video/terms">Terms of Service</a></p>
    </footer>
  </div>
</body>
</html>`
}

export const landing = new Hono<{ Bindings: Env }>()

// The page carries all of its JavaScript inline, so a cached copy is a cached
// build. Without an explicit policy browsers apply heuristic freshness and can
// hold a stale page for hours, which turns every deploy into a support thread
// about bugs that are already fixed. `no-cache` permits storing the page but
// forces revalidation on every load, so a deploy is visible immediately.
//
// There is deliberately no ETag. Cloudflare strips the `ETag` response header
// from this worker's responses at the edge — confirmed by serving the same
// build with a mirrored `X-Page-ETag`: the mirror arrives, `ETag` does not.
// It is dropped by header name, not because of its strength or the presence of
// `must-revalidate`; both variants were tested. Computing one would cost a
// hash of the whole page on every request to produce a header no browser will
// ever see, so revalidation is a plain 200 rather than a 304.
landing.get('/', (c) => {
  const accept = c.req.header('accept') || ''
  if (accept.includes('application/json') && !accept.includes('text/html')) {
    return c.json({ service: 'divine-connections', version: '1.0.0' })
  }

  c.header('Cache-Control', 'no-cache, must-revalidate')
  return c.html(renderLandingPage(c.env, new URL(c.req.url).origin))
})
