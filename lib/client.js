'use strict';

/**
 * Guardian Angel — thin HTTPS client (ga-service-spec.md §5, §6).
 *
 * Holds the registration token (credentials file, mode 0600), refreshes the
 * 15-minute access token before it lapses, and speaks to the service's JSON
 * API. No morality prompt, no model credential, nothing but the token.
 *
 * Every network failure is reported as a typed result, never thrown into the
 * hook: the hook decides what "cannot reach the service" means (fail closed).
 */
const fs = require('fs');
const path = require('path');
const { credentialsPath, DEFAULT_SERVICE_URL, CLIENT_VERSION } = require('./paths');

const REFRESH_BEFORE_S = 120;

// ── Credentials file ──────────────────────────────────────────────────
function loadCredentials() {
	try {
		const c = JSON.parse(fs.readFileSync(credentialsPath(), 'utf8'));
		if (!c || typeof c.registration_token !== 'string' || typeof c.service_url !== 'string') return null;
		return c;
	} catch {
		return null;
	}
}

function saveCredentials(creds) {
	const file = credentialsPath();
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
	try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

function clearCredentials() {
	try { fs.unlinkSync(credentialsPath()); return true; } catch { return false; }
}

// ── HTTP ──────────────────────────────────────────────────────────────
async function request(url, { method = 'GET', body, token, timeoutMs = 10_000 } = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const headers = { 'Accept': 'application/json', 'User-Agent': `guardian-angel-plugin/${CLIENT_VERSION}` };
		if (body !== undefined) headers['Content-Type'] = 'application/json';
		if (token) headers['Authorization'] = `Bearer ${token}`;
		const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
		let json = null;
		try { json = await res.json(); } catch { /* non-JSON body */ }
		return { ok: res.ok, status: res.status, json };
	} catch (err) {
		return { ok: false, status: 0, json: null, error: err.name === 'AbortError' ? 'timed out' : err.message };
	} finally {
		clearTimeout(timer);
	}
}

const api = (creds, p) => `${creds.service_url.replace(/\/+$/, '')}/api/v1${p}`;

// ── Tokens ────────────────────────────────────────────────────────────
/**
 * A valid access token, refreshing when fewer than two minutes remain.
 * @returns {Promise<{ok:true, token:string, creds:object} | {ok:false, kind:'relogin'|'suspended'|'unreachable', detail:string}>}
 */
async function ensureAccessToken(creds, { timeoutMs = 8_000 } = {}) {
	const now = Math.floor(Date.now() / 1000);
	if (creds.access_token && typeof creds.expires_at === 'number' && creds.expires_at - now > REFRESH_BEFORE_S) {
		return { ok: true, token: creds.access_token, creds };
	}
	const r = await request(api(creds, '/token'), { method: 'POST', body: { registration_token: creds.registration_token }, timeoutMs });
	if (r.ok && r.json && r.json.access_token) {
		const updated = { ...creds, access_token: r.json.access_token, expires_at: now + Number(r.json.expires_in || 900) };
		try { saveCredentials(updated); } catch { /* still usable this call */ }
		return { ok: true, token: updated.access_token, creds: updated };
	}
	if (r.status === 401) return { ok: false, kind: 'relogin', detail: (r.json && r.json.error_description) || 'registration token rejected' };
	if (r.status === 403) return { ok: false, kind: 'suspended', detail: (r.json && r.json.error_description) || 'account not active' };
	// A stale-but-unexpired token still authenticates; use it rather than fail on a refresh blip.
	if (creds.access_token && typeof creds.expires_at === 'number' && creds.expires_at > now) {
		return { ok: true, token: creds.access_token, creds };
	}
	return { ok: false, kind: 'unreachable', detail: r.error || `token endpoint returned ${r.status}` };
}

// ── Evaluate ──────────────────────────────────────────────────────────
/**
 * @returns {Promise<{ok:true, verdict:object} | {ok:false, kind:'relogin'|'suspended'|'unreachable'|'rate_limited'|'rejected_call'|'server_error', detail:string}>}
 */
async function evaluate(creds, normalizedCall, { timeoutMs = 45_000 } = {}) {
	const t = await ensureAccessToken(creds);
	if (!t.ok) return t;
	const r = await request(api(creds, '/evaluate'), { method: 'POST', body: normalizedCall, token: t.token, timeoutMs });
	if (r.ok && r.json && r.json.decision) return { ok: true, verdict: r.json };
	const detail = (r.json && r.json.error_description) || r.error || `HTTP ${r.status}`;
	if (r.status === 401) return { ok: false, kind: 'relogin', detail };
	if (r.status === 403) return { ok: false, kind: 'suspended', detail };
	if (r.status === 429) return { ok: false, kind: 'rate_limited', detail };
	if (r.status === 400 || r.status === 413) return { ok: false, kind: 'rejected_call', detail };
	if (r.status >= 500) return { ok: false, kind: 'server_error', detail };
	return { ok: false, kind: 'unreachable', detail };
}

/** Best effort; the audit record gains the principal's answer. Never blocks the hook. */
async function reportOutcome(creds, escalationId, answer, { timeoutMs = 5_000 } = {}) {
	const t = await ensureAccessToken(creds, { timeoutMs });
	if (!t.ok) return false;
	const r = await request(api(creds, `/escalations/${encodeURIComponent(escalationId)}/outcome`), { method: 'POST', body: { answer }, token: t.token, timeoutMs });
	return r.ok;
}

// ── Device flow + status (used by the CLI) ────────────────────────────
const deviceStart = (serviceUrl, info) => request(`${serviceUrl.replace(/\/+$/, '')}/api/v1/device/code`, { method: 'POST', body: info });
/** Redeem a Set up page link token (pre-approved in the browser) for this machine's credentials. */
const redeemLink = (serviceUrl, body) => request(`${serviceUrl.replace(/\/+$/, '')}/api/v1/device/redeem`, { method: 'POST', body });
const devicePoll = (serviceUrl, deviceCode) => request(`${serviceUrl.replace(/\/+$/, '')}/api/v1/device/token`, { method: 'POST', body: { device_code: deviceCode } });
const health = (serviceUrl) => request(`${serviceUrl.replace(/\/+$/, '')}/api/v1/health`, { timeoutMs: 8_000 });
async function me(creds) {
	const t = await ensureAccessToken(creds);
	if (!t.ok) return t;
	const r = await request(api(creds, '/me'), { token: t.token });
	return r.ok ? { ok: true, me: r.json, creds: t.creds } : { ok: false, kind: r.status === 401 ? 'relogin' : 'unreachable', detail: r.error || `HTTP ${r.status}` };
}

module.exports = {
	loadCredentials, saveCredentials, clearCredentials,
	ensureAccessToken, evaluate, reportOutcome,
	deviceStart, devicePoll, redeemLink, health, me,
	DEFAULT_SERVICE_URL, CLIENT_VERSION,
};
