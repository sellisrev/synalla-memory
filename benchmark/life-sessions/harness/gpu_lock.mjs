// Wait while a job on the other model holds work/fast.lock (see ../gpu_lock.py). A lock untouched for 20 minutes
// is stale (its job died) and ignored.
import { statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const LOCK = join(dirname(fileURLToPath(import.meta.url)), '..', 'work', 'fast.lock');
export async function waitFast() {
  for (;;) {
    let m;
    try { m = statSync(LOCK).mtimeMs; } catch { return; }
    if (Date.now() - m > 20 * 60_000) return;
    await new Promise(r => setTimeout(r, 15_000));
  }
}
/** A ChatModel that waits for the lock before each call. */
export const waiting = model => ({ complete: async p => { await waitFast(); return model.complete(p); } });
