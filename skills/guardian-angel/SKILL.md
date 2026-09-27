---
name: guardian-angel
description: Set up, check, or troubleshoot Guardian Angel, the conscience that gates every Claude Code tool call. Use when the user asks to link, log in to, check the status of, or fix Guardian Angel, or when a tool call is refused or escalated with a GUARDIAN_ANGEL_ prefix in its reason.
---

# Guardian Angel

Every tool call passes a local reflex (System 0). What the reflex cannot settle is
redacted on this machine and sent to the Guardian Angel service, which runs an
intuition (System 1, jev) and a deliberation (System 2, an LLM) under one moral
framework. What they cannot settle comes to the user as an ordinary permission
prompt. Nothing the reflex clears leaves the machine.

## Linking this machine

The quickest path is the web app's **Set up** page: the user chooses Claude Code,
presses the button, and pastes the one command it shows into their own terminal.
That command installs this plugin and links the machine with nothing to type.

If the plugin is already installed, `ga` is on the PATH inside Claude Code, and
the interactive way works too. Ask the user to run, in their own terminal:

```sh
ga login
```

It prints a code and opens the service's **Link a device** page; the user signs in
(Google, GitHub, or Microsoft), enters the code, and approves. Credentials land in
`~/.config/guardian-angel/credentials.json` (mode 0600). Until this is done, every
escalated call is put to the user with the reason "not linked".

If the user is not yet on the alpha allowlist they will see a waitlist page after
signing in; an admin must approve them before `ga login` completes.

## Checking

```sh
ga status
```

Shows the service version, whether System 1 / System 2 are configured server-side,
the linked device, and the account.

## Reading a refusal or escalation

The permission reason carries a prefix:

- `GUARDIAN_ANGEL_REJECT|<tier>|<reason>` — refused. Do not retry the same call;
  explain the reason to the user and propose a different approach.
- `GUARDIAN_ANGEL_ESCALATE|<escalation id>|<reason>` — the user is being asked.
  Wait for their answer. The reasoning is also kept in the web app under
  **Escalations**.
- `GUARDIAN_ANGEL_ESCALATE|internal|…` — the plugin could not reach the service or
  is not linked; the decision is the user's. Suggest `ga status`.

## Troubleshooting

- "not linked": run `ga login`.
- "link was revoked or expired": run `ga login` again; the device was revoked in the
  web app or the account was suspended.
- "service unreachable": check `ga status`; network or service outage. Guardian
  Angel never approves on its own when it cannot evaluate.
- Local log: `~/.config/guardian-angel/hook.log`.
