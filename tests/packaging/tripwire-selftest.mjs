/**
 * Tripwire self-test: prove the block actually fires.
 *
 * Run as `node --import network-tripwire.mjs tripwire-selftest.mjs`.
 *
 * The negative direction matters more than the positive one: if this script
 * completed a connect, the "zero outbound attempts" result in the launch test
 * would be meaningless, because nothing was being blocked.
 */

import net from 'node:net';

const BLOCK_CODE = 'ERR_M8_NETWORK_BLOCKED';

try {
  const socket = new net.Socket();
  socket.connect({ host: '127.0.0.1', port: 9 });
  socket.destroy();
  process.stderr.write('tripwire selftest: connect was NOT blocked\n');
  process.exit(1);
} catch (error) {
  if (error?.code !== BLOCK_CODE) {
    process.stderr.write(`tripwire selftest: unexpected error ${error?.code ?? error}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, blocked: error.code })}\n`);
}
