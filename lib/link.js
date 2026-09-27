'use strict';

/**
 * Link this machine from the plugin's `link_token` option (the in-harness setup).
 *
 * When the plugin is enabled, Claude Code asks for the option and hands it to
 * hook processes as CLAUDE_PLUGIN_OPTION_LINK_TOKEN. If this machine has no
 * credentials yet, redeem it once; afterwards the stored value is stale and
 * ignored. Never throws: the caller decides what an unlinked machine means.
 */
const os = require('os');
const client = require('./client');
const { DEFAULT_SERVICE_URL, CLIENT_VERSION } = require('./paths');

function optionServiceUrl() {
	return (process.env.CLAUDE_PLUGIN_OPTION_SERVICE_URL || process.env.GA_SERVICE_URL || DEFAULT_SERVICE_URL).replace(/\/+$/, '');
}

/**
 * @returns {Promise<{status:'already_linked'|'linked'|'no_token'|'failed', creds?:object, detail?:string}>}
 */
async function linkFromOption({ harness = 'claude-code' } = {}) {
	const existing = client.loadCredentials();
	if (existing) return { status: 'already_linked', creds: existing };
	const token = (process.env.CLAUDE_PLUGIN_OPTION_LINK_TOKEN || '').trim();
	if (!token) return { status: 'no_token' };
	if (!token.startsWith('gal_')) return { status: 'failed', detail: 'the link token does not look like one from the Set up page' };
	const serviceUrl = optionServiceUrl();
	const name = `${os.hostname()} (${os.userInfo().username})`;
	const r = await client.redeemLink(serviceUrl, { token, name, harness, client_version: CLIENT_VERSION });
	if (!r.ok || !r.json || !r.json.registration_token) {
		return { status: 'failed', detail: (r.json && r.json.error_description) || r.error || `HTTP ${r.status}` };
	}
	const creds = {
		service_url: serviceUrl,
		registration_token: r.json.registration_token,
		access_token: r.json.access_token,
		expires_at: Math.floor(Date.now() / 1000) + Number(r.json.expires_in || 900),
		device_id: r.json.device_id,
		device_name: r.json.device_name || name,
		harness,
		linked_at: new Date().toISOString(),
		linked_via: 'plugin_option',
	};
	client.saveCredentials(creds);
	return { status: 'linked', creds };
}

module.exports = { linkFromOption, optionServiceUrl };
