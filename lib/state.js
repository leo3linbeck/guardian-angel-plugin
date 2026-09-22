'use strict';

/**
 * Pending escalations on this machine, keyed by call_id. Written by the
 * PreToolUse hook when it returns `ask`; read by the PostToolUse hook, which
 * fires only if the tool actually ran — i.e. the principal approved — and
 * reports that answer to the service. An entry nobody consumes lapses after
 * the escalation TTL.
 */
const fs = require('fs');
const path = require('path');
const { statePath } = require('./paths');

const PENDING_TTL_MS = 10 * 60 * 1000;

function load() {
	try {
		const s = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
		return { pending: (s && s.pending) || {} };
	} catch {
		return { pending: {} };
	}
}

function save(state) {
	fs.mkdirSync(path.dirname(statePath()), { recursive: true, mode: 0o700 });
	fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

function prune(state, now = Date.now()) {
	let changed = false;
	for (const [k, p] of Object.entries(state.pending)) {
		if (!p || now > p.expiresAt) { delete state.pending[k]; changed = true; }
	}
	return changed;
}

function addPending(callId, entry, now = Date.now()) {
	const state = load();
	prune(state, now);
	state.pending[callId] = { ...entry, createdAt: now, expiresAt: now + PENDING_TTL_MS };
	save(state);
}

function takePending(callId, now = Date.now()) {
	const state = load();
	prune(state, now);
	const p = state.pending[callId] || null;
	if (p) { delete state.pending[callId]; save(state); }
	return p;
}

module.exports = { load, save, addPending, takePending, prune, PENDING_TTL_MS };
