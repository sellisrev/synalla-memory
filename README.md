# Synalla memory

Owned memory for the agents you already run (Claude Code, Hermes, any MCP client). It is stored on your machine,
encrypted, filled automatically from your agent sessions, and backed up where you choose. It is useful on its own;
joining the Synalla network is optional.

Status: early work, not released. Node 22.18 or later.

## What it does

- **Imports** your Claude Code and Hermes sessions: what you wrote and what the agent answered. Tool output, the
  agent's reasoning and subagent runs are left out. Secrets (API keys, tokens, private keys, passwords) are replaced
  by a marker before anything is stored.
- **Answers `recall`** with passages found by keywords and by meaning, merged, plus dated facts that say what is true
  now and what was replaced, each with the quote it came from. On a laptop CPU a recall takes milliseconds; your
  agent's own model reads the results.
- **Extracts facts** with a chat model you choose: a local one by default. A model that is not on your machine is
  used only after you agree that your records are sent to it.
  Whole items are read (up to 80,000 characters each). Facts are read from mail, notes and what you ask it to `remember`; agent sessions only with `--agent-sessions`,
  because in our measurements facts from work sessions added more noise than help. Sessions are always searchable.
- **Runs the embedding model locally** as a small llama.cpp server on a free local port. A pinned release and the
  model file are downloaded on first use and checked against published checksums.
- **Keeps the store encrypted** (SQLCipher) with its key in your system's keychain (macOS Keychain, the Linux Secret
  Service, Windows DPAPI). On a machine with no keychain (a Linux server, WSL, a container), set
  `SYNALLA_MEMORY_PASSPHRASE` and the keys are kept in files sealed with that passphrase.
- **Backs up** to a sync folder (iCloud Drive, Google Drive, OneDrive, Dropbox and others) or over WebDAV (Koofr,
  Nextcloud, a NAS). Backups are encrypted and incremental. Restoring on a new machine needs the recovery code shown
  once at setup.
- **Exports a readable copy** on request: plain Markdown that opens without this package.

## Using it

```
synalla-memory init                 # creates the store and shows your recovery code once
synalla-memory import               # reads your sessions
synalla-memory serve                # the MCP server: add this command to your agent's MCP settings
synalla-memory backup-to folder <your cloud folder>
synalla-memory backup
synalla-memory status
```

MCP tools: `recall`, `remember`, `facts_about`, `what_changed`.

## Limits

- Results reach your agent as records marked untrusted; this package cannot see what the agent's model does with them.
- Encryption protects a machine that is off or locked. Anyone using your unlocked session can read the keychain, as
  with any keychain.
- An agent with a shell running as your user can read what your user can read, with or without this package.
- Without the recovery code, a lost machine means a lost memory. Keep the code in a password manager or on paper.
- A readable export is not encrypted: anyone who can open that folder can read it.

## Licence

AGPL-3.0-only, or a commercial licence.
