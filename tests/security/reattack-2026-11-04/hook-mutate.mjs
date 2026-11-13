/**
 * Bootstrap for the in-memory mutation hooks: `module.register` runs the hooks on Node's
 * own async loader thread, so normal URL resolution (file://) is preserved.
 *
 * No RT_MUT => plain run, the hook module is not registered (the "before" baseline must
 * run unmodified).
 *
 * Author: PT-dove
 */

import { register } from 'node:module';

if (process.env.RT_MUT) {
  register('./hook-impl.mjs', import.meta.url);
}
