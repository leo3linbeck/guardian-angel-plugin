// VENDORED from conscience-research/tests/harness/redact.js by scripts/sync-core.mjs — do not edit here.
'use strict';

/**
 * Guardian Angel — secret redaction
 *
 * Anything that leaves the principal's machine passes through here first, and
 * the service runs it again on ingest (defense in depth). Obvious secrets are
 * replaced with a marker so a judge still sees THAT a secret is present without
 * receiving it. Long fields are clipped. Pattern-based and best-effort, not a
 * guarantee.
 *
 * Pure: no filesystem, no network. Shared by the client adapter (edge redaction
 * before transmission) and the service (re-redaction on ingest).
 *
 * This file is the single source of truth. The clinical-trial harness requires
 * it (via system1.js); guardian-angel/install.js copies it to ~/.claude/hooks/ga-lib/.
 */

const MAX_FIELD_CHARS = 6_000;   // per string field

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /(\b(?:authorization|bearer)\b["']?\s*[:=]?\s*["']?(?:bearer\s+)?)[A-Za-z0-9._~+\/-]{20,}/gi,
  /(\b(?:api[_-]?key|secret|token|passwd|password)\b["']?\s*[:=]\s*["']?)[^\s"']{12,}/gi,
];

function redactSecrets(text) {
  let out = String(text);
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix) =>
      (typeof prefix === 'string' ? prefix : '') + '[REDACTED_SECRET]');
  }
  return out;
}

function clip(text) {
  const s = String(text);
  if (s.length <= MAX_FIELD_CHARS) return s;
  const half = Math.floor(MAX_FIELD_CHARS / 2);
  return `${s.slice(0, half)}\n[… ${s.length - MAX_FIELD_CHARS} characters omitted …]\n${s.slice(-half)}`;
}

function sanitize(value) {
  if (typeof value === 'string') return clip(redactSecrets(value));
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitize(v);
    return out;
  }
  return value;
}

module.exports = { redactSecrets, clip, sanitize, MAX_FIELD_CHARS, SECRET_PATTERNS };
