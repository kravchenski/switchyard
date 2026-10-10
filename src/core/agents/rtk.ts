const SHELL_TOOLS = /^(?:bash|shell|local_shell|exec_command|run_shell_command|terminal)$/i;
const TIMEOUT_MS = 1_000;
const REMEMBERED = 2_000;

const originals = new Map<string, string>();

function remember(from: string, to: string) {
  originals.delete(to);
  originals.set(to, from);
  if (originals.size > REMEMBERED) originals.delete(originals.keys().next().value!);
}

export type Rewriter = (command: string) => string | undefined;

export interface RtkRewrite {
  from: string;
  to: string;
}

let located: string | null | undefined;

export function rtkPath() {
  if (located === undefined) located = Bun.which('rtk');
  return located;
}

export type RtkRunner = (binary: string, command: string) => { exitCode: number | null; stdout: string };

function runRtk(binary: string, command: string) {
  const { RTK_REWRITE_HOST: _host, ...env } = process.env;
  const result = Bun.spawnSync([binary, 'rewrite', command], { stdout: 'pipe', stderr: 'ignore', timeout: TIMEOUT_MS, env });
  return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

const LINE_FILTER = /^\s*(?:head|tail)(?:\s+(?:-[a-zA-Z]+|-\d+|--[a-z][\w-]*(?:=\S+)?|\+?\d+))*\s*$/;

function firstPipe(command: string) {
  let quote = '';
  let depth = 0;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (char === '\\' && quote !== "'") {
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '$' && command[i + 1] === '(') depth++;
    else if (char === ')' && depth) depth--;
    else if (char === '|' && !depth) {
      if (command[i + 1] === '|') {
        i++;
        continue;
      }
      return command[i + 1] === '&' ? -1 : i;
    }
  }
  return -1;
}

export function splitLineFilters(command: string) {
  const pipe = firstPipe(command);
  if (pipe <= 0) return undefined;
  const filters = command.slice(pipe + 1).split('|');
  if (!filters.every(stage => LINE_FILTER.test(stage))) return undefined;
  const head = command.slice(0, pipe).trimEnd();
  return head ? { head, rest: command.slice(pipe) } : undefined;
}

export function rtkRewriter(binary = rtkPath(), run: RtkRunner = runRtk): Rewriter | undefined {
  if (!binary) return undefined;
  const rewriteOne = (command: string) => {
    const result = run(binary, command);
    if (result.exitCode !== 0 && result.exitCode !== 3) return undefined;
    const rewritten = result.stdout.trim().split('\n').at(-1)?.trim() ?? '';
    return rewritten && rewritten !== command ? rewritten : undefined;
  };
  return command => {
    const direct = rewriteOne(command);
    if (direct) return direct;
    const split = splitLineFilters(command);
    if (!split) return undefined;
    const head = rewriteOne(split.head);
    return head ? `${head} ${split.rest.trimStart()}` : undefined;
  };
}

function rewriteArguments(args: Record<string, unknown>, rewrite: Rewriter, changes: RtkRewrite[]) {
  const apply = (command: string) => {
    const to = rewrite(command);
    if (!to) return command;
    changes.push({ from: command, to });
    remember(command, to);
    return to;
  };
  if (typeof args.command === 'string') return { ...args, command: apply(args.command) };
  if (typeof args.cmd === 'string') return { ...args, cmd: apply(args.cmd) };
  if (Array.isArray(args.command) && args.command.length >= 3 && /^(?:ba|z)?sh$/.test(String(args.command[0])) && /^-l?c$/.test(String(args.command[1]))) {
    const command = [...args.command];
    command[2] = apply(String(command[2]));
    return { ...args, command };
  }
  return args;
}

function restoreArguments(args: Record<string, unknown>) {
  const original = (command: unknown) => (typeof command === 'string' ? originals.get(command) : undefined);
  if (original(args.command)) return { ...args, command: original(args.command) };
  if (original(args.cmd)) return { ...args, cmd: original(args.cmd) };
  if (Array.isArray(args.command) && original(args.command[2])) {
    const command = [...args.command];
    command[2] = original(command[2]);
    return { ...args, command };
  }
  return undefined;
}

export function restoreShellCalls<T extends Record<string, any>>(messages: T[]): { messages: T[]; restored: number } {
  if (!originals.size) return { messages, restored: 0 };
  let restored = 0;
  const next = messages.map(message => {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) return message;
    let changed = false;
    const calls = message.tool_calls.map((call: Record<string, any>) => {
      if (!SHELL_TOOLS.test(String(call?.function?.name ?? ''))) return call;
      let args: unknown;
      try {
        args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments;
      } catch {
        return call;
      }
      const back = args && typeof args === 'object' ? restoreArguments(args as Record<string, unknown>) : undefined;
      if (!back) return call;
      changed = true;
      restored++;
      return { ...call, function: { ...call.function, arguments: JSON.stringify(back) } };
    });
    return changed ? { ...message, tool_calls: calls } : message;
  });
  return { messages: next, restored };
}

export function rewriteShellCalls<T extends Record<string, any>>(toolCalls: T[], rewrite: Rewriter): { toolCalls: T[]; changes: RtkRewrite[] } {
  const changes: RtkRewrite[] = [];
  const rewritten = toolCalls.map(call => {
    const name = call?.function?.name;
    if (typeof name !== 'string' || !SHELL_TOOLS.test(name)) return call;
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      return call;
    }
    if (!args || typeof args !== 'object') return call;
    const next = rewriteArguments(args as Record<string, unknown>, rewrite, changes);
    return next === args ? call : { ...call, function: { ...call.function, arguments: JSON.stringify(next) } };
  });
  return { toolCalls: rewritten, changes };
}
