'use strict';

/**
 * Per-machine plugin state (state.json in the config dir):
 *
 *   pending      escalations keyed by call_id. Written by the PreToolUse hook when it
 *                returns `ask`; read by the PostToolUse hook, which fires only if the tool
 *                actually ran — i.e. the principal approved — and reports that answer.
 *   linkPending  an automatic device link in progress: the code shown in the browser,
 *                its expiry, and the background poller's pid, so a second session or
 *                tool call does not open another browser tab.
 */
const fs = require('fs');
const path = require('path');
const { statePath } = require('./paths');

const PENDING_TTL_MS = 10 * 60 * 1000;

function load() {
	try {
		const s = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
		return { pending: (s && s.pending) || {}, linkPending: (s && s.linkPending) || null };
	} catch {
		return { pending: {}, linkPending: null };
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

function getLinkPending() {
	return load().linkPending;
}

function setLinkPending(value) {
	const state = load();
	state.linkPending = value;
	save(state);
}

module.exports = { load, save, addPending, takePending, prune, getLinkPending, setLinkPending, PENDING_TTL_MS };
