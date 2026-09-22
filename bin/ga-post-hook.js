#!/usr/bin/env node
/**
 * Guardian Angel — Claude Code PostToolUse hook
 *
 * Fires only after a tool actually ran. If that call is one the PreToolUse
 * hook escalated to you, its running means you approved it at the prompt —
 * report that to the service so the audit record carries your answer. Never
 * blocks anything and never changes a decision.
 */
'use strict';
const fs = require('fs');

(async () => {
	let input;
	try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return; }
	const { tool_name: toolName = '', tool_input: toolInput = {} } = input || {};
	let normalize, state, client;
	try {
		normalize = require('../lib/core/normalize');
		state = require('../lib/state');
		client = require('../lib/client');
	} catch { return; }
	const pending = state.takePending(normalize.callId(toolName, toolInput));
	if (!pending) return;
	const creds = client.loadCredentials();
	if (!creds) return;
	await client.reportOutcome(creds, pending.escalationId, 'approved', { timeoutMs: 5000 });
})().finally(() => process.exit(0));
