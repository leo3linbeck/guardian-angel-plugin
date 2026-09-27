#!/usr/bin/env node
/**
 * Guardian Angel — Claude Code PreToolUse hook (service edition)
 *
 * THE PRINCIPAL IS SACROSANCT. Every tier gives one of three verdicts:
 *   APPROVE    the tool call proceeds
 *   REJECT     it is refused, with the reason
 *   ESCALATE   it moves up: System 0 (here) → System 1 → System 2 (service) → you
 *
 * This hook holds only System 0 — the local reflex — plus edge redaction and a
 * thin client. Calls the reflex clears never leave this machine. Anything it
 * escalates is redacted, normalized (guardian-angel/spec/normalized-call.v1)
 * and sent to the service, which runs the intelligent tiers and returns a
 * verdict.
 *
 * Fail closed, always:
 *   - the watchdog answers before Claude Code's hook timeout, because a hook
 *     that times out lets the call PROCEED;
 *   - the service being unreachable, or this machine not being linked, hands
 *     the decision to you (`ask`), never to the agent.
 *
 * Hook outputs:
 *   APPROVE    →  permissionDecision:"allow"
 *   REJECT     →  permissionDecision:"deny",  reason: GUARDIAN_ANGEL_REJECT|<tier>|<reason>
 *   ESCALATE   →  permissionDecision:"ask",   reason: GUARDIAN_ANGEL_ESCALATE|<escalation_id>|<reason>
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HOOK_TIMEOUT_S = 60;                       // must match hooks/hooks.json
const WATCHDOG_MS = (HOOK_TIMEOUT_S - 5) * 1000; // answer before Claude Code gives up
const EVALUATE_TIMEOUT_MS = 45_000;

// ── Output ─────────────────────────────────────────────────────────────
let answered = false;
function respond(decision, reason) {
	if (answered) return;
	answered = true;
	process.stdout.write(JSON.stringify({
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: decision,
			...(reason ? { permissionDecisionReason: reason } : {}),
		},
	}));
}
const exit = (code = 0) => setImmediate(() => process.exit(code));

let log = () => {};
try { ({ log } = require('../lib/log')); } catch { /* logging is optional */ }

function toPrincipal(reason, extra = []) {
	log(['[GUARDIAN ANGEL]', `Timestamp: ${new Date().toISOString()}`, ...extra, 'DECISION: Principal', `RATIONALE: ${reason}`]);
	respond('ask', `GUARDIAN_ANGEL_ESCALATE|internal|${reason}`);
	exit(0);
}

// ── Watchdog ───────────────────────────────────────────────────────────
const watchdog = setTimeout(() => toPrincipal('Guardian Angel could not finish evaluating in time — your decision'), WATCHDOG_MS);
watchdog.unref();

// ── Modules ────────────────────────────────────────────────────────────
let system0, contextClient, redact, normalize, core, client, state, transcript;
try {
	system0 = require('../lib/core/system0');
	contextClient = require('../lib/core/context-client');
	redact = require('../lib/core/redact');
	normalize = require('../lib/core/normalize');
	core = require('../lib/core/version');
	client = require('../lib/client');
	state = require('../lib/state');
	transcript = require('../lib/transcript');
} catch (err) {
	toPrincipal(`Guardian Angel plugin is incomplete (${err.message}) — reinstall the plugin. Your decision`);
}

// ── Input ──────────────────────────────────────────────────────────────
let input;
try {
	input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch (err) {
	toPrincipal(`Guardian Angel could not read the tool call (${err.message}) — your decision`);
}
const {
	tool_name: toolName = '',
	tool_input: toolInput = {},
	session_id: sessionId = 'unknown',
	transcript_path: transcriptPath = null,
	cwd: callCwd = null,
} = input || {};

const sessionTag = String(sessionId).slice(0, 8);
const header = () => ['[GUARDIAN ANGEL]', `Timestamp: ${new Date().toISOString()}`, `Session: ${sessionTag}`, `Action: ${toolName}`];

function approve(by, reason) {
	log([...header(), `SYSTEM 0: ${trail.system0}`, `DECISION: Approve`, `RESOLVED BY: ${by}`, `RATIONALE: ${reason}`]);
	respond('allow');
	exit(0);
}
function reject(by, reason) {
	log([...header(), `SYSTEM 0: ${trail.system0}`, `DECISION: Reject`, `RESOLVED BY: ${by}`, `RATIONALE: ${reason}`]);
	respond('deny', `GUARDIAN_ANGEL_REJECT|${by}|Guardian Angel (${by}) rejected this action: ${reason}`);
	exit(0);
}
function escalateToPrincipal(escalationId, reason, extra = []) {
	log([...header(), `SYSTEM 0: ${trail.system0}`, ...extra, `DECISION: Principal`, `ESCALATION: ${escalationId}`, `RATIONALE: ${reason}`]);
	respond('ask', `GUARDIAN_ANGEL_ESCALATE|${escalationId}|${reason}`);
	exit(0);
}

const trail = { system0: 'ESCALATE [unrecognised]' };

(async () => {
	// ── SYSTEM 0 — reflex (local, always up) ─────────────────────────────
	const reflex = system0.checkSystem0(toolName, toolInput);
	trail.system0 = `${reflex.verdict} [${reflex.gate}]: ${reflex.reason}`;
	if (reflex.verdict === 'APPROVE') return approve('System 0', reflex.reason);
	if (reflex.verdict === 'REJECT') return reject('System 0', reflex.reason);

	// ── Context: what would actually run, and where does it sit? ─────────
	const reflexFlags = [...reflex.flags];
	const cwd = callCwd || process.cwd();
	const { files: resolvedFiles, unresolved } = contextClient.resolveReferencedFiles(toolName, toolInput, cwd);
	if (unresolved.length > 0) {
		reflexFlags.push(`the command runs script(s) whose contents could not be read: ${unresolved.join(', ')}`);
	}
	const download = await contextClient.assessDownloads(toolName, toolInput, cwd);
	if (download.verdict === 'REJECT') {
		trail.system0 = `REJECT [download-exceeds-disk]: ${download.reason}`;
		return reject('System 0', download.reason);
	}
	reflexFlags.push(...download.flags);

	const { request, history } = transcript.readTranscript(transcriptPath, redact.redactSecrets);

	// ── Edge redaction + normalization (nothing else leaves this machine) ─
	const normalized = normalize.buildNormalizedCall({
		toolName, toolInput, principalRequest: request, history, cwd,
		reflexFlags,
		fileMeta: system0.resolveFileMetadata(toolName, toolInput, cwd),
		writeTargets: system0.resolveBashWriteTargets(toolName, toolInput, cwd),
		resolvedFiles, unresolved, download,
		harness: 'claude-code', clientVersion: client.CLIENT_VERSION, coreSha: core.CORE_SHA, sessionId: String(sessionId),
	}, { redact: true });

	// ── Service: System 1 → System 2 → (escalation) ──────────────────────
	let creds = client.loadCredentials();
	let linkHint = 'run /guardian-angel:link <token> with a token from the Set up page';
	if (!creds) {
		// In-harness setup: a Set up page token in the plugin option, else the automatic browser link.
		try {
			const link = require('../lib/link');
			const r = await link.linkFromOption();
			if (r.status === 'linked') creds = r.creds;
			else {
				const d = await link.startDeviceLink();
				if (d.status === 'started' || d.status === 'waiting') linkHint = `click Approve at ${d.url}`;
			}
		} catch { /* fall through */ }
	}
	if (!creds) {
		return toPrincipal(`Guardian Angel is not linked on this machine yet — ${linkHint}. Until then, your decision`, [`SYSTEM 0: ${trail.system0}`]);
	}
	const result = await client.evaluate(creds, normalized, { timeoutMs: EVALUATE_TIMEOUT_MS });
	if (!result.ok) {
		const why = {
			relogin: 'this machine\'s Guardian Angel link was revoked or expired — run `ga login`',
			suspended: 'your Guardian Angel account is not active',
			unreachable: `Guardian Angel service unreachable (${result.detail})`,
			rate_limited: 'Guardian Angel rate limit reached for this minute',
			rejected_call: `Guardian Angel refused the call format (${result.detail}); the plugin may need updating`,
			server_error: `Guardian Angel service error (${result.detail})`,
		}[result.kind] || result.detail;
		// Fail closed to the human, never to the agent (alpha decision #10).
		return toPrincipal(`${why} — your decision`, [`SYSTEM 0: ${trail.system0}`]);
	}

	const v = result.verdict;
	const tierName = { system1: 'System 1', system2: 'System 2', service: 'Guardian Angel' }[v.tier] || v.tier;
	const extra = [`VERDICT: ${v.decision} by ${v.tier} (${v.verdict_id})`, `PROMPT: ${v.prompt_version}`];
	if (v.decision === 'APPROVE') { log([...header(), `SYSTEM 0: ${trail.system0}`, ...extra]); return approve(tierName, v.reason); }
	if (v.decision === 'REJECT') { log([...header(), `SYSTEM 0: ${trail.system0}`, ...extra]); return reject(tierName, v.reason); }

	// ESCALATE — terminal mode: Claude Code asks you here; the post-hook reports your answer.
	if (v.escalation_id && normalized.call_id) {
		try { state.addPending(normalized.call_id, { escalationId: v.escalation_id, toolName, sessionId: String(sessionId) }); } catch { /* still ask */ }
	}
	return escalateToPrincipal(v.escalation_id || 'none', v.reason, extra);
})().catch((err) => {
	toPrincipal(`Guardian Angel internal error (${err && err.message}) — your decision`);
});
