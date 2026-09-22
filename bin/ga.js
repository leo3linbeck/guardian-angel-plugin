#!/usr/bin/env node
/**
 * ga — Guardian Angel command line
 *
 *   ga login [--service URL]   link this machine to your Guardian Angel account
 *   ga status                  service health, linked device, token state
 *   ga logout                  forget this machine's credentials
 *   ga help
 *
 * Revoke a machine from the web app (Devices) if you no longer have it.
 */
'use strict';
const os = require('os');
const { spawn } = require('child_process');
const client = require('../lib/client');
const { credentialsPath, DEFAULT_SERVICE_URL, CLIENT_VERSION } = require('../lib/paths');

const args = process.argv.slice(2);
const cmd = args[0] || 'help';
const flag = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (s = '') => process.stdout.write(s + '\n');
const die = (s) => { process.stderr.write(s + '\n'); process.exit(1); };

function openBrowser(url) {
	const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
	try { spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref(); } catch { /* the URL is printed anyway */ }
}

async function login() {
	const existing = client.loadCredentials();
	const serviceUrl = (flag('--service') || process.env.GA_SERVICE_URL || (existing && existing.service_url) || DEFAULT_SERVICE_URL).replace(/\/+$/, '');
	const name = flag('--name') || `${os.hostname()} (${os.userInfo().username})`;

	const start = await client.deviceStart(serviceUrl, { name, harness: 'claude-code', client_version: CLIENT_VERSION });
	if (!start.ok || !start.json) die(`Could not reach ${serviceUrl} (${start.error || 'HTTP ' + start.status}).`);
	const { device_code, user_code, verification_uri, verification_uri_complete, interval = 5, expires_in = 600 } = start.json;

	out('');
	out(`  Open   ${verification_uri}`);
	out(`  Enter  ${user_code}`);
	out('');
	out('  Waiting for approval… (Ctrl-C to cancel)');
	if (!args.includes('--no-browser')) openBrowser(verification_uri_complete || verification_uri);

	const deadline = Date.now() + expires_in * 1000;
	let wait = interval * 1000;
	while (Date.now() < deadline) {
		await sleep(wait);
		const r = await client.devicePoll(serviceUrl, device_code);
		if (r.ok && r.json && r.json.registration_token) {
			client.saveCredentials({
				service_url: serviceUrl,
				registration_token: r.json.registration_token,
				access_token: r.json.access_token,
				expires_at: Math.floor(Date.now() / 1000) + Number(r.json.expires_in || 900),
				device_id: r.json.device_id,
				device_name: r.json.device_name || name,
				linked_at: new Date().toISOString(),
			});
			out(`\n  Linked "${r.json.device_name || name}". Credentials saved to ${credentialsPath()} (mode 0600).`);
			out('  Guardian Angel now guards Claude Code on this machine.\n');
			return;
		}
		const code = r.json && r.json.error;
		if (code === 'authorization_pending') continue;
		if (code === 'slow_down') { wait += 2000; continue; }
		if (code === 'access_denied') die('\n  The device was denied in the browser. Nothing was linked.');
		if (code === 'expired_token') die('\n  The code expired. Run `ga login` again.');
		if (r.status === 0) { continue; } // transient network blip: keep polling
		die(`\n  Unexpected response (${r.status}): ${JSON.stringify(r.json)}`);
	}
	die('\n  Timed out waiting for approval. Run `ga login` again.');
}

async function status() {
	const creds = client.loadCredentials();
	const serviceUrl = (flag('--service') || process.env.GA_SERVICE_URL || (creds && creds.service_url) || DEFAULT_SERVICE_URL).replace(/\/+$/, '');
	out(`  Plugin   guardian-angel ${CLIENT_VERSION}`);
	out(`  Service  ${serviceUrl}`);
	const h = await client.health(serviceUrl);
	if (h.ok && h.json) {
		out(`           version ${h.json.version} · core ${h.json.core_sha} · S1 ${h.json.system1} · S2 ${h.json.system2} · notify ${h.json.notify}`);
	} else {
		out(`           unreachable (${h.error || 'HTTP ' + h.status})`);
	}
	if (!creds) { out('  Device   not linked — run `ga login`'); return; }
	const ttl = typeof creds.expires_at === 'number' ? creds.expires_at - Math.floor(Date.now() / 1000) : null;
	out(`  Device   ${creds.device_name || creds.device_id} (linked ${creds.linked_at || '?'})`);
	out(`  Token    ${ttl === null ? 'none cached' : ttl > 0 ? `valid ${Math.floor(ttl / 60)} min` : 'expired (refreshes on next call)'}`);
	const m = await client.me(creds);
	if (m.ok) out(`  Account  ${m.me.email} · escalation mode ${m.me.escalation_mode}`);
	else out(`  Account  ${m.kind === 'relogin' ? 'link revoked or expired — run `ga login`' : m.kind === 'suspended' ? 'not active' : 'could not verify (' + m.detail + ')'}`);
}

function logout() {
	const had = client.clearCredentials();
	out(had ? '  Credentials removed. Revoke the device from the web app (Devices) as well if you want its token dead now.' : '  Nothing to remove.');
}

function help() {
	out(`ga — Guardian Angel

  ga login [--service URL] [--name NAME] [--no-browser]
  ga status
  ga logout
`);
}

({ login, status, logout, help, '--help': help, '-h': help }[cmd] || (() => die(`Unknown command: ${cmd}\n`) ))();
