#!/usr/bin/env node
/**
 * Guardian Angel — Claude Code SessionStart hook
 *
 * If this machine is not linked and the plugin's `link_token` option holds a
 * token from the Set up page, redeem it now, so the whole setup happened inside
 * Claude Code: one /plugin install, one pasted token. Whatever the outcome, say
 * so in one line; SessionStart output becomes context for the session.
 */
'use strict';
const fs = require('fs');

(async () => {
	try { fs.readFileSync(0, 'utf8'); } catch { /* stdin optional */ }
	let link;
	try { link = require('../lib/link'); } catch { return; }
	const r = await link.linkFromOption();
	const setup = `${link.optionServiceUrl()}/setup`;
	switch (r.status) {
		case 'already_linked':
			return; // quiet: the common case
		case 'linked':
			process.stdout.write(`Guardian Angel: linked this machine as "${r.creds.device_name}". Every tool call is now judged.\n`);
			return;
		case 'no_token':
			process.stdout.write(`Guardian Angel is installed but this machine is not linked. Generate a token at ${setup} and run /guardian-angel:link <token>.\n`);
			return;
		case 'failed':
			process.stdout.write(`Guardian Angel could not link this machine (${r.detail}). Generate a fresh token at ${setup} and run /guardian-angel:link <token>.\n`);
	}
})().catch(() => {}).finally(() => process.exit(0));
