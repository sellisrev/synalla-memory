# Secret scrubber: blind sets written by another model

The held-out set in `../heldout.mjs` was written by the people who built the scrubber, and it is no longer blind (its
misses shaped the 24 Nov rules). The release claim needs sets written by someone who never saw the scrubber. An
outside person has not been recruited yet, so these sets are a stand-in: two models (Claude Sonnet and Claude Opus),
asked through Claude Code with no tools and no project files, each wrote 50 snippets on each of 10 themes (half with
secrets, half with harmless look-alikes). The prompt (`write.mjs`) describes realistic text only; it never shows the
scrubber, its rules or the earlier sets. It is still a model from the same family as the one that built the
scrubber, so it is weaker evidence than a person outside the project, and it is reported as such.

## Set 1 (27 Nov): retired, now the tuning set

Measured once, blind, on the scrubber as it was: **54.8% of 604 secrets caught (95% interval 50.8–58.7%), 16.9% of
498 harmless snippets changed (13.8–20.4%)**, far from the 99.8% of our own held-out set. The misses were whole
classes the rules did not cover: passwords in French and German prose, on command lines and in tables, recovery-code
lists, more config names, session cookies, webhook URLs, several token formats; the false positives were
placeholders (`sk-...`, `<password>`), masked values and public key material.

The set was then read and used to write the 27 Nov rules (general rules for those classes, never a rule for one
example). On it the new scrubber catches 95.7% and changes 1.2%, which is a tuning number, not evidence. The older
sets did not move (held-out 99.8% / 0%, tuning 99.3% / 0%).

## Set 2 (27 Nov): the blind measurement

Ten new themes (`THEMES_2` in `write.mjs`), the same prompt and writers, written after the 27 Nov rules were frozen.
Rules, fixed before it was written:

- **Set.** Every snippet as written, except those whose listed secrets do not occur in their text (dropped, counted).
  The writer's judgement of what is a secret is kept as is.
- **Caught:** no 8 characters of the secret in a row remain in the scrubbed text (for secrets shorter than 8, the
  secret itself does not remain). When the listed secret is a whole URL with a password in it
  (`scheme://user:password@host`), only the password counts: scheme, user name, host, port and path are not secret.
- **False positive:** a harmless snippet changed at all.
- **Reported:** caught and changed, with Wilson 95% intervals, by writer and by theme. The release bar is the M1 exit:
  at least 95% caught; false positives published.
- **Blind use.** Its misses and false positives are not read before the number is recorded here. A change made after
  reading them needs a fresh set.

**Result (27 Nov, recorded before any miss was read):** 996 snippets (1 dropped), **544 of 603 secrets caught =
90.2% (95% interval 87.6–92.3%); 21 of 497 harmless snippets changed = 4.2% (2.8–6.4%)**. Sonnet's snippets 272/298,
Opus's 272/305. The M1 bar (95% caught) is **not met**. Set 2 is now retired to tuning as well; the next change is
measured on a set 3.

## Round 3 rules (27 Nov), from set 2

Set 2's misses and false positives were read and turned into rules for classes, never for one example:

- **Secrets now caught:** "the key is VALUE" or "der neue ist VALUE" with no colon; "Auth Token VALUE" right after its
  name; PHP `define('DB_PASSWORD', ...)` and `'dbpassword' => ...` arrays; salts; `$cred = "..."`; XML elements such as
  `<Pass>...</Pass>`; game-server config lines (`rcon_password "..."`), `sv_setsteamaccount` tokens and `steamcmd +login`;
  `ldapsearch -w`; WooCommerce `ck_`/`cs_` and RubyGems keys; `consumer_secret=` in URLs; recovery-code lists made of
  plain letters and digits; one-line codes in groups ("K7QM 2XRT 9WLP ..."); table columns whose name ends in a secret
  word ("Shared secret", "Backup code"); German compound words such as "webpasswort"; domain transfer auth codes; TOTP
  seeds; generated 16-letter app passwords; login cookies (`wordpress_logged_in_...=`, `steamLoginSecure=`).
- **Now left alone:** the DER prefix of RSA public keys (`MIIBIjANBgkqhkiG9w0BAQEFAAOC...`), key thumbprints, minisign
  public keys, `data:` URIs, AWS ARNs, `$(cat ...)` command substitution, key ids (`key_01H...`, `rsa4096/0x...`,
  "signing key: 0x..."), UPS tracking numbers, webhook body signatures (`X-...-Hmac-Sha256:`), idempotency keys,
  WordPress default values ("put your unique phrase here"), `xoxb-your-token-here`, and a French elision (`l'admin`)
  is no longer read as an opening quote.
- **Left as misses on purpose:** `changeme123` (a default-looking value; treating it as a secret would also hide
  `.env.example` lines), a photocopier code with no secret word near it, and a Stripe secret key whose first characters
  the writer copied into the publishable key next to it (the publishable key is public and stays).
- **Accepted false positives:** AWS access key ids (`AKIA...`) are always hidden, even when the text says the key is
  inactive: an id alone is not a secret, but hiding one costs little and the format is never anything else.

Tuning numbers (not evidence): set 2 **99.3% caught (98.3–99.7%), 0.8% harmless changed (0.3–2.1%)**; set 1 96.2% /
1.2%; the held-out set 99.8% / 0% and the tuning set 99.3% / 0% did not move. Against the scrubber before this round,
no secret of sets 1 or 2 went from caught to missed and no harmless snippet went from unchanged to changed.

## Set 3 (27 Nov): the blind measurement for round 3

Ten new themes (`THEMES_3` in `write.mjs`), the same prompt and writers, written after the round 3 rules were frozen
(commit before the set was written). The set 2 rules apply unchanged: snippets whose listed secrets are not in their
text are dropped and counted; caught = no 8 characters of the secret in a row remain (a whole URL with a password
counts by its password); a harmless snippet changed at all is a false positive; Wilson 95% intervals by writer and by
theme; the bar is at least 95% caught, false positives published. The number is recorded here before any miss or false
positive is read.

**Result (27 Nov, recorded before any miss was read; scrubber as frozen in 49b919b):** 996 snippets (0 dropped),
**551 of 606 secrets caught = 90.9% (95% interval 88.4–93.0%); 17 of 497 harmless snippets changed = 3.4%
(2.1–5.4%)**. Sonnet's snippets 266/299, Opus's 285/307. The M1 bar (95% caught) is **not met**.

What the three blind sets say together: on its tuning set each round of rules reaches 96–99%, and on the next set of
new themes it falls back to about 90% (set 2: 90.2%, set 3: 90.9%). Rules for the classes already seen do not reach
the classes a new theme brings. More rounds of the same kind would keep chasing the next theme, so the next step is a
different kind of check, not a round 4 of rules: a general one (a random-looking value anywhere on a line that names a
secret, or a small local model asked about the lines rules leave alone), designed without reading set 3's misses,
then measured on set 3 once and confirmed on a fresh set 4. Until then the published number is 90.9%.

The sets themselves are kept out of the public repository: their invented keys look real enough that GitHub's push
protection (and any secret scanner copying the repository) treats them as leaks. The writers' replies are kept
locally and can be shared on request; `write.mjs` writes a new set of the same kind.

Run: `node benchmark/scrub/blind/write.mjs [--set 2|3]`, then
`node --import ./tools/ts-resolve.mjs benchmark/scrub/blind/eval.mjs [--set 2|3]` from the repo root.
