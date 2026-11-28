# Synalla memory

Owned memory for the agents you already run (Claude Code, Hermes, any MCP client). It is stored on your machine,
encrypted, filled automatically from your agent sessions, and backed up where you choose. It is useful on its own;
joining the Synalla network is optional.

Status: early work, not released. Node 22.18 or later.

## What it does

- **Imports** your Claude Code, Hermes and OpenClaw sessions: what you wrote and what the agent answered. Tool output, the
  agent's reasoning and subagent runs are left out.
- **Hides private values behind stand-ins** before anything is stored: secrets (passwords, keys, codes) and money and
  ID numbers (IBAN, card, social security, tax and passport numbers). Each becomes a stand-in that says what it is and
  stays the same everywhere, like `⟦IBAN 2⟧` or `⟦Wi-Fi password 1⟧`, so your agent can still reason with it. The
  values stay in the encrypted store (keys in a provider's own format are dropped). When you need one, your agent
  gives you a link to a page on your own computer that shows its answer with the values back; they never pass
  through the agent's session. Names, phone numbers and addresses stay readable.
- **Imports mail and notes** on request: an mbox file (one item per message, the readable body without quoted
  replies, signatures or attachments; spam and trash left out) and a folder of Markdown or text notes.
- **Answers `recall`** with passages found by keywords and by meaning, merged, plus dated facts that say what is true
  now and what was replaced, each with the quote it came from. On a laptop CPU a recall takes milliseconds; your
  agent's own model reads the results.
- **Extracts facts** with a chat model you choose: a local one by default. A model that is not on your machine is
  used only after you agree that your records are sent to it.
  Whole items are read (up to 80,000 characters each). Facts are read from mail, notes and what you ask it to `remember`; agent sessions only with `--agent-sessions`,
  because in our measurements facts from work sessions added more noise than help. Sessions are always searchable.
- **Runs the embedding model locally** as a small llama.cpp server on a free local port. A pinned release and the
  model file are downloaded on first use and checked against published checksums. On Linux it needs the system library
  libgomp (`sudo apt install libgomp1` on Debian and Ubuntu; most desktops already have it).
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
synalla-memory import-mail <file.mbox>  # your mail, e.g. a Google Takeout export
synalla-memory import-notes <folder>    # Markdown and text notes
synalla-memory check-with builtin      # optional: a small local model checks imports (below)
synalla-memory serve                # the MCP server: add this command to your agent's MCP settings
synalla-memory backup-to folder <your cloud folder>
synalla-memory backup
synalla-memory status
```

`check-with` lets a chat model check what you import: a second look for passwords and keys the rules miss, and a
warning on mail and notes that try to give orders to your AI assistant (prompt injection).

- `check-with builtin`: the recommended setup. It downloads Gemma 4 E4B (Google's own release, 5 GB, checked against
  its published checksum) and runs it on your computer's processor, on the llama.cpp server the package already
  uses, during imports only. On text it never saw: secrets caught 96.8% instead of 94.0% with the rules alone, 4.4%
  of harmless lines hidden by mistake; injections marked 99.2%, 5.2% of harmless test mail, 0.16% of a real mailbox.
  A wrong hide costs little: the value is kept behind its stand-in and your agent can show it to you. About a second
  a record on a fast desktop processor; a first import of years of mail takes hours on a laptop.
- `check-with <url> <model>`: a model you run yourself (llama.cpp, llama-swap, Ollama). With Gemma 4 26B-A4B on a
  GPU: secrets 97.0% caught, 1.4% hidden by mistake; injections 99.7%, 1.2%.
- `check-with <https url> <model> --cloud-ok`: a cloud model, if you choose it. Each checked record is sent there in
  full; its API key is read from standard input and kept in the keychain.

Without a model the rules still run. On a slow computer, the first import of your mail skips the model (the rules
still run; `--check` forces it), and agent sessions always leave it for later, because years of sessions take hours:
`synalla-memory check-backlog --minutes 30` checks the waiting records a slice at a time, in place. New mail is checked
as it arrives. Measurements:
[benchmark/small_models.md](benchmark/small_models.md).

MCP tools: `recall`, `remember`, `facts_about`, `what_changed`, `show_to_owner`. Setting it up in Claude Code, Hermes,
OpenClaw or Codex, with the skill that tells the agent how to handle stand-ins (`synalla-memory install-skill <agent>`):
[docs/agents.md](docs/agents.md).

On Windows, search by meaning runs llama.cpp, which needs the Microsoft Visual C++ runtime. A new PC may not have it,
so the package downloads Microsoft's three runtime files next to the server on first use (pinned and checked, from
[our release](https://github.com/sellisrev/synalla-memory/releases/tag/vcruntime-14.44.35211)); nothing to install.
If that download is blocked, everything still works and search goes by keywords; the commands say so. Checked on a
clean Windows Sandbox with `tools/sandbox/run.ps1`.

## Limits

- Results reach your agent as records marked untrusted; this package cannot see what the agent's model does with them.
- Encryption protects a machine that is off or locked. Anyone using your unlocked session can read the keychain, as
  with any keychain.
- An agent with a shell running as your user can read what your user can read, with or without this package.
- Without the recovery code, a lost machine means a lost memory. Keep the code in a password manager or on paper.
- A readable export is not encrypted: anyone who can open that folder can read it.

## Licence

AGPL-3.0-only, or a commercial licence: see [LICENSING.md](LICENSING.md).
