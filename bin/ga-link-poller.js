#!/usr/bin/env node
/**
 * Guardian Angel — background link poller
 *
 * Started detached by the SessionStart (or PreToolUse) hook when this machine is
 * not linked. Polls the device-flow token endpoint until the principal clicks
 * Approve on the Link page, then saves this machine's credentials and exits.
 * Gives up at the code's expiry or on denial. Never prints (no terminal attached).
 *
 *   ga-link-poller.js <serviceUrl> <deviceCode> <intervalS> <expiresInS> <name> <harness>
 */
'use strict';
const client = require('../lib/client');
const state = require('../lib/state');
const { credentialsFrom } = require('../lib/link');

const [serviceUrl, deviceCode, intervalS, expiresInS, name, harness = 'claude-code'] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
	if (!serviceUrl || !deviceCode) return;
	const deadline = Date.now() + Number(expiresInS || 600) * 1000;
	let wait = Number(process.env.GA_POLL_INTERVAL_MS) || Number(intervalS || 5) * 1000;
	while (Date.now() < deadline) {
		await sleep(wait);
		if (client.loadCredentials()) break; // linked some other way meanwhile
		const r = await client.devicePoll(serviceUrl, deviceCode);
		if (r.ok && r.json && r.json.registration_token) {
			client.saveCredentials(credentialsFrom(serviceUrl, r.json, name, harness, 'device_flow_auto'));
			break;
		}
		const code = r.json && r.json.error;
		if (code === 'authorization_pending' || r.status === 0) continue;
		if (code === 'slow_down') { wait += 2000; continue; }
		break; // access_denied, expired_token, anything else
	}
	try { state.setLinkPending(null); } catch { /* best effort */ }
})().finally(() => process.exit(0));
