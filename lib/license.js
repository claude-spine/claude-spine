'use strict';
// LICENSE — offline, signed, no server.
//
// A license key here is a payload plus an ed25519 signature over it. The public key is
// baked into this file; the private key never leaves my machine. Verification is local
// crypto, which means:
//
//   · no license server to host, pay for, or keep up
//   · works inside CI, behind a corporate firewall, on an air-gapped runner
//   · no phone-home, so nothing to explain to a security review
//   · a customer's build never breaks because my infrastructure had a bad night
//
// The tradeoff is honest: a signed offline key cannot be revoked. That is the correct
// trade for a dev tool at this price. Anyone determined enough to patch out a check was
// never going to pay, and building revocation infrastructure to stop them costs more than
// they represent.

const crypto = require('crypto');

// Public verification key. Safe to publish — it cannot sign, only check.
const PUBLIC_KEY_SPKI_B64 = 'MCowBQYDK2VwAyEA75lukVf5mY6e6FzQovKwOXZpgQI1j/VKptOJBUiqFCM=';

/**
 * Keys look like:  CS1.<base64url(payload)>.<base64url(signature)>
 * payload = { sub, plan, iat, exp?, seats? }
 */
function parse(key) {
  const parts = String(key || '').trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'CS1') return { ok: false, reason: 'malformed key' };

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'unreadable payload' };
  }

  if (PUBLIC_KEY_SPKI_B64 === 'PLACEHOLDER_PUBLIC_KEY') {
    return { ok: false, reason: 'build error: no verification key compiled in' };
  }

  let verified = false;
  try {
    const pub = crypto.createPublicKey({
      key: Buffer.from(PUBLIC_KEY_SPKI_B64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    verified = crypto.verify(null, Buffer.from(parts[1]), pub, Buffer.from(parts[2], 'base64url'));
  } catch {
    return { ok: false, reason: 'signature check failed' };
  }
  if (!verified) return { ok: false, reason: 'invalid signature' };

  // Expiry is checked, but note what it does NOT do: an expired key still verifies as
  // genuine, so a lapsed subscription degrades to the free tier rather than hard-failing
  // someone's pipeline at 3am. Breaking a paying customer's CI over a billing date is how
  // you lose the customer, not how you collect.
  const expired = payload.exp && Date.now() > payload.exp;

  return { ok: true, payload, expired, plan: expired ? 'free' : payload.plan || 'pro' };
}

/** Where a key can live, in priority order. */
function find(repoRoot = process.cwd()) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  if (process.env.CLAUDE_SPINE_KEY) return process.env.CLAUDE_SPINE_KEY;

  const candidates = [
    path.join(repoRoot, '.claude', 'spine-license'),
    path.join(os.homedir(), '.claude-spine-license'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8').trim();
    } catch {}
  }
  return null;
}

/** The one call the CLI makes. Never throws; free tier is always a valid answer. */
function check(repoRoot) {
  const key = find(repoRoot);
  if (!key) return { plan: 'free', licensed: false, reason: 'no key found' };
  const res = parse(key);
  if (!res.ok) return { plan: 'free', licensed: false, reason: res.reason };
  return {
    plan: res.plan,
    licensed: res.plan !== 'free',
    expired: Boolean(res.expired),
    sub: res.payload.sub,
    seats: res.payload.seats || 1,
  };
}

module.exports = { check, parse, find, PUBLIC_KEY_SPKI_B64 };
