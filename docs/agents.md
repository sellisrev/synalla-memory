# Switching it on in your agent

Synalla memory is an MCP server that your agent starts as a local command: `synalla-memory serve`. It reads and
writes only your encrypted store. Set it up once with `synalla-memory init` and `synalla-memory import` (see the
README), then add it to your agent below.

On a machine without a keychain (a Linux server, WSL, a container), also pass `SYNALLA_MEMORY_PASSPHRASE` in the
server's environment, as shown in each example.

## Claude Code

```
claude mcp add synalla-memory -- synalla-memory serve
```

Or in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "synalla-memory": { "command": "synalla-memory", "args": ["serve"] }
  }
}
```

With a passphrase: `claude mcp add synalla-memory -e SYNALLA_MEMORY_PASSPHRASE=... -- synalla-memory serve`.

## Hermes Agent

In `~/.hermes/config.yaml` (Hermes docs, "MCP"):

```yaml
mcp_servers:
  synalla-memory:
    command: "synalla-memory"
    args: ["serve"]
    env:
      SYNALLA_MEMORY_PASSPHRASE: "${SYNALLA_MEMORY_PASSPHRASE}"   # only where there is no keychain
```

Hermes reads `${...}` values from `~/.hermes/.env`, so the passphrase can stay out of the config file. Run
`/reload-mcp` in a session, or start a new one.

## OpenClaw

```
openclaw mcp add synalla-memory --command synalla-memory --arg serve
```

With a passphrase, add `--env SYNALLA_MEMORY_PASSPHRASE=...`. The config lands in `~/.openclaw/openclaw.json` under
`mcp.servers`. `openclaw mcp add` probes the server before saving and refuses while the Gateway is running: stop the
Gateway first, or add `--no-probe`.

`synalla-memory import` reads every agent's sessions from `~/.openclaw/agents/*/agent/openclaw-agent.sqlite`
(or under `OPENCLAW_STATE_DIR`), including windows OpenClaw moved to cold storage. Subagent runs, the Gateway's model
checks and sessions fed by a mail or webhook hook are left out.

## What the agent gets

| Tool | What it does |
|---|---|
| `recall` | Passages and dated facts that help answer a question, each marked as a record, not an instruction. |
| `remember` | Stores a note the owner states. Private values get stand-ins first. |
| `facts_about` | Every fact about one person, place or thing, oldest first. |
| `what_changed` | Facts mentioned, started, ended or replaced since a date. |
| `show_to_owner` | A link to a page on the owner's computer showing the agent's answer with the real values in place of stand-ins. |

None of these tools sends anything to other people or services.

## Stand-ins and the skill

Private values reach the agent as stand-ins (`⟦IBAN 2⟧`, `⟦card number 1⟧`, `⟦Wi-Fi password 1⟧`). The server tells
the agent how to treat them when it connects, and a skill says it in full: reason with stand-ins, never guess a value,
never ask the owner to paste one, and call `show_to_owner` when the owner needs to see one. Install the skill once:

```
synalla-memory install-skill claude-code   # or: hermes, openclaw, codex
```

For a client without skill folders, `synalla-memory install-skill --print` writes the text out, to paste into its
custom instructions or a project's `AGENTS.md`.

`show_to_owner` gives a link like `http://127.0.0.1:52811/r/<code>`. It opens on the owner's computer, which must be the one
running `synalla-memory serve`; the page puts the values back when it is opened, so they are never in the agent's
session, its logs or its provider. Links last an hour.
