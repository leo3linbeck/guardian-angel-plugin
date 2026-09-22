'use strict';

/**
 * The big picture, from Claude Code's transcript (JSONL, one entry per line).
 * Reads the tail once and returns:
 *   request — the most recent message the principal actually typed
 *   history — the agent's recent tool calls, oldest first, each with the start
 *             of what it printed (untrusted environment data, redacted)
 * Lifted from the standalone hook so the service sees the same context the
 * trial measured.
 */
const fs = require('fs');

const TRANSCRIPT_TAIL = 512 * 1024;
const MAX_HISTORY = 12;

function readTranscript(transcriptPath, redact = (s) => s) {
	const out = { request: '', history: [] };
	if (!transcriptPath) return out;
	try {
		const stat = fs.statSync(transcriptPath);
		const start = Math.max(0, stat.size - TRANSCRIPT_TAIL);
		const fd = fs.openSync(transcriptPath, 'r');
		const buf = Buffer.alloc(stat.size - start);
		fs.readSync(fd, buf, 0, buf.length, start);
		fs.closeSync(fd);
		const lines = buf.toString('utf8').split('\n');

		const results = {};
		for (const line0 of lines) {
			const line = line0.trim();
			if (!line.startsWith('{')) continue;
			let entry; try { entry = JSON.parse(line); } catch { continue; }
			if (entry.isMeta || entry.isSidechain) continue;
			const msg = entry.message || entry;
			if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
			for (const b of msg.content) {
				if (b.type !== 'tool_result' || !b.tool_use_id || results[b.tool_use_id]) continue;
				const c = typeof b.content === 'string'
					? b.content
					: Array.isArray(b.content) ? b.content.filter(x => x.type === 'text').map(x => x.text).join('\n') : '';
				if (c) results[b.tool_use_id] = redact(String(c)).slice(0, 200).replace(/\n/g, ' ');
			}
		}

		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i].trim();
			if (!line.startsWith('{')) continue;
			let entry; try { entry = JSON.parse(line); } catch { continue; }
			if (entry.isMeta || entry.isSidechain) continue;
			const msg = entry.message || entry;

			if (msg.role === 'assistant' && Array.isArray(msg.content) && out.history.length < MAX_HISTORY) {
				for (const b of [...msg.content].reverse()) {
					if (b.type !== 'tool_use' || out.history.length >= MAX_HISTORY) continue;
					const inp = b.input || {};
					out.history.unshift({
						tool: b.name,
						summary: inp.command || inp.file_path || inp.pattern || inp.url || JSON.stringify(inp).slice(0, 200),
						output: results[b.id] || null,
					});
				}
				continue;
			}

			if ((entry.type || msg.role) !== 'user' || msg.role !== 'user') continue;
			let text = '';
			if (typeof msg.content === 'string') text = msg.content;
			else if (Array.isArray(msg.content)) {
				if (msg.content.some(b => b.type === 'tool_result')) continue;
				text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
			}
			text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
				.replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, '')
				.trim();
			if (!text || text.startsWith('<')) continue;
			out.request = text.slice(0, 2000);
			break;
		}
	} catch { /* no transcript → no request; the tiers judge without it */ }
	return out;
}

module.exports = { readTranscript, MAX_HISTORY };
