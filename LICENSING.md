# Licensing

Synalla memory is dual-licensed. You may use it under either of these licences:

1. **GNU Affero General Public License, version 3 only** ([LICENSE](LICENSE)). You may use, change and share the code.
   If you share a changed version, or let people use it over a network, you must offer them its full source under the
   same licence.
2. **A commercial licence** from the copyright holder
   ([LICENSES/LicenseRef-Synalla-Commercial.txt](LICENSES/LicenseRef-Synalla-Commercial.txt)), for organisations that
   want to build it into a product or service without publishing their own source. Its terms are set in a separate
   written agreement.

Each source file carries this line:

```
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial
```

## Commercial licence

To ask for one, open an issue titled "Commercial licence" on the GitHub repository, or write to the maintainer through
the contact listed on the GitHub profile. It covers only the files under `AGPL-3.0-only OR LicenseRef-Synalla-Commercial`.

## Third-party code and models

Nothing from another project is copied into this repository. What the package uses keeps its own licence:

| What | Origin | Licence | How it arrives |
|---|---|---|---|
| `better-sqlite3-multiple-ciphers` | npm, pinned | MIT | npm dependency |
| `llama-server` (llama.cpp release archive) | github.com/ggml-org/llama.cpp, pinned build | MIT | downloaded on first use, SHA-256 checked |
| Qwen3-Embedding-0.6B (GGUF, Q8_0) | huggingface.co/Qwen | Apache-2.0 | downloaded on first use, SHA-256 checked |

Dependencies must use a permissive licence (MIT, BSD, ISC, Apache-2.0, 0BSD, Zlib, the Unlicense), so the code can still
be offered under the commercial licence. They are pinned to exact versions and checked before they are added.

## Contributions

Contributions are welcome under the [Contributor Licence Agreement](CLA.md). Without it, contributed code could not be
offered under the commercial licence. You keep the copyright in your contribution, and the project promises to keep it
available under the AGPL as well.
