'use strict';
const os = require('os');
const path = require('path');

/** Where the plugin keeps its per-machine state. Override with GA_CONFIG_DIR (tests). */
function configDir() {
	return process.env.GA_CONFIG_DIR || path.join(os.homedir(), '.config', 'guardian-angel');
}

module.exports = {
	configDir,
	credentialsPath: () => path.join(configDir(), 'credentials.json'),
	statePath: () => path.join(configDir(), 'state.json'),
	logPath: () => path.join(configDir(), 'hook.log'),
	DEFAULT_SERVICE_URL: 'https://ga.linbeck.app',
	CLIENT_VERSION: require('../package.json').version,
};
