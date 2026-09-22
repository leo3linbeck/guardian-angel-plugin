// VENDORED from conscience-research/tests/harness/normalize.js by scripts/sync-core.mjs — do not edit here.
'use strict';

/**
 * Guardian Angel — NormalizedCall v1
 *
 * The one object a client adapter sends the service for a call System 0
 * escalated (guardian-angel/spec/normalized-call.v1.schema.json). Two functions:
 *
 *   buildNormalizedCall(parts, opts)   client side — assemble the wire object from the
 *                                      facts gathered next to System 0. With
 *                                      opts.redact (the default for anything leaving
 *                                      the machine) every string is redacted and
 *                                      clipped at the edge.
 *   callFromNormalized(nc, prompt)     service side — turn the wire object back into
 *                                      the `call` that system1.evaluateSystem1 and
 *                                      context-server.buildSystem2UserMessage consume,
 *                                      so the tiers see exactly what they see today.
 *
 * Round trip without redaction is lossless for everything the tiers read; the
 * trial harness relies on that to stay byte-identical to its validated runs.
 *
 * This file is the single source of truth: the trial harness, the client adapter
 * and the service all require it.
 */

const crypto = require('crypto');
const { sanitize } = require('./redact');

const MAX_HISTORY  = 12;
const MAX_FILES    = 4;
const MAX_REQUEST  = 2000;

function callId(toolName, toolInput) {
  const normalized = JSON.stringify({ toolName, params: toolInput || {} }, Object.keys(toolInput || {}).sort());
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

const fileFacts = (m) => m && ({
  path:               m.path,
  exists:             m.file_exists,
  in_git_repo:        m.in_git_repo,
  git_tracked:        m.git_tracked,
  has_staged_changes: m.has_staged_changes,
  looks_sensitive:    m.is_sensitive,
  ...(m.sensitive_reason ? { sensitive_reason: m.sensitive_reason } : {}),
});

const fileMetaFrom = (f) => f && ({
  path:               f.path,
  file_exists:        f.exists,
  in_git_repo:        f.in_git_repo,
  git_tracked:        f.git_tracked,
  has_staged_changes: f.has_staged_changes,
  is_sensitive:       f.looks_sensitive,
  ...(f.sensitive_reason ? { sensitive_reason: f.sensitive_reason } : {}),
});

/**
 * @param {object} parts  { toolName, toolInput, principalRequest, history, cwd, reflexFlags,
 *                          fileMeta, writeTargets, resolvedFiles, unresolved, download,
 *                          harness, clientVersion, coreSha, sessionId }
 * @param {{redact?: boolean}} opts
 */
function buildNormalizedCall(parts, opts = {}) {
  const redact = opts.redact !== false;
  const clean  = (v) => (redact ? sanitize(v) : v);
  const {
    toolName, toolInput = {}, principalRequest, history, cwd, reflexFlags,
    fileMeta, writeTargets, resolvedFiles, unresolved, download,
    harness = 'unknown', clientVersion, coreSha, sessionId,
  } = parts;

  const nc = {
    v: 1,
    harness,
    ...(clientVersion ? { client_version: clientVersion } : {}),
    ...(coreSha ? { core_sha: coreSha } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    call_id: callId(toolName, toolInput),
    tool_name: toolName,
    tool_input: clean(toolInput),
  };

  if (principalRequest && String(principalRequest).trim()) {
    nc.principal_request = clean(String(principalRequest).trim().slice(0, MAX_REQUEST));
  }
  if (Array.isArray(history) && history.length > 0) {
    nc.history = history.slice(-MAX_HISTORY).map(h => ({
      tool: h.tool,
      summary: clean(String(h.summary).slice(0, 200)),
      ...(h.verdict ? { verdict: h.verdict } : {}),
      ...(h.output ? { output: clean(String(h.output).slice(0, 200)) } : {}),
    }));
  }
  if (cwd) nc.cwd = cwd;
  if (Array.isArray(reflexFlags) && reflexFlags.length > 0) nc.reflex_flags = reflexFlags.map(clean);
  if (fileMeta) nc.file_meta = fileFacts(fileMeta);
  if (Array.isArray(writeTargets) && writeTargets.length > 0) nc.write_targets = writeTargets.map(fileFacts);
  if (Array.isArray(resolvedFiles) && resolvedFiles.length > 0) {
    nc.referenced_files = resolvedFiles.slice(0, MAX_FILES).map(f => ({ path: f.filePath, content: clean(f.content) }));
    if (resolvedFiles.length > MAX_FILES) nc.referenced_files_omitted = resolvedFiles.length - MAX_FILES;
  }
  if (Array.isArray(unresolved) && unresolved.length > 0) nc.unresolved_files = unresolved;
  if (download && ((download.flags && download.flags.length) || (download.downloads && download.downloads.length))) {
    nc.download = {
      ...(download.flags && download.flags.length ? { flags: download.flags } : {}),
      ...(download.downloads && download.downloads.length ? { downloads: download.downloads } : {}),
    };
  }
  return nc;
}

/** The `call` object the tiers consume today, rebuilt from the wire object. */
function callFromNormalized(nc, frameworkPrompt) {
  return {
    toolName:         nc.tool_name,
    toolInput:        nc.tool_input || {},
    principalRequest: nc.principal_request || '',
    history:          Array.isArray(nc.history) ? nc.history.map(h => ({ tool: h.tool, summary: h.summary, verdict: h.verdict, output: h.output || null })) : [],
    reflexFlags:      Array.isArray(nc.reflex_flags) ? [...nc.reflex_flags] : [],
    fileMeta:         nc.file_meta ? fileMetaFrom(nc.file_meta) : null,
    writeTargets:     Array.isArray(nc.write_targets) ? nc.write_targets.map(fileMetaFrom) : [],
    resolvedFiles:    Array.isArray(nc.referenced_files) ? nc.referenced_files.map(f => ({ filePath: f.path, content: f.content })) : [],
    frameworkPrompt:  frameworkPrompt || null,
  };
}

module.exports = { buildNormalizedCall, callFromNormalized, callId, MAX_HISTORY, MAX_FILES, MAX_REQUEST };
