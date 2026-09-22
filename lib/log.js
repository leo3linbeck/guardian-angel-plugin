'use strict';
const fs = require('fs');
const path = require('path');
const { logPath } = require('./paths');

/** Append a block to the local hook log. Never throws. */
function log(lines) {
	try {
		fs.mkdirSync(path.dirname(logPath()), { recursive: true, mode: 0o700 });
		fs.appendFileSync(logPath(), lines.join('\n') + '\n' + '─'.repeat(60) + '\n');
	} catch { /* non-fatal */ }
}

module.exports = { log };
