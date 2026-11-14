import { describe, expect, test } from 'bun:test';

import { closeAll, exitOnSignals } from '../src/utils/shutdown.ts';

describe('shutdown', () => {
  test('closes every browser even when one of them fails', async () => {
    const closed: string[] = [];
    await closeAll([
      () => { throw new Error('sync failure'); },
      async () => { throw new Error('async failure'); },
      async () => { closed.push('bridge'); },
    ]);
    expect(closed).toEqual(['bridge']);
  });

  test('stops waiting for a browser that never closes', async () => {
    const startedAt = Date.now();
    await closeAll([() => new Promise(() => {})], 50);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test('closes the browsers before the process exits on a signal', async () => {
    const events: string[] = [];
    const shutdown = exitOnSignals(() => [async () => { events.push('close'); }], code => { events.push(`exit ${code}`); });
    try {
      await shutdown();
      expect(events).toEqual(['close', 'exit 0']);
    } finally {
      process.removeListener('SIGINT', shutdown);
      process.removeListener('SIGTERM', shutdown);
    }
  });
});
