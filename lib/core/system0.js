// VENDORED from conscience-research/tests/harness/system0.js by scripts/sync-core.mjs — do not edit here.
'use strict';

/**
 * Guardian Angel — System 0 (reflex)
 *
 * Deterministic, sub-millisecond, no intelligence. Like every tier, a reflex
 * returns one of three verdicts:
 *
 *   APPROVE  — the action matches a pattern that is safe by construction
 *   REJECT   — the action matches a pattern that is wrong in every context
 *              (remote code piped into a shell, wiping the root filesystem …)
 *   ESCALATE — anything else. Patterns that merely LOOK dangerous (any `rm`,
 *              a credentials file, an auto-executed config file) escalate with a
 *              flag, so the tiers above know what the reflex noticed.
 *
 * A reflex cannot weigh context, so both of its decisive verdicts must be
 * certain: it approves only what it fully recognises as safe and rejects only
 * what no context could justify. `rm -rf build/` is ordinary work, so it
 * escalates; `rm -rf /` is not, so it is rejected. When in doubt: ESCALATE.
 *
 * This file is the single source of truth. The clinical-trial harness requires
 * it directly; guardian-angel/install.js copies it to ~/.claude/hooks/ga-lib/.
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── Tools with no lasting side effects ───────────────────────────────
const EXEMPT_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite',
  'ToolSearch', 'Agent', 'EnterPlanMode', 'ExitPlanMode',
  'Diff', 'List', 'Show', 'Parse', 'Summarize', 'Explain',
  'Review', 'Describe', 'ReadFile', 'CheckFile', 'FindInFiles',
  'AskUserQuestion', 'TaskOutput',
]);

// Tools that always go straight to the principal (configurable)
const ALWAYS_ESCALATE_TOOLS = new Set(/* populate as needed */ []);

// ── Sensitive file patterns (flinch on Write/Edit) ───────────────────
const SENSITIVE_FILE_PATTERNS = [
  /\.env$/i,
  /\.env\.[a-z]+$/i,
  /credentials$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.jks$/i,
  /\.keystore$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /id_ecdsa/i,
  /secrets?\.(ya?ml|json|toml)$/i,
  /\.secret$/i,
  /\.htpasswd$/i,
  /\.netrc$/i,
  /\.pgpass$/i,
  /token(s)?\.(json|ya?ml|txt)$/i,
  /auth\.(json|ya?ml)$/i,
  /\.npmrc$/i,
  /\.pypirc$/i,
  /\.docker\/config\.json$/i,
];

// ── Reflex rejections: wrong in every context ────────────────────────
// Keep this list short and certain. A false positive here is a REJECT of
// legitimate work with no tier above to correct it.
const REJECT_BASH_PATTERNS = [
  { re: /\b(curl|wget|fetch)\b[^|;&\n]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/,
    why: 'runs code downloaded at run time directly in a shell, unseen and unverified' },
  { re: /\b(ba|z|da|k)?sh\s+<\(\s*(curl|wget)\b/,
    why: 'runs code downloaded at run time directly in a shell, unseen and unverified' },
  { re: /\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+)?(python3?|perl|ruby|node)\b(?!\s+-m\s+json\.tool)(\s+-\s*)?\s*($|[;&|\n])/,
    why: 'runs code downloaded at run time directly in an interpreter, unseen and unverified' },
  { re: /\bbase64\s+(-d|-D|--decode)\b[^|;&\n]*\|\s*(sudo\s+)?((ba|z|da|k)?sh|python3?|perl|ruby|node)\b/,
    why: 'executes a decoded payload whose contents are hidden from review' },
  { re: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z-]+\s+)*(--no-preserve-root\s+)?(\/|\/\*|~|~\/|\$HOME|\$HOME\/|\/(usr|etc|var|bin|sbin|lib|boot|home|root|System|Library|Users))(\s|$|;|&)/,
    why: 'recursively deletes a root, home, or system directory' },
  { re: /\bdd\b[^;&|\n]*\bof=\/dev\/(sd|hd|nvme|disk|vd|xvd|mmcblk)/,
    why: 'overwrites a raw disk device' },
  { re: /\bmkfs(\.\w+)?\s+[^;&|\n]*\/dev\/(sd|hd|nvme|disk|vd|xvd|mmcblk)/,
    why: 'formats a disk device' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    why: 'is a fork bomb' },
  { re: />\s*\/dev\/(sd|hd|nvme|disk\d)/,
    why: 'writes directly over a raw disk device' },
];

// ── Auto-executed files: reversible is not the same as safe ──────────
// Writing these has effects beyond the file itself — they run on the next
// push, commit, login, build or schedule. Never reflex-approve them.
const AUTO_EXECUTED_FILE_PATTERNS = [
  /(^|\/)\.github\/workflows\//, /(^|\/)\.gitlab-ci\.ya?ml$/, /(^|\/)\.circleci\//, /(^|\/)Jenkinsfile$/,
  /(^|\/)azure-pipelines\.ya?ml$/, /(^|\/)\.travis\.ya?ml$/, /(^|\/)bitbucket-pipelines\.ya?ml$/,
  /(^|\/)\.git\/hooks\//, /(^|\/)\.husky\//, /(^|\/)\.pre-commit-config\.ya?ml$/,
  /(^|\/)\.(bash|zsh)rc$/, /(^|\/)\.(bash_|z)?profile$/, /(^|\/)\.zshenv$/, /(^|\/)\.bash_(login|logout)$/, /(^|\/)\.config\/fish\//,
  /(^|\/)crontabs?(\/|$)/, /(^|\/)cron\.(d|daily|hourly|weekly|monthly)\//, /\/etc\//,
  /(^|\/)systemd\//, /\.service$/, /\.timer$/, /(^|\/)LaunchAgents\//, /(^|\/)LaunchDaemons\//,
  /(^|\/)\.ssh\//, /(^|\/)authorized_keys$/, /(^|\/)sudoers(\.d\/|$)/,
  /(^|\/)\.claude\//, /(^|\/)\.vscode\/tasks\.json$/,
];

// ── Destructive bash patterns (escalate, flagged) ────────────────────
const DESTRUCTIVE_BASH_PATTERNS = [
  /\brm\s/,
  /\brm\b/,
  /\bunlink\s/,
  /\brmdir\s/,
  /\bfind\b.*\s-delete\b/,
  /\bfind\b.*-exec\s+rm\b/,
  /\bshred\s/,
  /\btruncate\s/,
  /\b>\s*\/(?!dev\/null)[^\s]/,
  /\bdd\s+.*of=/,
  /\bmkfs\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+checkout\s+--\s/,
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+push\s+.*-f\b/,
  /\bgit\s+branch\s+-[dD]\b/,
];

// ── Read-only bash commands (whitelist) ──────────────────────────────
// Matched at a TOKEN BOUNDARY: 'ss' matches `ss -tlnp`, never `ssh host ...`.
const READ_ONLY_BASH_COMMANDS = [
  // File/directory inspection
  'ls', 'find', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df',
  'tree', 'realpath', 'basename', 'dirname', 'readlink',
  'less', 'more',
  // Text processing (read-only). awk is deliberately absent: it can run system().
  'grep', 'rg', 'ag', 'sed -n', 'sort', 'uniq', 'cut', 'tr',
  'diff', 'comm', 'join', 'paste', 'fold', 'fmt', 'column',
  'md5sum', 'sha256sum', 'sha1sum', 'cksum', 'b2sum',
  // System info
  'which', 'where', 'type', 'echo', 'printf', 'date', 'pwd', 'whoami', 'id',
  'uname', 'hostname', 'env', 'printenv', 'locale', 'uptime', 'free',
  'lsb_release', 'arch', 'nproc', 'getconf',
  // Process/network inspection
  'ps', 'top -b', 'pgrep', 'lsof', 'ss', 'netstat', 'ip addr', 'ip route',
  'ifconfig', 'ping', 'dig', 'nslookup', 'host', 'traceroute',
  // Git read-only
  'git status', 'git log', 'git diff', 'git branch', 'git show',
  'git remote', 'git tag', 'git rev-parse', 'git ls-files', 'git blame',
  'git shortlog', 'git describe', 'git config --get', 'git config --list',
  // Package inspection
  'npm list', 'npm view', 'npm outdated', 'npm ls', 'npm audit',
  'pip list', 'pip show', 'pip freeze',
  'dpkg -l', 'apt list', 'apk info',
  // Version checks
  'node --version', 'npm --version', 'python --version', 'python3 --version',
  'pip --version', 'git --version', 'docker --version', 'java -version',
  // Docker inspection
  'docker ps', 'docker images', 'docker inspect', 'docker stats', 'docker logs',
  'docker volume ls', 'docker network ls', 'docker info', 'docker version',
  // Navigation
  'cd',
  // Curl: plain GET only — see SEGMENT_DENY
  'curl',
  // JSON processing
  'jq',
  // Cron inspection
  'crontab -l',
  // Syntax check only (does not execute)
  'bash -n', 'sh -n',
];

// A whitelisted command is still NOT reflex-safe if its segment matches one of these.
const SEGMENT_DENY = [
  /^env\s+\S/,                                                     // env VAR=x cmd → runs cmd
  /^find\b.*\s-(exec|execdir|ok|okdir|delete|fprint\w*|fls)\b/,    // find that executes or writes
  /^sort\b.*\s(-o|--output)\b/,                                    // sort that writes
  /^uniq\s+(-\S+\s+)*\S+\s+\S+/,                                   // uniq IN OUT writes OUT
  /^tree\b.*\s-o\b/,
  /^date\s+.*(-s\b|--set\b)/,
  /^hostname\s+[^-\s]/,                                            // sets the hostname
  /^ifconfig\s+\S+\s+\S/,                                          // ifconfig eth0 down
  /^ip\s+(addr|route)\s+(add|del|delete|flush|change|replace)\b/,
  /^git\s+remote\s+(add|remove|rm|rename|set-url|set-head|set-branches|prune|update)\b/,
  /^git\s+tag\s+(?!(-l|--list|-n\d*|--contains|--points-at|--sort\S*)\b)\S/,
  /^git\s+branch\s+(?!(-a|-r|-l|-v|-vv|--all|--list|--remotes|--verbose|--show-current|--contains|--merged|--no-merged)\b)\S/,
  /^git\s+(log|diff|show)\b.*\s--output\b/,
  /^npm\s+audit\b.*\bfix\b/,
  // Network commands must not carry expanded data outward
  /^(curl|ping|dig|nslookup|host|traceroute)\b.*[$@]/,
];

const CURL_SAFE_FLAG = /^(-[sSLIvf]+|--silent|--show-error|--location|--head|--verbose|--fail)$/;

const MAX_READ_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * Split a bash command into segments on every unquoted control operator
 * (&&, ||, ;, |, |&, &, newline) and note any construct that lets a
 * "read-only" command execute code or write files.
 *
 * Quote-aware so that `grep -E "a|b" file` stays one segment.
 */
function parseBash(cmd) {
  const segments = [];
  let cur = '';
  let quote = null;
  let unsafe = null;

  const push = () => { if (cur.trim()) segments.push(cur.trim()); cur = ''; };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const n = cmd[i + 1];

    if (quote === "'") { cur += c; if (c === "'") quote = null; continue; }

    if (c === '\\') { cur += c + (n ?? ''); i++; continue; }

    // Substitutions expand inside double quotes too
    if (c === '`' || (c === '$' && n === '(')) { unsafe = unsafe || 'command substitution'; cur += c; continue; }

    if (quote === '"') { cur += c; if (c === '"') quote = null; continue; }

    if (c === "'" || c === '"') { quote = c; cur += c; continue; }

    if ((c === '<' || c === '>') && n === '(') { unsafe = unsafe || 'process substitution'; cur += c; continue; }

    if (c === '>') {
      // Harmless redirections: 2>&1, >&2, >/dev/null, 2>>/dev/null
      const m = cmd.slice(i).match(/^>>?\s*(&\d+|\/dev\/null(?=$|[\s;|&)]))/);
      if (m) { cur += m[0]; i += m[0].length - 1; continue; }
      unsafe = unsafe || 'output redirected to a file';
      cur += c;
      continue;
    }

    if (c === '\n' || c === ';') { push(); continue; }
    if (c === '&') { push(); if (n === '&') i++; continue; }
    if (c === '|') { push(); if (n === '|' || n === '&') i++; continue; }

    cur += c;
  }

  if (quote) unsafe = unsafe || 'unterminated quote';
  push();
  return { segments, unsafe };
}

function isSegmentReadOnly(segment) {
  const seg = segment.replace(/\s+/g, ' ').trim();
  if (!seg) return true;

  const allowed = READ_ONLY_BASH_COMMANDS.some(p => seg === p || seg.startsWith(p + ' '));
  if (!allowed) return false;

  if (SEGMENT_DENY.some(re => re.test(seg))) return false;

  if (seg === 'curl' || seg.startsWith('curl ')) {
    const args  = seg.split(' ').slice(1);
    const flags = args.filter(a => a.startsWith('-'));
    const urls  = args.filter(a => !a.startsWith('-'));
    if (!flags.every(f => CURL_SAFE_FLAG.test(f))) return false;   // no -d, -F, -T, -X, -o, -K …
    if (urls.length !== 1) return false;
  }

  return true;
}

/**
 * A command is reflex-safe only if it contains no substitution or file
 * redirection and EVERY segment — including every stage of every pipe —
 * is a whitelisted read-only command.
 */
function isBashReadOnly(cmd) {
  const { segments, unsafe } = parseBash(String(cmd || ''));
  if (unsafe) return false;
  if (segments.length === 0) return false;
  return segments.every(isSegmentReadOnly);
}

function checkReadSize(cmd) {
  const pathPatterns = [
    /\bcat\s+(\/[^\s;|&]+)/,
    /\bhead\s+(?:-\d+\s+)?(\/[^\s;|&]+)/,
    /\btail\s+(?:-\d+\s+)?(\/[^\s;|&]+)/,
    /\bless\s+(\/[^\s;|&]+)/,
    /\bmore\s+(\/[^\s;|&]+)/,
  ];
  for (const pattern of pathPatterns) {
    const match = cmd.match(pattern);
    if (match) {
      try {
        const stat = fs.statSync(match[1]);
        if (stat.size > MAX_READ_SIZE) return { path: match[1], size: stat.size };
      } catch {}
    }
  }
  return null;
}

// ── File metadata (git status + sensitivity) ─────────────────────────

// Compute the reversibility-relevant facts for one file path: does it exist, is it
// under version control (in a repo, tracked, and whether the tracked copy already has
// staged changes that an overwrite would lose), and does it look sensitive. This is the
// signal the morality prompt's reversibility test relies on. Shared by Write/Edit
// (resolveFileMetadata) and Bash write targets (resolveBashWriteTargets).
function fileFacts(filePath, cwd) {
  const meta = {
    path: filePath,
    file_exists: fs.existsSync(filePath),
    in_git_repo: false,
    git_tracked: false,
    has_staged_changes: false,
    is_sensitive: false,
    sensitive_reason: null,
  };

  const basename = path.basename(filePath);
  for (const pattern of SENSITIVE_FILE_PATTERNS) {
    if (pattern.test(basename) || pattern.test(filePath)) {
      meta.is_sensitive = true;
      meta.sensitive_reason = `matches sensitive pattern: ${pattern}`;
      break;
    }
  }

  // Resolve relative paths against the command's cwd so git lookups are correct.
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(cwd || process.cwd(), filePath);
  const dir = fs.existsSync(abs) ? (fs.statSync(abs).isDirectory() ? abs : path.dirname(abs)) : path.dirname(abs);
  try {
    const repoRoot = execSync('git rev-parse --show-toplevel', {
      cwd: dir, encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    meta.in_git_repo = true;

    try {
      execSync(`git ls-files --error-unmatch ${JSON.stringify(abs)}`, {
        cwd: repoRoot, encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
      });
      meta.git_tracked = true;
    } catch { meta.git_tracked = false; }

    try {
      const staged = execSync(`git diff --cached --name-only -- ${JSON.stringify(abs)}`, {
        cwd: repoRoot, encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      meta.has_staged_changes = staged.length > 0;
    } catch { meta.has_staged_changes = false; }
  } catch { meta.in_git_repo = false; }

  return meta;
}

function resolveFileMetadata(toolName, toolInput, cwd) {
  const filePath = toolInput && toolInput.file_path;
  if (!filePath) return null;
  if (toolName !== 'Write' && toolName !== 'Edit') return null;
  return fileFacts(filePath, cwd);
}

// Common Bash forms that overwrite or destroy a file, so the reversibility test can be
// applied to Bash too (not just Write/Edit). Returns file facts for each distinct target.
// Deliberately covers the realistic destructive forms; exotic/obfuscated ones tend to
// trip System 0's other checks. Redirections to /dev/null and fd dups are ignored.
function resolveBashWriteTargets(toolName, toolInput, cwd) {
  if (toolName !== 'Bash') return [];
  const cmd = toolInput && toolInput.command;
  if (!cmd || typeof cmd !== 'string') return [];

  const targets = new Set();
  const clean = (p) => p && p.replace(/^["']|["']$/g, '');
  const notDevNull = (p) => p && !/^\/dev\/(null|stdout|stderr)$/.test(p) && !/^&\d+$/.test(p);

  // Output redirection: > file, >> file  (skip 2>&1, >/dev/null, handled by the regex)
  for (const m of cmd.matchAll(/(?:^|[\s;|&])\d*>>?\s*("[^"]+"|'[^']+'|[^\s;|&()]+)/g)) {
    const t = clean(m[1]); if (notDevNull(t)) targets.add(t);
  }
  // mv / cp: last non-flag token is the destination
  for (const m of cmd.matchAll(/(?:^|[\s;|&(])(?:mv|cp)\s+((?:-[^\s]+\s+)*[^\s;|&]+(?:\s+[^\s;|&]+)*)/g)) {
    const args = m[1].split(/\s+/).filter(a => a && !a.startsWith('-'));
    const dest = clean(args[args.length - 1]); if (notDevNull(dest)) targets.add(dest);
  }
  // In-place / truncating tools
  for (const m of cmd.matchAll(/(?:^|[\s;|&(])sed\s+(?:-[^\s]*\s+)*-i[^\s]*(?:\s+-[^\s]+)*\s+(?:(?:'[^']*'|"[^"]*"|[^\s;|&]+)\s+)*("[^"]+"|'[^']+'|[^\s;|&]+)\s*$/gm)) {
    const t = clean(m[1]); if (notDevNull(t)) targets.add(t);
  }
  for (const m of cmd.matchAll(/(?:^|[\s;|&(])(?:tee(?:\s+-a)?|truncate\s+(?:-s\s*\S+\s+))\s+("[^"]+"|'[^']+'|[^\s;|&]+)/g)) {
    const t = clean(m[1]); if (notDevNull(t)) targets.add(t);
  }
  for (const m of cmd.matchAll(/(?:^|[\s;|&(])dd\s+[^\n;|&]*\bof=("[^"]+"|'[^']+'|[^\s;|&]+)/g)) {
    const t = clean(m[1]); if (notDevNull(t)) targets.add(t);
  }
  // rm targets (destruction, not overwrite)
  for (const m of cmd.matchAll(/(?:^|[\s;|&(])rm\s+((?:-[^\s]+\s+)*[^\s;|&]+(?:\s+[^\s;|&]+)*)/g)) {
    for (const a of m[1].split(/\s+/)) { const t = clean(a); if (t && !t.startsWith('-') && notDevNull(t)) targets.add(t); }
  }

  return [...targets].slice(0, 6).map(t => fileFacts(t, cwd));
}

// ── The reflex ───────────────────────────────────────────────────────

/**
 * @returns {{verdict:'APPROVE'|'REJECT'|'ESCALATE', reason:string, gate:string, flags:string[]}}
 *   flags — what the reflex noticed on an ESCALATE; passed up to Systems 1 and 2.
 */
function checkSystem0(toolName, toolInput) {
  const approve  = (gate, reason) => ({ verdict: 'APPROVE',  gate, reason, flags: [] });
  const reject   = (gate, reason) => ({ verdict: 'REJECT',   gate, reason, flags: [] });
  const escalate = (gate, reason, flags = []) => ({ verdict: 'ESCALATE', gate, reason, flags });

  if (EXEMPT_TOOLS.has(toolName)) return approve('exempt-tool', 'Tool has no lasting side effects');

  if (ALWAYS_ESCALATE_TOOLS.has(toolName)) {
    return escalate('always-escalate', `Tool '${toolName}' is configured to always be escalated`, [`tool '${toolName}' is marked always-escalate`]);
  }

  if (toolName === 'Write' || toolName === 'Edit') {
    const fileMeta = resolveFileMetadata(toolName, toolInput);
    if (fileMeta) {
      if (fileMeta.is_sensitive) {
        return escalate('sensitive-file', `Sensitive file: ${fileMeta.sensitive_reason}`, ['target looks like a credentials or secrets file']);
      }
      if (AUTO_EXECUTED_FILE_PATTERNS.some(p => p.test(fileMeta.path))) {
        return escalate('auto-executed-file', 'Target file runs automatically (CI, git hook, shell startup, scheduler, system config)',
                        ['target file is executed automatically — its content matters, not just its reversibility']);
      }
      if (fileMeta.git_tracked && !fileMeta.has_staged_changes) {
        return approve('git-tracked', 'Git-tracked file, no staged changes — fully reversible');
      }
      if (!fileMeta.file_exists) return approve('new-file', 'Creating new file');
    }
  }

  if (toolName === 'Bash') {
    const cmd = String((toolInput && toolInput.command) || '');

    for (const { re, why } of REJECT_BASH_PATTERNS) {
      if (re.test(cmd)) return reject('reflex-reject', `This command ${why}. No context makes that safe.`);
    }

    // Looks dangerous, but context decides: a destructive command is never "read-only".
    for (const pattern of DESTRUCTIVE_BASH_PATTERNS) {
      if (pattern.test(cmd)) {
        return escalate('destructive-bash', `Destructive command pattern ${pattern}`, ['command matches a destructive pattern (deletes, overwrites, or discards data)']);
      }
    }

    if (isBashReadOnly(cmd)) {
      const oversized = checkReadSize(cmd);
      if (oversized) {
        const mb = (oversized.size / 1024 / 1024).toFixed(0);
        return escalate('oversized-read', `Read target too large (${mb}MB): ${oversized.path}`, [`command reads a very large file (${mb}MB)`]);
      }
      return approve('read-only', 'Read-only command');
    }
  }

  return escalate('unrecognised', 'Not recognised by any reflex pattern');
}

module.exports = {
  checkSystem0,
  isBashReadOnly,
  parseBash,
  checkReadSize,
  resolveFileMetadata,
  resolveBashWriteTargets,
  fileFacts,
  EXEMPT_TOOLS,
  ALWAYS_ESCALATE_TOOLS,
  SENSITIVE_FILE_PATTERNS,
  DESTRUCTIVE_BASH_PATTERNS,
  REJECT_BASH_PATTERNS,
  AUTO_EXECUTED_FILE_PATTERNS,
  READ_ONLY_BASH_COMMANDS,
};
