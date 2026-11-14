export const SHUTDOWN_TIMEOUT_MS = 10_000;

export async function closeAll(closers: Array<() => unknown>, timeoutMs = SHUTDOWN_TIMEOUT_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); });
  try {
    await Promise.race([Promise.allSettled(closers.map(close => Promise.resolve().then(close))), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function exitOnSignals(closers: () => Array<() => unknown>, exit: (code: number) => void = code => process.exit(code)) {
  const shutdown = async () => {
    await closeAll(closers());
    exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return shutdown;
}
