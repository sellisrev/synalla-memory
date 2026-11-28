# Money and ID numbers: blind set

Rules written 28 Nov 2026, before any record was written. `src/pii.ts` finds IBANs, payment card numbers, social
security numbers, tax IDs and passport numbers so they get stand-ins (`../../src/pseudonyms.ts`). Its unit tests were
written with it; this set measures it on text written by models that never saw it.

## The set

- **About 400 records** of personal mail, notes and chat, written by Claude Sonnet and Claude Opus subagents in
  batches of 25, each batch with its own theme and language mix (English, German, French, some Spanish, Italian and
  Dutch). The writers are told what to put in, never how the rules work, and do not read this repository.
- **Positive records (about half)** hold one or more money or ID numbers in natural use: rent and invoices with IBANs
  (many countries, with and without spaces), card numbers (grouped, ungrouped, in forms), social security numbers
  (French NIR, UK National Insurance, US SSN, Austrian SV-Nummer, German Sozialversicherungsnummer, others), tax IDs
  (German Steuer-ID, French numéro fiscal, US TIN, Spanish NIF, Italian codice fiscale) and passport numbers.
- **Harmless records (about half)** hold look-alikes and nothing to hide: order, invoice, tracking, customer, booking
  and ticket numbers, phone numbers, dates and times, amounts, postcodes, product codes, version numbers, BIC/SWIFT
  codes alone, masked numbers (`**** 4421`, `DE89 **** 3000`).
- Each record lists the exact values to hide, with their kind.
- **Checksums are made valid after writing:** the harness recomputes IBAN check digits, card Luhn digits and NIR keys
  in each written value (in the text and the truth), because real numbers are valid and writers usually get the
  digits wrong. Masked values are left alone.

## Scoring

- **Caught:** a listed value counts as hidden when neither it nor any 8-character piece of it (its whole self if
  shorter) is left in the output.
- **Harmless changed:** a harmless record in which the rules hide anything.
- Also reported: extra hides in positive records outside the listed values, and results per kind.

## Bars

- At least 95% of listed values caught, overall.
- At most 2% of harmless records changed.

Measured once with the rules as committed when the set is written. If the bars are missed, the misses are read, rules
are fixed class by class, and the fix is measured on a second fresh set written the same way, never on this one.

## Set 1 result (28 Nov, the set's only look, rules at c2d03e9)

400 records (210 positive, 190 harmless), 330 values, no malformed records.

| | Result | Bar |
|---|---|---|
| Values caught | 189/330 = **57.3%** (51.9–62.5) | 95% |
| Harmless records changed | 4/190 = 2.1% (0.8–5.3) | 2% |
| Extra hides in positive records | 2 | |

By kind: IBAN 63/78, card number 29/36, passport number 29/35, social security number 41/98, tax ID 27/83. Both bars
missed. Next, as the rules say: read the misses, fix class by class, measure on a fresh set 2.

## Round 2 (28 Nov, after reading set 1's misses)

`src/pii.ts` rewritten by class: IBANs in any case; card numbers keep their checksum when an expiry or CVC follows,
and accept Amex grouping and more card words (*creditcard*, *tarjeta*, *carta*); shapes precise enough alone
(Italian codice fiscale, Belgian national number, German social security number, German Steuernummer); otherwise a
naming word in many languages (BSN, NUSS, NIE/NIF/DNI, UTR, EIN, ITIN, *pasaporte*, *paspoort*...) followed within a
few words by a number-shaped value, passing over dates and stopping at another label (an order or case number).
Acronyms count only in capitals. Company numbers stay readable: VAT IDs, tax numbers in a company's legal footer,
council tax references. A tax-ID bug is fixed: the match could start inside its own label ("ID 659…").

On set 1, now the tuning set: 317/330 = 96.1% caught, 2/190 = 1.1% harmless changed. On the owner's real mailbox
(1,907 mails, counts only): 7 mails get a stand-in, all correct when read on his PC (5 IBANs, 2 social security
numbers); the 7 company footer tax numbers round 2 first hid are now left alone. Unchanged on the harmless text of
the secrets and injection sets (only real IBANs there). Set 1 also has writer mistakes: 2 "harmless" records hold a
social security number, a tax number and a passport number that were not listed; the scores above count them as
false alarms. Next: fresh set 2, written the same way, measured once.
