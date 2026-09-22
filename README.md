# guardian-angel-plugin

The Claude Code client adapter for **Guardian Angel**: a PreToolUse hook holding
System 0 (the local reflex), edge redaction, and a thin client to the Guardian
Angel service, plus the `ga` command line for linking a machine.

```
/plugin marketplace add leo3linbeck/guardian-angel-plugin
/plugin install guardian-angel@linbeck-tools
ga login
```

## What runs where

| On this machine (plugin) | In the service |
| --- | --- |
| System 0 reflex — approves what is safe by construction, rejects the intrinsically evil, escalates the rest | System 1 — jev intuition under the morality prompt |
| Script resolution, package lifecycle scripts, download sizing | System 2 — LLM deliberation under the same prompt |
| Secret redaction before anything is transmitted | Prompt registry, audit log, escalation delivery |
| A 15-minute access token and the registration token that mints it | The model credentials, which never leave the service |

The hook fails closed: a timeout, a network failure, a revoked token, or an unlinked
machine puts the decision to you; nothing is ever approved because the guard broke.

## Layout

```
hooks/hooks.json          PreToolUse (60 s) and PostToolUse (10 s)
bin/ga-hook.js            the hook
bin/ga-post-hook.js       reports "you approved it" to the audit log when an escalated call runs
bin/ga.js                 ga login | status | logout
lib/core/                 vendored from conscience-research/tests/harness (scripts/sync-core.mjs)
lib/client.js             credentials, token refresh, JSON API
lib/transcript.js         the principal's request and the agent's history, from the transcript
lib/state.js              pending escalations (call_id → escalation id)
skills/guardian-angel/    tells Claude how to walk a user through setup and refusals
```

## Development

```sh
node scripts/sync-core.mjs ../conscience-research   # refresh lib/core from the source of truth
npm test                                            # hook contract tests against a mock service
GA_SERVICE_URL=https://localhost:5173 node bin/ga.js login --no-browser
```

`GA_CONFIG_DIR` relocates the credentials, state, and log (tests use a temp dir).
