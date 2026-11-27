// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Writes a blind set for the secret scrubber (README.md): another model, which never sees the scrubber or its rules,
// writes realistic snippets with planted secrets and harmless look-alikes, by theme. Raw replies are kept in raw/,
// the checked set in set.json. Usage: node benchmark/scrub/blind/write.mjs [--writers sonnet,opus] [--themes 0,3] [--jobs 4]

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const WRITERS = arg('--writers', 'sonnet,opus').split(','), JOBS = Number(arg('--jobs', '4'));
const SET2 = arg('--set', '1') === '2';
const ONLY = arg('--themes', '') ? arg('--themes', '').split(',').map(Number) : null;
const CLAUDE = process.platform === 'win32' ? 'claude.exe' : 'claude';

export const THEMES_2 = [
  'hospital and clinic IT (EHR integrations, HL7/FHIR endpoints, lab systems, staff accounts)',
  'online shops and marketplaces (Shopify, WooCommerce, Etsy, payment terminals, shipping label APIs)',
  'game development and game servers (Steam, Epic, Unity services, Discord bots, dedicated server configs)',
  'accounting, invoicing and banking tools (DATEV, Xero, QuickBooks, open banking APIs, a bookkeeper e-mail)',
  'schools and universities (LMS like Moodle, student portals, exam software, a teacher sharing logins)',
  'open-source maintainers (release signing, package registries, CI secrets, bots on GitHub and GitLab)',
  'data engineering (Airflow, dbt, Snowflake, BigQuery service accounts, Kafka Connect, S3 buckets)',
  'home lab and self-hosting (Proxmox, TrueNAS, Home Assistant, Nextcloud, Pi-hole, Tailscale, Vaultwarden)',
  'travel and booking integrations (airline and hotel APIs, Amadeus, Booking.com, maps and geocoding keys)',
  'freelancers and small agencies (client CMS logins, hosting panels, FTP, domain registrars, shared Google accounts)',
];

export const THEMES = [
  'deploying web services to cloud providers (AWS, GCP, Azure, Fly, Vercel, Hetzner)',
  'CI/CD pipelines and package publishing (GitHub Actions, GitLab CI, npm, PyPI, Docker registries)',
  'databases and queues (Postgres, MySQL, MongoDB, Redis, RabbitMQ, Kafka connection strings and configs)',
  'payments, mail and messaging APIs (Stripe, PayPal, SendGrid, Mailgun, Twilio, Slack, Discord, Telegram bots)',
  'AI and data tools (OpenAI, Anthropic, Hugging Face, Replicate, Pinecone, Jupyter notebooks, Colab)',
  'home and personal admin (router and wifi setup, NAS, smart home hubs, a family password note, bank or tax portal logins)',
  'mobile and desktop app development (Firebase, Apple and Google developer accounts, signing keys, keystores)',
  'servers and SSH (private keys, sudo passwords, VPN and WireGuard configs, Kubernetes secrets and kubeconfigs)',
  'everyday mail and chat between colleagues sharing credentials badly (pasted into Slack, email, a ticket)',
  'a coding agent session: the user pastes logs, stack traces and config files while debugging',
];

function prompt(theme) {
  return `You are writing test data for a tool that must remove secrets from text before it is stored.\n`
    + `Theme: ${theme}.\n\n`
    + `Write 50 realistic, varied snippets of the kind of text people keep: messages in a coding-agent session, pasted `
    + `config files and logs, e-mails, chat messages, personal notes. Each snippet 1 to 8 lines, in English, German or French.\n`
    + `- 25 snippets contain one or more SECRETS: credentials that would give access to something (API keys, tokens, `
    + `passwords, private keys, connection strings with passwords, session cookies, signing secrets, recovery codes). `
    + `Invent them, but make them look exactly like the real format, and vary how they appear (inline in prose, in code, `
    + `in a URL, in a table, in a log line, quoted, split across a line break is NOT allowed).\n`
    + `- 25 snippets contain NO secret but things that look similar and are harmless: commit hashes, UUIDs, checksums, `
    + `public keys, key ids and fingerprints, placeholders like <YOUR_API_KEY> or sk-..., masked values like ****, `
    + `variable names without values, references to where a secret is kept ("the password is in 1Password"), `
    + `password rules, order numbers, tracking numbers, IBANs on invoices, file paths.\n\n`
    + `Reply with JSON only, no prose: {"snippets": [{"text": "...", "secrets": ["exact substring", ...]}, ...]}. `
    + `For a harmless snippet "secrets" is []. Each listed secret must be the exact secret value as it appears in the text `
    + `(only the value, not the variable name).`;
}

function ask(text, model) {
  return new Promise((res, rej) => {
    const child = spawn(CLAUDE, ['-p', '--model', model, '--output-format', 'json', '--no-session-persistence', '--tools', '',
      '--strict-mcp-config', '--setting-sources', 'project'], { env: { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => child.kill(), 900000);
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    child.on('close', code => { clearTimeout(t); code === 0 ? res(out) : rej(new Error(`exit ${code}: ${err.slice(-400)}`)); });
    child.stdin.end(text);
  });
}

async function main() {
  const T = SET2 ? THEMES_2 : THEMES;
  const raw = join(HERE, SET2 ? 'raw2' : 'raw'); mkdirSync(raw, { recursive: true });
  const todo = WRITERS.flatMap(w => (SET2 ? THEMES_2 : THEMES).map((t, i) => [w, i])).filter(([, i]) => !ONLY || ONLY.includes(i));
  let next = 0;
  await Promise.all(Array.from({ length: JOBS }, async () => {
    while (next < todo.length) {
      const [w, i] = todo[next++];
      const f = join(raw, `${w}_${String(i).padStart(2, '0')}.json`);
      if (existsSync(f)) continue;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const r = JSON.parse(await ask(prompt(T[i]), w));
          const t = String(r.result ?? '');
          const j = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
          if (!Array.isArray(j.snippets)) throw new Error('no snippets array');
          writeFileSync(f, JSON.stringify({ writer: w, theme: T[i], snippets: j.snippets, cost: r.total_cost_usd ?? null }, null, 1));
          console.log(`${w} theme ${i}: ${j.snippets.length} snippets`);
          break;
        } catch (e) { console.log(`${w} theme ${i} attempt ${attempt}: ${e.message.slice(0, 160)}`); }
      }
    }
  }));
  // Check: every listed secret must occur in its text; snippets with a missing secret are dropped (counted).
  const set = [], dropped = [];
  for (const f of readdirSync(raw).filter(x => x.endsWith('.json')).sort()) {
    const j = JSON.parse(readFileSync(join(raw, f), 'utf8'));
    j.snippets.forEach((s, n) => {
      const ok = typeof s?.text === 'string' && Array.isArray(s.secrets) && s.secrets.every(x => typeof x === 'string' && x.length >= 4 && s.text.includes(x));
      (ok ? set : dropped).push({ id: `${f.replace('.json', '')}-${n}`, writer: j.writer, theme: j.theme, text: s?.text, secrets: s?.secrets });
    });
  }
  writeFileSync(join(HERE, SET2 ? 'set2.json' : 'set.json'), JSON.stringify(set, null, 1));
  console.log(`set: ${set.length} snippets (${set.filter(s => s.secrets.length).length} with secrets, ${set.reduce((a, s) => a + s.secrets.length, 0)} secrets); dropped ${dropped.length} whose secrets were not in the text`);
}

main();
