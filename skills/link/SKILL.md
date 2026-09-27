---
name: link
description: Link this machine to the user's Guardian Angel account with a token from the Set up page. Use when the user runs /guardian-angel:link <token>, pastes a token that starts with gal_, or when a Guardian Angel message says this machine is not linked.
allowed-tools: Bash(ga setup *), Bash(ga status *)
---

# Link this machine to Guardian Angel

The user has a single-use link token (`gal_…`) from https://ga.linbeck.app/setup. The
approval already happened in the browser; redeeming the token here is all that is left.

Token: `$ARGUMENTS`

1. If no token was given, ask the user to open the Set up page, choose Claude Code,
   press the button, and paste the token it shows.
2. Run, in one Bash call (the plugin puts `ga` on the PATH; do not install anything):

   ```sh
   ga setup --harness claude-code --skip-adapter --token $ARGUMENTS
   ```

3. Report the result in one line. On success it prints `Linked "<device name>"`; tell the
   user Guardian Angel now judges every tool call in this and future sessions.
4. If it fails with "already used" or "expired", ask for a fresh token from the Set up
   page; every other failure is worth showing verbatim.

Never ask the user for the token in chat if they have already pasted it as the argument.
