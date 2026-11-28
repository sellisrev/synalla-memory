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
