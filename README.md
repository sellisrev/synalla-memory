# Synalla memory

Owned memory for the agents you already run (Claude Code, Hermes, OpenClaw, any MCP client): installed with one
command, stored locally and encrypted, filled automatically from your agent sessions, and better at recall than the
agents' built-in memory. It is useful on its own; joining the Synalla network is optional.

Status: early work, not released.

## What it does

- Imports your agent sessions, mail and notes, with secrets scrubbed before anything is stored.
- Answers `recall` with hybrid search (keywords and meaning, fused and reranked) plus dated facts that know what is
  true now.
- Keeps everything in an encrypted local store, with an encrypted backup to a place you choose.

## Limits

- Recall results go to your agent's own model; this package cannot see what that model does with them.
- An agent with a shell running as your user can read what your user can read; see the project's limits notes.

## Licence

AGPL-3.0-only, or a commercial licence.
