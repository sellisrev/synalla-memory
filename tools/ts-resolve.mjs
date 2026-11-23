// SPDX-FileCopyrightText: 2026 Serge Versillé
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Synalla-Commercial

// Lets the tests keep importing '../src/x.js' now that the sources are TypeScript (src/x.ts): a relative '.js'
// or file: URL specifier that does not exist on disk resolves to the '.ts' file next to it. Node runs the '.ts' file itself
// (type stripping, Node >= 22.18). Used as: node --import ./tools/ts-resolve.mjs --test ...
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
import fs from 'node:fs';
export async function resolve(specifier, context, next) {
  const relative = specifier.startsWith('./') || specifier.startsWith('../');
  if ((relative || specifier.startsWith('file:')) && specifier.endsWith('.js')) {
    const js = relative ? new URL(specifier, context.parentURL) : new URL(specifier);
    if (!fs.existsSync(js)) {
      const ts = new URL(js.href.slice(0, -3) + '.ts');
      if (fs.existsSync(ts)) return next(ts.href, context);
    }
  }
  return next(specifier, context);
}`));
