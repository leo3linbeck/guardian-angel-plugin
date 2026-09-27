#!/usr/bin/env node
/**
 * Guardian Angel — Claude Code SessionStart hook
 *
 * Makes setup a single click. If this machine is not linked:
 *   1. a Set up page token in the plugin's `link_token` option is redeemed, or
 *   2. otherwise the device flow starts on its own: the browser opens at the Link
 *      page with the code filled in, the principal clicks Approve, and a detached
 *      poller saves the credentials.
 * The outcome is shown to the principal (systemMessage) and given to Claude as
 * context. A machine that is already linked says nothing.
 */
'use strict';
const fs = require('fs');

function say(message) {
	process.stdout.write(JSON.stringify({
		systemMessage: message,
		hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: message },
	}));
}

(async () => {
	try { fs.readFileSync(0, 'utf8'); } catch { /* stdin optional */ }
	let link;
	try { link = require('../lib/link'); } catch { return; }

	const opt = await link.linkFromOption();
	if (opt.status === 'already_linked') return;
	if (opt.status === 'linked') return say(`Guardian Angel: linked this machine as "${opt.creds.device_name}". Every tool call is now judged.`);
	const optionFailed = opt.status === 'failed' ? ` (the link token did not work: ${opt.detail})` : '';

	const r = await link.startDeviceLink();
	switch (r.status) {
		case 'already_linked':
			return;
		case 'started':
			return say(`Guardian Angel: to finish setup, click Approve in the browser${r.opened ? ' tab that just opened' : ''}: ${r.url}${optionFailed}. Until this machine is linked, escalated tool calls are put to you.`);
		case 'waiting':
			return say(`Guardian Angel: still waiting for you to approve this machine at ${r.url}.`);
		default:
			return say(`Guardian Angel could not start linking this machine (${r.detail})${optionFailed}. Run /guardian-angel:link with a token from ${link.optionServiceUrl()}/setup.`);
	}
})().catch(() => {}).finally(() => process.exit(0));
