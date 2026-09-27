'use strict';

/**
 * Linking this machine without anything to copy or paste.
 *
 *   linkFromOption()   a Set up page token in the plugin's `link_token` option
 *                      (CLAUDE_PLUGIN_OPTION_LINK_TOKEN), redeemed once
 *   startDeviceLink()  the default: start the device flow, open the browser at the
 *                      Link page with the code filled in, and leave a detached poller
 *                      to collect the credentials once the principal clicks Approve
 *
 * Never throws: callers decide what an unlinked machine means (fail closed to the
 * principal).
 */
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const client = require('./client');
const state = require('./state');
const { DEFAULT_SERVICE_URL, CLIENT_VERSION } = require('./paths');

const POLLER = path.join(__dirname, '..', 'bin', 'ga-link-poller.js');

function optionServiceUrl() {
	return (process.env.CLAUDE_PLUGIN_OPTION_SERVICE_URL || process.env.GA_SERVICE_URL || DEFAULT_SERVICE_URL).replace(/\/+$/, '');
}

const machineName = () => `${os.hostname()} (${os.userInfo().username})`;

function credentialsFrom(serviceUrl, json, name, harness, via) {
	return {
		service_url: serviceUrl,
		registration_token: json.registration_token,
		access_token: json.access_token,
		expires_at: Math.floor(Date.now() / 1000) + Number(json.expires_in || 900),
		device_id: json.device_id,
		device_name: json.device_name || name,
		harness,
		linked_at: new Date().toISOString(),
		linked_via: via,
	};
}

/** @returns {Promise<{status:'already_linked'|'linked'|'no_token'|'failed', creds?:object, detail?:string}>} */
async function linkFromOption({ harness = 'claude-code' } = {}) {
	const existing = client.loadCredentials();
	if (existing) return { status: 'already_linked', creds: existing };
	const token = (process.env.CLAUDE_PLUGIN_OPTION_LINK_TOKEN || '').trim();
	if (!token) return { status: 'no_token' };
	if (!token.startsWith('gal_')) return { status: 'failed', detail: 'the link token does not look like one from the Set up page' };
	const serviceUrl = optionServiceUrl();
	const name = machineName();
	const r = await client.redeemLink(serviceUrl, { token, name, harness, client_version: CLIENT_VERSION });
	if (!r.ok || !r.json || !r.json.registration_token) {
		return { status: 'failed', detail: (r.json && r.json.error_description) || r.error || `HTTP ${r.status}` };
	}
	const creds = credentialsFrom(serviceUrl, r.json, name, harness, 'plugin_option');
	client.saveCredentials(creds);
	return { status: 'linked', creds };
}

function isAlive(pid) {
	if (!pid) return false;
	try { process.kill(pid, 0); return true; } catch { return false; }
}

function openBrowser(url) {
	if (process.env.GA_NO_BROWSER || process.env.CI) return false;
	const custom = process.env.GA_OPEN_CMD; // tests
	const cmd = custom || (process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open');
	const args = custom ? [url] : process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
	try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); return true; } catch { return false; }
}

/**
 * Start (or resume) an automatic link. Opens the browser only when a new link is
 * started, never while one is already waiting.
 * @returns {Promise<{status:'already_linked'|'started'|'waiting'|'failed', url?:string, userCode?:string, opened?:boolean, detail?:string}>}
 */
async function startDeviceLink({ harness = 'claude-code' } = {}) {
	if (client.loadCredentials()) return { status: 'already_linked' };
	const now = Date.now();
	const pending = state.getLinkPending();
	if (pending && pending.expiresAt > now && isAlive(pending.pid)) {
		return { status: 'waiting', url: pending.url, userCode: pending.userCode };
	}
	const serviceUrl = optionServiceUrl();
	const name = machineName();
	const r = await client.deviceStart(serviceUrl, { name, harness, client_version: CLIENT_VERSION });
	if (!r.ok || !r.json || !r.json.device_code) {
		return { status: 'failed', detail: (r.json && r.json.error_description) || r.error || `HTTP ${r.status}` };
	}
	const { device_code, user_code, verification_uri, verification_uri_complete, interval = 5, expires_in = 600 } = r.json;
	const url = verification_uri_complete || verification_uri;
	const child = spawn(process.execPath, [POLLER, serviceUrl, device_code, String(interval), String(expires_in), name, harness], {
		detached: true, stdio: 'ignore', env: process.env,
	});
	child.unref();
	state.setLinkPending({ userCode: user_code, url, expiresAt: now + expires_in * 1000, pid: child.pid });
	const opened = openBrowser(url);
	return { status: 'started', url, userCode: user_code, opened };
}

module.exports = { linkFromOption, startDeviceLink, optionServiceUrl, credentialsFrom, machineName, isAlive };
