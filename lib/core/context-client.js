// VENDORED from conscience-research/tests/harness/context-client.js by scripts/sync-core.mjs — do not edit here.
'use strict';

/**
 * Guardian Angel — context gathering, CLIENT side
 *
 * Everything here needs the principal's machine: it reads the scripts a Bash
 * command would run (DAG flattening), the package.json lifecycle scripts an
 * install would trigger, and the free disk space a download would consume.
 * In the service architecture (guardian-angel/plans/ga-service-spec.md) this
 * runs in the client adapter, next to System 0; its results travel to the
 * service inside the NormalizedCall. Nothing here talks to a model.
 *
 * If a referenced script cannot be read, nobody below the principal can know
 * what would execute — the caller hands that decision to the principal.
 *
 * This file is the single source of truth. The clinical-trial harness requires
 * it (via context.js); guardian-angel/install.js copies it to ~/.claude/hooks/ga-lib/.
 */

const fs   = require('fs');
const path = require('path');

const MAX_FILE_SIZE = 10_000;

function readFileSafe(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) {
      return `[file too large: ${stat.size} bytes, truncated]\n` +
        fs.readFileSync(filePath, 'utf8').slice(0, MAX_FILE_SIZE);
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch { return null; }
}

/**
 * Package managers run whatever package.json says — not only `npm test` and
 * `npm run build`, but also INSTALLS, which execute lifecycle scripts (preinstall,
 * install, postinstall, prepare). Show the judges those scripts, and the local files
 * they run, so neither "run the tests" nor "install dependencies" can hide a payload.
 */
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'preprepare', 'postprepare'];

function resolvePackageScripts(cmd, cwd, files) {
  const runsScript = /(?:^|&&|\|\||;|\n)\s*(?:npm\s+(?:test|t|start|stop|restart|run(?:-script)?\s+\S+)|(?:yarn|pnpm)\s+(?!add\b|install\b|remove\b|--version\b)\S+)/;
  const installs   = /(?:^|&&|\|\||;|\n)\s*(?:npm\s+(?:install|i|ci|add|rebuild|update|up)\b|(?:yarn|pnpm)\s+(?:install|add)\b|yarn\s*(?:$|&&|;|\|))/;
  const isInstall = installs.test(cmd);
  if (!runsScript.test(cmd) && !isInstall) return;
  if (/--ignore-scripts\b/.test(cmd)) return;

  const cdMatch = cmd.match(/(?:^|&&|;)\s*cd\s+(\/[^\s;|&]+)/);
  const dir = cdMatch ? cdMatch[1] : cwd;
  if (!dir) return;

  let scripts;
  try { scripts = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts; }
  catch { return; /* no readable package.json — the judges see only the command */ }
  if (!scripts || Object.keys(scripts).length === 0) return;

  const lifecycle = Object.fromEntries(Object.entries(scripts).filter(([name]) => LIFECYCLE.includes(name)));
  const label = isInstall
    ? (Object.keys(lifecycle).length > 0
        ? ' (scripts — THIS INSTALL WILL AUTOMATICALLY RUN: ' + Object.keys(lifecycle).join(', ') + ')'
        : ' (scripts — none run automatically on install)')
    : ' (scripts)';
  files.push({ filePath: path.join(dir, 'package.json') + label, content: JSON.stringify(scripts, null, 2).slice(0, MAX_FILE_SIZE) });

  // The local files those scripts execute
  // Only the scripts this command actually triggers (npm also runs pre<name>/post<name>)
  let relevant = Object.values(lifecycle);
  if (!isInstall) {
    const m = cmd.match(/\bnpm\s+(test|t|start|stop|restart)\b/) || cmd.match(/\bnpm\s+run(?:-script)?\s+(\S+)/) || cmd.match(/\b(?:yarn|pnpm)\s+(?:run\s+)?(\S+)/);
    const name = m ? (m[1] === 't' ? 'test' : m[1]) : null;
    relevant = name ? ['pre' + name, name, 'post' + name].map(n => scripts[n]).filter(Boolean) : [];
  }
  const seen = new Set();
  for (const line of relevant) {
    for (const m of String(line).matchAll(/(?:^|\s|&&|;)(?:node|bash|sh|python3?|ruby|perl)?\s*((?:\.{1,2}\/)?[\w./-]+\.(?:js|cjs|mjs|sh|bash|py|rb|pl))\b/g)) {
      const file = path.resolve(dir, m[1]);
      if (seen.has(file) || seen.size >= 3) continue;
      seen.add(file);
      const content = readFileSafe(file);
      if (content !== null) files.push({ filePath: file + ' (run by a package.json script)', content });
    }
  }
}

function resolveReferencedFiles(toolName, toolInput, cwd) {
  const files = [];
  const unresolved = [];

  if (toolName === 'Bash') {
    const cmd = (toolInput && toolInput.command) || '';

    resolvePackageScripts(cmd, cwd, files);

    // Detect files CREATED by heredoc (cat > /path << 'EOF' ... EOF)
    // Extract their content inline — the file doesn't exist on disk yet
    // but we can resolve it from the command text itself.
    const heredocCreations = new Map(); // filePath → content
    const heredocPattern = /cat\s*>\s*(\/[^\s<]+)\s*<<\s*['"]?(\w+)['"]?/g;
    let heredocMatch;
    while ((heredocMatch = heredocPattern.exec(cmd)) !== null) {
      const filePath = heredocMatch[1];
      const delimiter = heredocMatch[2];
      const startIdx = heredocMatch.index + heredocMatch[0].length;
      const delimEnd = cmd.indexOf('\n' + delimiter, startIdx);
      if (delimEnd !== -1) {
        const content = cmd.slice(startIdx, delimEnd).replace(/^\n/, '');
        heredocCreations.set(filePath, content);
        files.push({ filePath: filePath + ' (heredoc)', content });
      } else {
        heredocCreations.set(filePath, null);
      }
    }

    const patterns = [
      /(?:^|\s|&&|\|\||;)\s*(?:bash|sh|zsh|source|\.)\s+(\/[^\s;|&]+)/g,
      /(?:^|\s|&&|\|\||;)\s*(?:python3?|node|ruby|perl)\s+(\/[^\s;|&]+)/g,
    ];

    const seen = new Set();
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(cmd)) !== null) {
        const filePath = match[1];
        if (!seen.has(filePath) && !heredocCreations.has(filePath)) {
          seen.add(filePath);
          const content = readFileSafe(filePath);
          if (content !== null) { files.push({ filePath, content }); }
          else { unresolved.push(filePath); }
        }
      }
    }

    if (seen.size === 0) {
      const barePattern = /(?:^|&&|\|\||;)\s*(\/[^\s;|&]+\.(?:sh|bash|py|rb|pl|js))\b/g;
      let bareMatch;
      while ((bareMatch = barePattern.exec(cmd)) !== null) {
        const filePath = bareMatch[1];
        if (!seen.has(filePath) && !heredocCreations.has(filePath)) {
          seen.add(filePath);
          const content = readFileSafe(filePath);
          if (content !== null) { files.push({ filePath, content }); }
          else { unresolved.push(filePath); }
        }
      }
    }

    if (seen.size === 0) {
      const cdMatch = cmd.match(/cd\s+(\/[^\s;|&]+)\s*(?:&&|\|\||;)/);
      if (cdMatch) {
        const cdDir = cdMatch[1];
        const afterCd = cmd.slice(cmd.indexOf(cdMatch[0]) + cdMatch[0].length);
        const relPatterns = [
          /(?:bash|sh|zsh|source|\.)\s+([^\s;|&\/][^\s;|&]*\.(?:sh|bash|py|rb|pl|js))\b/,
          /^\s*\.\/([^\s;|&]+\.(?:sh|bash|py|rb|pl|js))\b/,
        ];
        for (const pat of relPatterns) {
          const relMatch = afterCd.match(pat);
          if (relMatch) {
            const filePath = path.join(cdDir, relMatch[1]);
            if (!seen.has(filePath)) {
              seen.add(filePath);
              const content = readFileSafe(filePath);
              if (content !== null) { files.push({ filePath, content }); }
              else { unresolved.push(filePath); }
            }
          }
        }
      }
    }
  }

  return { files, unresolved };
}

// ── Downloads: will it fit? ──────────────────────────────────────────
// A download that writes to disk can exhaust storage and take the system down.
// Two facts are knowable beforehand: how much room there is (certain) and how
// big the server SAYS the file is (a claim — it can be absent or false). So:
//
//   advertised size > free space      → REJECT: it cannot succeed
//   advertised size > half free space → flag, for the tiers above to weigh
//   size unknown                      → flag only (too common to act on)
//
// A lying or endless stream defeats any prediction; the real defence is a cap on
// the transfer itself (curl --max-filesize, ulimit -f, quotas).
//
// The size probe is a real HEAD request to that server, so it is NOT sent when the
// URL carries a query string, credentials, or shell expansions — Guardian Angel
// must never be the one to transmit something.

const DOWNLOAD_PROBE_TIMEOUT_MS = 2_500;
const LARGE_SHARE_OF_FREE_SPACE = 0.5;
const PROBE_HEADER              = 'x-guardian-angel-probe';

function tokenize(cmd) {
  return (cmd.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(t => t.replace(/^(["'])(.*)\1$/, (m, q, inner) => inner));
}

/** Find downloads in a command that WRITE TO DISK. `curl URL` to stdout is not one. */
function findDiskDownloads(cmd) {
  const found = [];
  for (const segment of String(cmd).split(/&&|\|\||;|\n/)) {
    if (segment.includes('|')) continue;                       // piped: not landing on disk as a file
    const tok = tokenize(segment.trim());
    const tool = tok.findIndex(t => t === 'curl' || t === 'wget');
    if (tool < 0) continue;
    const args = tok.slice(tool + 1);
    const url  = args.find(a => /^https?:\/\//i.test(a));
    if (!url) continue;

    let target = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (tok[tool] === 'curl') {
        if (a === '-o' || a === '--output') target = args[i + 1];
        else if (/^-[a-zA-Z]*o$/.test(a)) target = args[i + 1];
        else if (a === '--remote-name' || /^-[a-zA-Z]*O[a-zA-Z]*$/.test(a)) target = target || '.';
      } else {
        if (/^-[a-zA-Z]*O-$/.test(a)) target = '-';                       // -O- / -qO- : stdout
        else if (a === '-O' || a === '--output-document') target = args[i + 1];
        else if (/^-[a-zA-Z]*O$/.test(a)) target = args[i + 1];
        else if (a === '-P' || a === '--directory-prefix') target = args[i + 1];
      }
    }
    if (tok[tool] === 'wget' && target === null) target = '.';  // wget saves to cwd by default
    if (target === null || target === undefined || target === '-' || target === '/dev/null') continue;   // stdout or discarded
    found.push({ url, target });
  }
  return found;
}

function freeBytes(target, cwd) {
  try {
    let dir = path.resolve(cwd || '/', target);
    if (!target.endsWith('/') && target !== '.') dir = path.dirname(dir);
    while (!fs.existsSync(dir) && dir !== path.dirname(dir)) dir = path.dirname(dir);
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch { return null; }
}

function safeToProbe(url) {
  try {
    const u = new URL(url);
    return !u.search && !u.username && !u.password && !url.includes('$') && !url.includes('`');
  } catch { return false; }
}

async function advertisedSize(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal, headers: { [PROBE_HEADER]: '1' } });
    const len = Number(res.headers.get('content-length'));
    return Number.isFinite(len) && len > 0 ? len : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

const human = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.ceil(n / 1e3) + ' KB';

/**
 * @returns {Promise<{verdict:'REJECT'|null, reason:string|null, flags:string[], downloads:object[]}>}
 */
async function assessDownloads(toolName, toolInput, cwd) {
  const out = { verdict: null, reason: null, flags: [], downloads: [] };
  if (toolName !== 'Bash') return out;

  for (const d of findDiskDownloads((toolInput && toolInput.command) || '')) {
    const free = freeBytes(d.target, cwd);
    const probed = safeToProbe(d.url);
    const size = probed ? await advertisedSize(d.url) : null;
    out.downloads.push({ ...d, size_bytes: size, free_bytes: free, probed });

    if (size !== null && free !== null && size > free) {
      out.verdict = 'REJECT';
      out.reason  = `This download cannot fit: the server reports ${human(size)} for ${d.url} and only ${human(free)} is free where it would be saved. Filling the disk can crash the system.`;
      return out;
    }
    if (size !== null && free !== null && size > free * LARGE_SHARE_OF_FREE_SPACE) {
      out.flags.push(`download of ${human(size)} would use ${Math.round(100 * size / free)}% of the ${human(free)} of free disk space`);
    } else if (size === null) {
      out.flags.push(`download size is unknown (${probed ? 'the server did not say' : 'not probed: the URL carries a query string, credentials, or expansions'}); ${free === null ? 'free space unknown' : human(free) + ' free'}`);
    }
  }
  return out;
}

module.exports = {
  assessDownloads,
  findDiskDownloads,
  PROBE_HEADER,
  resolveReferencedFiles,
  resolvePackageScripts,
  readFileSafe,
};
