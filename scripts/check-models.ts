#!/usr/bin/env bun

import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: `http://localhost:${process.env.UNIFIED_PORT || 3260}` },
    provider: { type: 'string', multiple: true },
    timeout: { type: 'string', default: '20' },
    concurrency: { type: 'string', default: '8' },
    web: { type: 'boolean', default: false },
    verbose: { type: 'boolean', short: 'v', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`Usage: bun run models:check [options]

Asks the running gateway to send a one-word prompt to every model at once and hide the ones
that do not answer, so /v1/models and the auto chains only offer working models. Hidden models
come back after 24 hours or on the next check. Rate limits and key errors never hide a model.

  --provider <id>       check only this provider (repeatable)
  --timeout <seconds>   wait this long for the first chunk (default: 20)
  --concurrency <n>     parallel requests per provider (default: 8)
  --web                 also check browser chat providers (slow, one at a time)
  -v, --verbose         list every failing model with its error
  --url <url>           gateway address (default: http://localhost:3260)`);
  process.exit(0);
}

interface Line {
  type: 'result' | 'provider' | 'done' | 'error';
  provider?: string;
  model?: string;
  ok?: boolean;
  hidden?: boolean;
  error?: string;
  skipped?: string;
  stopped?: string;
  message?: string;
  checked?: number;
  working?: number;
  visibleModels?: number;
  durationMs?: number;
}

const response = await fetch(`${values.url!.replace(/\/$/, '')}/v1/gateway/models/check`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(process.env.GATEWAY_API_KEY ? { Authorization: `Bearer ${process.env.GATEWAY_API_KEY}` } : {}),
  },
  body: JSON.stringify({
    providers: values.provider,
    timeoutSeconds: Number(values.timeout),
    concurrency: Number(values.concurrency),
    includeWeb: values.web,
  }),
}).catch((error: Error) => {
  console.error(`Switchyard is not reachable at ${values.url}: ${error.message}`);
  process.exit(1);
});
if (!response.ok || !response.body) {
  console.error(`Check failed: ${response.status} ${await response.text()}`);
  process.exit(1);
}

const byProvider = new Map<string, { working: number; hidden: number; failed: number }>();
const failures: string[] = [];
const notes: string[] = [];
let checked = 0;
let working = 0;
const tty = process.stderr.isTTY;

function handle(line: Line) {
  if (line.type === 'result') {
    checked++;
    const counts = byProvider.get(line.provider!) ?? { working: 0, hidden: 0, failed: 0 };
    if (line.ok) {
      working++;
      counts.working++;
    } else {
      if (line.hidden) counts.hidden++;
      else counts.failed++;
      failures.push(`  ${line.hidden ? '✗' : '!'} ${line.model}  ${line.error ?? ''}`);
    }
    byProvider.set(line.provider!, counts);
    if (tty) process.stderr.write(`\rChecked ${checked} models · ${working} working · ${checked - working} not`);
  } else if (line.type === 'provider') {
    notes.push(line.skipped ? `  ${line.provider}: skipped, ${line.skipped}` : `  ${line.provider}: stopped early, ${line.stopped}`);
  } else if (line.type === 'error') {
    notes.push(`  error: ${line.message}`);
  } else if (line.type === 'done') {
    if (tty) process.stderr.write('\n');
    const rows = [...byProvider].sort(([a], [b]) => a.localeCompare(b));
    console.log('\nProvider'.padEnd(28) + 'working  hidden  failed');
    for (const [provider, counts] of rows) {
      console.log(`${provider.padEnd(27)}${String(counts.working).padStart(7)}  ${String(counts.hidden).padStart(6)}  ${String(counts.failed).padStart(6)}`);
    }
    if (notes.length) console.log(`\n${notes.join('\n')}`);
    if (values.verbose && failures.length) console.log(`\nNot working (✗ hidden, ! kept because of a rate limit or key error):\n${failures.sort().join('\n')}`);
    console.log(`\n${line.working}/${line.checked} models answered in ${((line.durationMs ?? 0) / 1000).toFixed(0)}s; /v1/models now lists ${line.visibleModels}.`);
  }
}

const decoder = new TextDecoder();
let buffer = '';
for await (const chunk of response.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline: number;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const text = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (text) handle(JSON.parse(text) as Line);
  }
}
