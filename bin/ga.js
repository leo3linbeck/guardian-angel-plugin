#!/usr/bin/env node
/**
 * ga — Guardian Angel command line
 *
 *   ga setup --harness claude-code --token gal_… [--service URL]
 *                              the Set up page's one command: install the adapter for
 *                              the harness and link this machine, no code to type
 *   ga login [--service URL]   link this machine interactively (device code)
 *   ga status                  service health, linked device, token state
 *   ga logout                  forget this machine's credentials
 *   ga help
 *
 * Runs from a checkout, from the installed plugin, or straight from GitHub:
 *   npx --yes github:leo3linbeck/guardian-angel-plugin setup …
 *
 * Revoke a machine from the web app (Devices) if you no longer have it.
 */
'use strict';
const os = require('os');
const { spawn, spawnSync } = require('child_process');
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
			saveLinkedCredentials(serviceUrl, r.json, name, 'claude-code');
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

// ── setup: the one-paste installer ────────────────────────────────────
const MARKETPLACE_REPO = 'leo3linbeck/guardian-angel-plugin';
const MARKETPLACE_NAME = 'linbeck-tools';
const PLUGIN_NAME = 'guardian-angel';

function saveLinkedCredentials(serviceUrl, json, name, harness) {
	client.saveCredentials({
		service_url: serviceUrl,
		registration_token: json.registration_token,
		access_token: json.access_token,
		expires_at: Math.floor(Date.now() / 1000) + Number(json.expires_in || 900),
		device_id: json.device_id,
		device_name: json.device_name || name,
		harness,
		linked_at: new Date().toISOString(),
	});
}

/** Install the Claude Code plugin with the terminal CLI. Returns null on success, else the reason. */
function installClaudeCodePlugin() {
	const run = (args) => spawnSync('claude', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	const probe = run(['--version']);
	if (probe.error || probe.status !== 0) return 'the `claude` command is not on the PATH here';
	out(`  Claude Code ${String(probe.stdout).trim()}`);
	const add = run(['plugin', 'marketplace', 'add', MARKETPLACE_REPO]);
	// Already-added marketplaces report a non-zero status with an "already" message; that is fine.
	if (add.status !== 0 && !/already/i.test(add.stdout + add.stderr)) return `marketplace add failed: ${(add.stderr || add.stdout).trim().slice(0, 300)}`;
	const install = run(['plugin', 'install', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, '--yes']);
	if (install.status !== 0 && !/already/i.test(install.stdout + install.stderr)) return `plugin install failed: ${(install.stderr || install.stdout).trim().slice(0, 300)}`;
	const update = run(['plugin', 'update', PLUGIN_NAME]);
	void update; // best effort: brings an existing install to the latest version
	return null;
}

async function setup() {
	const harness = flag('--harness') || 'claude-code';
	const token = flag('--token');
	const serviceUrl = (flag('--service') || process.env.GA_SERVICE_URL || DEFAULT_SERVICE_URL).replace(/\/+$/, '');
	const name = flag('--name') || `${os.hostname()} (${os.userInfo().username})`;
	if (!token || !token.startsWith('gal_')) die('  --token is required: generate the command on the Set up page.');
	if (harness !== 'claude-code') die(`  Harness "${harness}" is not available yet. Claude Code is the only harness the installer supports today.`);

	out('');
	out(`  Guardian Angel setup for ${harness}`);

	// 1. Adapter. Skippable for tests and for people who installed the plugin already.
	if (!args.includes('--skip-adapter')) {
		const problem = installClaudeCodePlugin();
		if (problem) {
			out(`  Could not install the Claude Code plugin automatically: ${problem}.`);
			out('  Install it inside Claude Code instead, then re-run this command with --skip-adapter:');
			out(`    /plugin marketplace add ${MARKETPLACE_REPO}`);
			out(`    /plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
			process.exit(1);
		}
		out('  Plugin installed.');
	}

	// 2. Link. The approval happened on the Set up page; redeem the token for credentials.
	const r = await client.redeemLink(serviceUrl, { token, name, harness, client_version: CLIENT_VERSION });
	if (!r.ok || !r.json || !r.json.registration_token) {
		const why = (r.json && r.json.error_description) || r.error || `HTTP ${r.status}`;
		die(`  Could not link this machine: ${why}`);
	}
	saveLinkedCredentials(serviceUrl, r.json, name, harness);
	out(`  Linked "${r.json.device_name || name}" to ${serviceUrl}.`);
	out(`  Credentials saved to ${credentialsPath()} (mode 0600).`);
	out('');
	out('  Done. Start (or restart) Claude Code; every tool call is now judged by Guardian Angel.');
	out('');
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

  ga setup --harness claude-code --token gal_… [--service URL] [--name NAME] [--skip-adapter]
  ga login [--service URL] [--name NAME] [--no-browser]
  ga status
  ga logout
`);
}

({ setup, login, status, logout, help, '--help': help, '-h': help }[cmd] || (() => die(`Unknown command: ${cmd}\n`)))();
