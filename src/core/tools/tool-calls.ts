import crypto from 'node:crypto';

export interface ParsedToolCall {
    id: string;
    type: string;
    function: { name: string; namespace?: string; arguments: string };
    index: number;
}

function truncateForPrompt(value: unknown, maxLen = 240): string {
    const text = String(value || '');
    return text.length > maxLen ? text.slice(0, maxLen).trimEnd() + '…' : text;
}

function compactJsonSchema(schema: any, depth = 0): any {
    if (!schema || typeof schema !== 'object' || depth > 2) return schema;
    if (Array.isArray(schema)) return schema.slice(0, 20).map(item => compactJsonSchema(item, depth + 1));

    const out: Record<string, any> = {};
    for (const key of ['type', 'enum', 'required', 'default']) {
        if (schema[key] !== undefined) out[key] = schema[key];
    }
    if (schema.description) out.description = truncateForPrompt(schema.description, depth === 0 ? 180 : 90);
    if (schema.properties && typeof schema.properties === 'object') {
        out.properties = {};
        for (const [name, prop] of Object.entries(schema.properties)) {
            out.properties[name] = compactJsonSchema(prop, depth + 1);
        }
    }
    if (schema.items) out.items = compactJsonSchema(schema.items, depth + 1);
    if (schema.oneOf) out.oneOf = compactJsonSchema(schema.oneOf, depth + 1);
    if (schema.anyOf) out.anyOf = compactJsonSchema(schema.anyOf, depth + 1);
    return out;
}

export function normalizeToolDefinitions(tools: any): any {
    if (!Array.isArray(tools)) return tools;
    return tools.flatMap(tool => {
        if (tool?.type !== 'namespace' || !tool?.name || !Array.isArray(tool?.tools)) return [tool];
        return tool.tools
            .map((inner: any) => {
                const fn = inner?.function || inner;
                if (!fn?.name) return null;
                return {
                    type: 'function',
                    function: {
                        name: fn.name,
                        namespace: tool.name,
                        qualified_name: `${tool.name}.${fn.name}`,
                        description: [tool.description, fn.description].filter(Boolean).join('\n\n'),
                        parameters: fn.parameters || { type: 'object', properties: {} }
                    }
                };
            })
            .filter(Boolean);
    });
}

export function toolsToPrompt(tools: any) {
    tools = normalizeToolDefinitions(tools);
    if (!Array.isArray(tools) || tools.length === 0) return '';

    const priorityNames = new Set([
        'skill_view', 'skills_list', 'skill_manage',
        'read_file', 'search_files', 'write_file', 'patch', 'terminal', 'process',
        'web_search', 'web_extract', 'session_search', 'todo', 'clarify', 'delegate_task'
    ]);

    const schemas = tools.map((tool: any) => {
        const fn = tool?.function || tool;
        if (!fn?.name) return null;
        return {
            name: fn.qualified_name || (fn.namespace ? `${fn.namespace}.${fn.name}` : fn.name),
            description: truncateForPrompt(fn.description || '', priorityNames.has(fn.name) ? 420 : 180),
            parameters: compactJsonSchema(fn.parameters || { type: 'object', properties: {} }),
            priority: priorityNames.has(fn.name) ? 0 : 1
        };
    }).filter((schema: any): schema is { name: string; description: string; parameters: any; priority: number } => Boolean(schema))
        .sort((a: { priority: number; name: string }, b: { priority: number; name: string }) => a.priority - b.priority || a.name.localeCompare(b.name));

    if (schemas.length === 0) return '';

    const toolNames = schemas.map(s => s.name).join(', ');
    const skillRules = schemas.some(s => s.name === 'skill_view') ? `
SKILL RULES ARE HARD REQUIREMENTS:
- If the system prompt says a skill MUST be loaded, you MUST call skill_view before answering.
- If the user asks about Hermes Agent setup/config/providers/models/tools/skills/gateway/plugins/troubleshooting, FIRST call:
  {"tool_calls":[{"name":"skill_view","arguments":{"name":"hermes-agent"}}]}
- If a task is related to any listed skill category, call skill_view with the most relevant skill name before giving the final answer.
- After receiving a skill_view result, use it, then continue normally or call the next needed tool.
` : '';

    return `

OPENAI-COMPATIBLE TOOL CALLING ADAPTER ACTIVE.
You are behind a proxy that converts your JSON into real OpenAI tool_calls. Native prose like "I will use X" is NOT a tool call.

Available tool names exactly:
${toolNames}

${skillRules}
GENERAL TOOL RULES:
- For greetings, thanks, casual conversation, explanations, and questions answer directly. Never call bash/terminal merely to print or echo a reply.
- For purely informational questions answer from search results or knowledge in a few sentences. Once a search or tool result answers the question, stop; do not run extra commands to verify it.
- Never run installation, download, or setup commands (install, pull, curl | sh, apt, pip, npm install, brew, and similar) unless the user explicitly asked to install something.
- Keep prose replies concise: answer the question first in a few sentences; add sections, lists, or detail only when the user asks for depth.
- For codebase tasks such as implement, fix, refactor, review, test, or inspect, you MUST call read/ls/find/grep/bash or another suitable workspace tool before making claims or giving a final answer.
- Never claim that a file exists, was deleted, changed, tested, or listed unless that fact came from a tool result in the current conversation.
- Do not print a shell command as a suggestion when you can call the corresponding tool yourself.
- Never simulate tools with XML, markdown, or prose such as <bash>...</bash>, <read>...</read>, [调用 read] [{"path":"..."}], Tool call: read (path), Tool call: write (path) followed by Content:, or fenced shell blocks. Emit a real JSON tool call instead.
- When the user asks you to implement, fix, or refactor, continue through inspection, edits, and verification. Do not stop to ask which approach they prefer unless required information cannot be discovered.
- When an action, lookup, file read/write, command, web search, calculation, or verification is needed, CALL A TOOL instead of describing the action.
- If the user asks you to do something, and a suitable tool exists, respond with a tool call first.
- Never invent tool results. After tool results appear in the conversation, use them to continue.
- Use exact tool names from the list above. Do not invent or rewrite namespace separators.
- Bare MCP server labels such as mcp__playwright, mcp__context7, mcp__exa, mcp__memory, mcp__fal_ai, and mcp__sequential_thinking are NOT callable tool names.
- For Playwright, call a concrete browser tool from the available tool names list. Never call bare mcp__playwright.
- Never output an empty tool_calls array. If no tool is needed, answer the user normally in plain text.
- For source-code changes, prefer patch/apply_patch. For a complete file replacement, use write/write_file with the final content.
- For small exact replacements, edit is allowed. Keep oldText/newText source syntax valid and preserve all quotes, backticks, asterisks, and escapes.
- Keep every JSON property name and path as one uninterrupted string. Never insert whitespace or line breaks inside names such as "content", "path", or "oldText".
- JSON string values must escape embedded newlines as \n. The outer tool-call JSON itself must remain valid and minified.
- When write content contains JSON or source code with double quotes, escape every inner double quote as \" so the outer tool-call JSON stays valid.
- Preserve source code exactly inside tool arguments. In particular, CSS comments must use /* comment */ with both asterisk characters.
- Preserve JavaScript and TypeScript delimiters exactly. Template literals containing \${...} require surrounding backticks, and selector strings passed to querySelector/querySelectorAll require quotes or backticks.

TOOL CALL OUTPUT FORMAT — ONLY when actually calling one or more tools, respond with minified JSON, no markdown, no prose:
{"tool_calls":[{"name":"tool_name","arguments":{}}]}

Multiple calls are allowed:
{"tool_calls":[{"name":"skill_view","arguments":{"name":"hermes-agent"}},{"name":"terminal","arguments":{"command":"pwd"}}]}

Supported fallback shapes also work, but the format above is preferred.

Compact tool schemas:
${JSON.stringify(schemas.map(({priority, ...schema}) => schema), null, 2)}

If no tool is needed and no skill rule applies, do not output JSON and answer normally in plain text.`;
}

const TOOL_CALL_JSON_KEYS = [
    'tool_calls', 'function_call', 'tool_call', 'name', 'tool', 'function',
    'arguments', 'args', 'input', 'path', 'content', 'edits', 'oldText', 'newText',
    'command'
];

export function repairToolCallJsonKeys(text: string) {
    let repaired = text;
    for (const key of TOOL_CALL_JSON_KEYS) {
        const splitKey = key.split('').join('\\s*');
        repaired = repaired.replace(new RegExp(`"${splitKey}"\\s*:`, 'g'), `"${key}":`);
    }
    return repaired;
}

export function extractFirstToolCallObject(text: string) {
    const start = text.indexOf('{"tool_calls"');
    return start < 0 ? null : balancedObjectAt(text, start);
}

function balancedObjectAt(text: string, start: number) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
        const char = text[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === '{') depth++;
        else if (char === '}' && --depth === 0) return text.slice(start, index + 1);
    }
    return null;
}

export function hasObviouslyBrokenEditArguments(rawArgs: any) {
    let args;
    try {
        args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
    } catch {
        return true;
    }
    if (!args || !Array.isArray(args.edits)) return false;

    return args.edits.some((edit: any) => {
        const source = edit?.newText;
        if (typeof source !== 'string') return false;
        const hasInterpolationWithoutBackticks = source.includes('${') && !source.includes('`');
        const hasUnquotedSelector = /\bquerySelector(?:All)?\(\s*[.#][^"'`)]/.test(source);
        return hasInterpolationWithoutBackticks || hasUnquotedSelector;
    });
}

export function repairEditArguments(rawArgs: any) {
    let args;
    try {
        args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : structuredClone(rawArgs);
    } catch {
        return rawArgs;
    }
    if (!args || !Array.isArray(args.edits)) return args;

    for (const edit of args.edits) {
        for (const field of ['oldText', 'newText']) {
            if (typeof edit?.[field] !== 'string') continue;
            let source = edit[field];
            source = source.replace(
                /\bquerySelector(All)?\(\s*([.#][^)\n]*\$\{[^)\n]*\}[^)\n]*)\)/g,
                (_match, all = '', selector) => `querySelector${all}(\`${selector}\`)`
            );
            source = source.replace(
                /^(\s*[\w.[\]]+\.textContent\s*=\s*)([^;\n]*\$\{[^;\n]*\}[^;\n]*);/gm,
                (_match, prefix, value) => `${prefix}\`${value.trim()}\`;`
            );
            edit[field] = source;
        }
    }
    return args;
}

const JSON_ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

function decodeLooseJsonString(raw: string) {
    return raw.replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (_, escape: string) => escape.length === 5 ? String.fromCharCode(parseInt(escape.slice(1), 16)) : JSON_ESCAPES[escape]!);
}

export function recoverLooseEditCall(text: string) {
    const start = /\{\s*"name"\s*:\s*"edit"\s*,\s*"arguments"\s*:\s*\{/.exec(text);
    if (!start) return null;
    const body = text.slice(start.index + start[0].length);
    const path = /^\s*"path"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"edits"\s*:\s*\[\s*\{\s*"oldText"\s*:\s*"/.exec(body);
    if (!path) return null;
    const rest = body.slice(path[0].length);
    const end = rest.search(/"\s*\}\s*\]\s*\}?\s*\}?\s*\]?\s*\}?\s*$/);
    if (end < 0) return null;
    const edits = rest.slice(0, end).split(/"\s*\}\s*,\s*\{\s*"oldText"\s*:\s*"/).map(piece => {
        const parts = piece.split(/"\s*,\s*"newText"\s*:\s*"/);
        return parts.length === 2 ? { oldText: decodeLooseJsonString(parts[0]!), newText: decodeLooseJsonString(parts[1]!) } : null;
    });
    if (!edits.length || edits.some(edit => !edit)) return null;
    return [{ name: 'edit', arguments: { path: decodeLooseJsonString(path[1]!), edits } as Record<string, unknown> }];
}

export function recoverSimpleToolCalls(text: string) {
    const normalized = repairToolCallJsonKeys(text);
    const starts = [...normalized.matchAll(/\{\s*"name"\s*:\s*"(write|read)"\s*,\s*"arguments"\s*:\s*\{/g)];
    if (starts.length === 0) return null;

    const calls = [];
    for (let index = 0; index < starts.length; index++) {
        const name = starts[index][1];
        const start = starts[index].index;
        const end = index + 1 < starts.length ? starts[index + 1].index : normalized.length;
        const chunk = normalized.slice(start, end);
        const pathMatch = chunk.match(/"path"\s*:\s*"([^"]+)"/);
        if (!pathMatch) return null;
        const path = pathMatch[1].replace(/\s+/g, match => /[\r\n]/.test(match) ? '' : match);

        if (name === 'read') {
            calls.push({ name, arguments: { path } });
            continue;
        }

        const contentStart = chunk.search(/"content"\s*:\s*"/);
        if (contentStart < 0) return null;
        const afterOpeningQuote = chunk.indexOf('"', contentStart + chunk.slice(contentStart).indexOf(':') + 1) + 1;
        const contentEnd = chunk.lastIndexOf('"}');
        if (afterOpeningQuote <= 0 || contentEnd < afterOpeningQuote) return null;
        calls.push({
            name,
            arguments: {
                path,
                content: chunk.slice(afterOpeningQuote, contentEnd).replace(/\\n/g, '\n')
            }
        });
    }
    return calls;
}

export function recoverBrokenBashToolCall(text: string) {
    const normalized = repairToolCallJsonKeys(text);
    const opener = /"name"\s*:\s*"(bash|terminal)"[\s\S]*?"command"\s*:\s*"/.exec(normalized);
    if (!opener) return null;
    const start = opener.index + opener[0].length;
    let end = -1;
    for (let index = normalized.length - 1; index >= start; index--) {
        const char = normalized[index];
        if (char === '"') {
            end = index;
            break;
        }
        if (!/[\s}\]]/.test(char)) break;
    }
    if (end < 0) return null;
    let command = normalized.slice(start, end).replace(/\\?"\s*\}+\s*$/, '').trimEnd();
    if (unbalancedQuotes(command) && command.endsWith('"')) command = command.slice(0, -1);
    command = command.replace(/\\(.)/g, (sequence: string, char: string) => {
        if (char === 'n') return '\n';
        if (char === 't') return '\t';
        if (char === 'r') return '\r';
        if (char === '"' || char === '\\') return char;
        return sequence;
    });
    if (!command.trim()) return null;
    return { name: opener[1], arguments: { command } };
}

function unbalancedQuotes(text: string) {
    return (text.replace(/\\./g, '').match(/"/g)?.length ?? 0) % 2 === 1;
}

const DSML = '[\\uff5c|]+\\s*DSML\\s*[\\uff5c|]+\\s*';

function recoverDsmlToolCalls(text: string) {
    const invoke = new RegExp(`<${DSML}invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)</${DSML}invoke>`, 'g');
    const parameter = new RegExp(`<${DSML}parameter\\s+name="([^"]+)"([^>]*)>([\\s\\S]*?)</${DSML}parameter>`, 'g');
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    for (const [, name, body] of text.matchAll(invoke)) {
        const args: Record<string, unknown> = {};
        for (const [, key, attributes, raw] of body!.matchAll(parameter)) {
            const value = raw!.trim();
            let parsed: unknown = value;
            if (!/string="true"/.test(attributes!) || key === 'arguments') {
                try {
                    parsed = JSON.parse(value);
                } catch {}
            }
            if (key === 'arguments' && parsed && typeof parsed === 'object') Object.assign(args, parsed);
            else args[key!] = parsed;
        }
        calls.push({ name: name!, arguments: args });
    }
    return calls.length ? calls : null;
}

export function recoverXmlStyleToolCall(text: string) {
    const outer = text.match(/<function=([A-Za-z0-9_-]+)>\s*([\s\S]*?)\s*<\/function>/i);
    if (outer) {
        const name = outer[1].toLowerCase();
        const args: Record<string, string> = {};
        const paramRe = /<parameter=([A-Za-z0-9_-]+)>\s*([\s\S]*?)\s*<\/parameter>/gi;
        let paramMatch;
        while ((paramMatch = paramRe.exec(outer[2])) !== null) {
            const value = paramMatch[2].trim().replace(/<\/[A-Za-z0-9_-]+>/g, '').trim();
            args[paramMatch[1].toLowerCase()] = value;
        }
        if (Object.keys(args).length > 0) {
            const pathTools = new Set(['read', 'read_file', 'ls', 'find', 'grep', 'search_files']);
            const commandTools = new Set(['bash', 'terminal']);
            if (commandTools.has(name)) return { name: 'bash', arguments: { command: args.command || Object.values(args)[0] } };
            if (pathTools.has(name) && args.path) return { name, arguments: { path: args.path } };
            return { name, arguments: args };
        }
    }

    const block = text.match(/<(bash|terminal|read|ls|find|grep)>\s*([\s\S]*?)\s*<\/\1>/i);
    if (!block) return null;
    const name = block[1].toLowerCase();
    const body = block[2].trim();
    if (name === 'bash' || name === 'terminal') {
        const read = body.match(/^read\s+(.+?)(?:\s+--limit\s+\d+)?$/);
        if (read) return { name: 'read', arguments: { path: read[1].trim() } };
        return { name: 'bash', arguments: { command: body } };
    }
    return { name, arguments: { path: body } };
}

export function recoverChineseStyleToolCall(text: string) {
    const marker = text.match(/\[调用\s+([A-Za-z0-9_-]+)\]\s*/);
    if (!marker || marker.index === undefined) return null;
    const jsonStart = marker.index + marker[0].length;
    const decoder = new TextDecoder();
    const bytes = new TextEncoder().encode(text.slice(jsonStart));
    for (let end = 1; end <= bytes.length; end++) {
        try {
            const parsed = JSON.parse(decoder.decode(bytes.slice(0, end)));
            const args = Array.isArray(parsed) ? parsed[0] : parsed;
            if (!args || typeof args !== 'object') return null;
            return { name: marker[1], arguments: args };
        } catch {
        }
    }
    return null;
}

export function recoverProseStyleToolCalls(text: string) {
    const matches = [...text.matchAll(/^[ \t]*Tool call:\s*([A-Za-z0-9_-]+)\s*\((.*)\)[ \t]*$/gim)];
    if (matches.length === 0) return null;

    const pathTools = new Set(['read', 'read_file', 'ls', 'find', 'grep', 'search_files']);
    const commandTools = new Set(['bash', 'terminal']);
    const writeTools = new Set(['write', 'write_file']);
    const calls = matches.map((match, index) => {
        const name = match[1];
        const value = match[2].trim();
        if (!value) return null;

        if (value.startsWith('{') || value.startsWith('[')) {
            try {
                const parsed = JSON.parse(value);
                const argumentsValue = Array.isArray(parsed) ? parsed[0] : parsed;
                if (argumentsValue && typeof argumentsValue === 'object') {
                    return { name, arguments: argumentsValue };
                }
            } catch {
                return null;
            }
        }

        if (writeTools.has(name)) {
            const segmentStart = (match.index || 0) + match[0].length;
            const segmentEnd = index + 1 < matches.length ? matches[index + 1].index : text.length;
            const segment = text.slice(segmentStart, segmentEnd);
            const contentMarker = segment.match(/^[ \t]*(?:Content|Содержимое):[ \t]*/im);
            if (!contentMarker || contentMarker.index === undefined) return null;
            let content = segment.slice(contentMarker.index + contentMarker[0].length).replace(/^\r?\n/, '').trimEnd();
            const wholeFence = content.match(/^```(?:html|css|javascript|js|typescript|ts|json|text)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
            if (wholeFence) content = wholeFence[1];
            return content ? { name, arguments: { path: value, content } } : null;
        }
        if (commandTools.has(name)) {
            return { name, arguments: { command: value } };
        }
        if (pathTools.has(name)) {
            return { name, arguments: { path: value } };
        }
        return null;
    }).filter(Boolean);
    return calls.length > 0 ? calls : null;
}

export function recoverFencedShellToolCalls(text: string) {
    const fencePattern = /```(?:bash|sh|shell|zsh)[ \t]*\r?\n([\s\S]*?)```/gi;
    const matches = [...text.matchAll(fencePattern)];
    if (matches.length === 0) return null;

    const prose = text.replace(fencePattern, ' ').replace(/\s+/g, ' ').trim();
    const hasExecutionIntent = /(?:давайте|провер(?:им|ю)|посмотр(?:им|ю)|изучу|запущу|выполню|let'?s|i(?:'ll| will) (?:run|check|inspect))/i.test(prose);
    const looksLikeInstructions = /(?:например|пример|запустите|используйте|выполните|for example|run this|use this|command:|(?:run|execute|use) (?:the |this )?command)/i.test(prose);
    if (!hasExecutionIntent || looksLikeInstructions) return null;

    const calls = matches.map(match => {
        const command = match[1].trim();
        if (!command || conversationalShellText('bash', { command })) return null;
        return { name: 'bash', arguments: { command } };
    }).filter(Boolean);
    return calls.length > 0 ? calls : null;
}

const MARKUP = '(?:</?(?:b|strong|em|i)>|\\*\\*|__)*';
const TRANSCRIPT_MARKER = new RegExp(`^[ \\t]*${MARKUP}[ \\t]*(?:(?:Assistant )?tool calls:|Tool result \\()`, 'im');
const NAMED_CALL_MARKER = new RegExp(`^[ \\t]*${MARKUP}[ \\t]*(?:Assistant )?tool calls?:${MARKUP}[ \\t]*([A-Za-z_][\\w.-]*)[ \\t]*${MARKUP}[ \\t]*$`, 'gim');
const ARRAY_CALL_MARKER = new RegExp(`^[ \\t]*${MARKUP}[ \\t]*(?:Assistant )?tool calls:${MARKUP}[ \\t]*(\\[.*)$`, 'im');

export function hasFabricatedTranscript(text: string) {
    return TRANSCRIPT_MARKER.test(text);
}

export function stripFabricatedTranscript(text: string) {
    const match = TRANSCRIPT_MARKER.exec(text);
    return match ? text.slice(0, match.index).trimEnd() : text;
}

function transcriptArguments(value: unknown) {
    if (value && typeof value === 'object') return value as Record<string, unknown>;
    if (typeof value !== 'string') return value === undefined ? {} : null;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

function namedBlockArguments(body: string) {
    const open = body.indexOf('{');
    if (open < 0 || !/^\s*(?:```(?:json)?\s*)?$/i.test(body.slice(0, open))) return null;
    const rest = body.slice(open);
    const paragraph = rest.split(/\n[ \t]*\n|\n?```/)[0]!.trim();
    const balanced = balancedObjectAt(rest, 0);
    for (const candidate of [paragraph, balanced]) {
        const args = candidate ? transcriptArguments(candidate) : null;
        if (args) return { args, trailing: rest.slice(rest.indexOf(candidate!) + candidate!.length).trim() };
    }
    const single = /^\{\s*"([\w-]+)"\s*:\s*"([\s\S]*)"\s*\}$/.exec(paragraph);
    if (!single) return null;
    const value = single[2]!.replace(/\\(["\\n])/g, (_, char: string) => (char === 'n' ? '\n' : char));
    return { args: { [single[1]!]: value }, trailing: rest.slice(paragraph.length).trim() };
}

function recoverNamedToolCalls(text: string) {
    const markers = [...text.matchAll(NAMED_CALL_MARKER)];
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    for (const [index, marker] of markers.entries()) {
        const bodyStart = marker.index! + marker[0].length;
        const parsed = namedBlockArguments(text.slice(bodyStart, markers[index + 1]?.index ?? text.length));
        if (!parsed) break;
        const call = { name: marker[1]!, arguments: parsed.args };
        const key = JSON.stringify(call);
        if (!calls.some(previous => JSON.stringify(previous) === key)) calls.push(call);
        if (parsed.trailing) break;
    }
    return calls.length ? calls : null;
}

function argumentsObjectAt(text: string, start: number) {
    const json = balancedObjectAt(text, start);
    return json ? transcriptArguments(json) : null;
}

function collectTaggedCalls(text: string, pattern: RegExp) {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    for (const match of text.matchAll(pattern)) {
        const args = argumentsObjectAt(text, match.index! + match[0].length - 1);
        if (!args) return null;
        calls.push({ name: match[1]!, arguments: args });
    }
    return calls.length ? calls : null;
}

const KIMI_CALL = /(?:^|<\|tool_call_begin\|>)[ \t]*functions\.([\w-]+):\d+[ \t]*(?:<\|tool_call_argument_begin\|>)?\s*\{/gm;
const REACT_CALL = /^[ \t]*Action:[ \t]*([\w.-]+)[ \t]*\n[ \t]*Action Input:\s*\{/gim;
const TOOL_CALL_TAG = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

export function recoverTaggedToolCalls(text: string) {
    const tagged = [...text.matchAll(TOOL_CALL_TAG)];
    if (tagged.length > 1 || (tagged.length === 1 && tagged[0]![1]!.startsWith('<function='))) {
        const calls = tagged.map(([, inner]) => {
            if (inner!.startsWith('<function=')) return recoverXmlStyleToolCall(inner!);
            try {
                const parsed = JSON.parse(inner!);
                const args = parsed?.arguments ?? parsed?.parameters ?? parsed?.input ?? {};
                return typeof parsed?.name === 'string' ? { name: parsed.name, arguments: typeof args === 'string' ? JSON.parse(args) : args } : null;
            } catch {
                return null;
            }
        });
        if (calls.every(Boolean)) return calls as Array<{ name: string; arguments: Record<string, unknown> }>;
    }
    return collectTaggedCalls(text, KIMI_CALL) ?? collectTaggedCalls(text, REACT_CALL);
}

export function recoverTranscriptStyleToolCalls(text: string) {
    const named = recoverNamedToolCalls(text);
    if (named) return named;
    const marker = ARRAY_CALL_MARKER.exec(text);
    const line = marker?.[1]?.trim();
    if (!line) return null;
    try {
        const parsed = JSON.parse(line);
        if (!Array.isArray(parsed) || !parsed.length) return null;
        const calls = parsed.map(call => {
            const fn = call?.function ?? call;
            const args = transcriptArguments(fn?.arguments ?? fn?.args ?? fn?.input);
            return typeof fn?.name === 'string' && args ? { name: fn.name, arguments: args } : null;
        });
        return calls.every(Boolean) ? calls as Array<{ name: string; arguments: Record<string, unknown> }> : null;
    } catch {
        const name = line.match(/"name"\s*:\s*"([\w.-]+)"/)?.[1];
        const command = line.match(/"command"\s*:\s*\\?"([\s\S]*?)\\?"\s*\}\s*"?(?:\s*\})+\s*\]\s*$/)?.[1];
        if (!name || !command) return null;
        return [{ name, arguments: { command: command.replace(/\\n/g, '\n').replace(/\\"/g, '"') } }];
    }
}

export function conversationalShellText(name: string, rawArgs: any) {
    if (name !== 'bash' && name !== 'terminal') return false;
    let args;
    try {
        args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
    } catch {
        return null;
    }
    if (typeof args?.command !== 'string') return null;
    const match = args.command.match(/^\s*(?:echo|printf(?:\s+%s)?)\s+["']?([\s\S]*?)["']?\s*$/);
    return match ? match[1] : null;
}

function recoveredToolCalls(calls: Array<{ name: string; arguments: unknown } | null> | null, allowedNames: Set<string> | null): ParsedToolCall[] | null {
    if (!calls || calls.some(call => !call || (allowedNames && !allowedNames.has(call.name)))) return null;
    return (calls as Array<{ name: string; arguments: unknown }>).map((call, index) => ({
        id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        index
    }));
}

export function parseToolCallJson(content: unknown, tools: any = null): ParsedToolCall[] | null {
    if (typeof content !== 'string') return null;
    tools = normalizeToolDefinitions(tools);
    const allowedTools = Array.isArray(tools)
        ? new Map<string, any>(tools.map((tool): [string, any] => {
            const fn = tool?.function || tool;
            const qualifiedName = fn?.qualified_name || (fn?.namespace ? `${fn.namespace}.${fn.name}` : fn?.name);
            return [qualifiedName, fn];
        }).filter(([name]) => Boolean(name)))
        : null;
    const allowedNames = allowedTools ? new Set(allowedTools.keys()) : null;
    for (const recovered of [recoverTranscriptStyleToolCalls(content), recoverTaggedToolCalls(content)]) {
        const calls = recovered ? recoveredToolCalls(recovered, allowedNames) : null;
        if (calls) return calls;
    }
    let text = content.trim();
    const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fence) text = fence[1].trim();
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first > 0 || last !== text.length - 1) {
        if (first >= 0 && last > first) text = text.slice(first, last + 1);
    }
    const firstToolCall = extractFirstToolCallObject(content);
    const parseAttempts = [
        text,
        repairToolCallJsonKeys(text),
        firstToolCall,
        firstToolCall ? repairToolCallJsonKeys(firstToolCall) : null
    ].filter((attempt): attempt is string => Boolean(attempt));
    if (/^\s*\{\s*"tool_calls"\s*:\s*\[\s*\{/.test(text) && /\}\]\}\s*$/.test(text)) {
        parseAttempts.push(text.replace(/\}\]\}\s*$/, '}}]}'));
    }
    if (/^\s*\{\s*"tool_calls"\s*:\s*\[/.test(text) && !/\}\s*$/.test(text)) {
        parseAttempts.push(text + '}');
    }
    const extraBraces = text.replace(/"\}\}(?=\s*(?:,\s*\{\s*"name"|\]\s*\}))/g, '"}');
    if (extraBraces !== text) parseAttempts.push(extraBraces);
    if (unbalancedQuotes(text)) parseAttempts.push(text.replace(/(\}+\s*\]\s*\}\s*)$/, '"$1'));
    const objTc = text.match(/^\s*\{\s*"tool_calls"\s*:\s*\{/);
    if (objTc) {
        const fixed = text.replace(/^\s*\{\s*"tool_calls"\s*:\s*\{/, '{"tool_calls":[{') + ']}';
        parseAttempts.push(fixed);
        parseAttempts.push(repairToolCallJsonKeys(fixed));
    }

    for (const candidate of parseAttempts) {
        try {
            const parsed = JSON.parse(candidate);
            let calls: any[] | null = null;
            if (Array.isArray(parsed.tool_calls)) {
                calls = parsed.tool_calls;
            } else if (parsed.function_call || parsed.tool_call) {
                calls = [parsed.function_call || parsed.tool_call];
            } else if (parsed.name || parsed.tool) {
                calls = [parsed];
            }
            if (!calls || calls.length === 0) continue;
            const mappedCalls = calls.map((call: any, index: number): ParsedToolCall | null => {
                const name = call.name || call.tool || call.function?.name;
                const rawArgs = call.arguments ?? call.args ?? call.input ?? call.parameters ?? call.function?.arguments ?? call.function?.parameters ?? {};
                const normalizedArgs = name === 'edit' ? repairEditArguments(rawArgs) : rawArgs;
                const args = typeof normalizedArgs === 'string' ? normalizedArgs : JSON.stringify(normalizedArgs || {});
                if (!name || (allowedNames && !allowedNames.has(name))) return null;
                if (conversationalShellText(name, args)) return null;
                const definition = allowedTools?.get(name);
                return {
                    id: call.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
                    type: 'function',
                    function: {
                        name: definition?.name || name,
                        ...(definition?.namespace ? { namespace: definition.namespace } : {}),
                        arguments: args
                    },
                    index
                };
            }).filter((call): call is ParsedToolCall => call !== null);
            if (mappedCalls.length !== calls.length) continue;
            return mappedCalls;
        } catch {
        }
    }
    const looseEdit = recoverLooseEditCall(content);
    if (looseEdit) {
        const calls = recoveredToolCalls(looseEdit, allowedNames);
        if (calls) return calls;
    }
    const salvaged = salvageCutOffToolCalls(content);
    if (salvaged) {
        const calls = recoveredToolCalls(salvaged, allowedNames);
        if (calls) return calls;
    }
    const recoveredDsml = recoverDsmlToolCalls(content);
    if (recoveredDsml) return recoveredToolCalls(recoveredDsml, allowedNames);
    const recovered = recoverSimpleToolCalls(text);
    if (recovered) return recoveredToolCalls(recovered, allowedNames);
    const recoveredBash = recoverBrokenBashToolCall(text);
    if (recoveredBash && !conversationalShellText(recoveredBash.name, recoveredBash.arguments)) {
        return recoveredToolCalls([recoveredBash], allowedNames);
    }
    const recoveredXml = recoverXmlStyleToolCall(content);
    if (recoveredXml) return recoveredToolCalls([recoveredXml], allowedNames);
    const recoveredChinese = recoverChineseStyleToolCall(content);
    if (recoveredChinese) return recoveredToolCalls([recoveredChinese], allowedNames);
    const recoveredProse = recoverProseStyleToolCalls(content);
    if (recoveredProse) return recoveredToolCalls(recoveredProse, allowedNames);
    const recoveredFencedShell = recoverFencedShellToolCalls(content);
    if (recoveredFencedShell) return recoveredToolCalls(recoveredFencedShell, allowedNames);
    return null;
}


const REJECTED_TOOL_CALL = /Tool [\w.:-]+ does not exists?\.?/;
const FRAGMENT_START = /^\s*[,}\]]/;
const FRAGMENT_END = /\}\s*\}\s*\]\s*\}\s*$/;

const EMPTY_FENCE = /```[\w-]*\s*```/g;

export function stripEmptyFences(text: string) {
    if (!/```[\w-]*\s*```/.test(text)) return text;
    return text.replace(EMPTY_FENCE, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

const CALL_TAIL = /^[^{]*?"[ \t]*\}+[ \t]*\][ \t]*\}[ \t]*(?:\r?\n[ \t]*```)?[ \t]*(?:\r?\n|$)/;

export function stripLeadingCallTail(text: string) {
    const tail = CALL_TAIL.exec(text);
    return tail ? text.slice(tail[0].length).trim() : text;
}

function salvageCutOffToolCalls(text: string) {
    const list = /"tool_calls"\s*:\s*\[/.exec(text);
    if (!list) return null;
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    let index = list.index + list[0].length;
    while (index < text.length) {
        while (index < text.length && /[\s,]/.test(text[index]!)) index++;
        if (text[index] !== '{') break;
        const json = balancedObjectAt(text, index);
        if (!json) break;
        try {
            const call = JSON.parse(json);
            const fn = call?.function ?? call;
            const args = transcriptArguments(fn?.arguments ?? fn?.parameters ?? fn?.input ?? {});
            if (typeof fn?.name !== 'string' || !args) return null;
            calls.push({ name: fn.name, arguments: args });
        } catch {
            return null;
        }
        index += json.length;
    }
    return calls.length ? calls : null;
}

export function hasRejectedToolCall(text: string) {
    return REJECTED_TOOL_CALL.test(text);
}

export function isToolCallFragment(text: string, tools: any = null) {
    if (!text.trim() || parseToolCallJson(text, tools)) return false;
    return FRAGMENT_START.test(text) || FRAGMENT_END.test(text);
}

const TOOL_CALL_MARKUP = /<\/?tool_call>|"arguments"\s*:|"tool_calls/;
const TOOL_DENIAL = /\b(?:do not|don't|doesn't|does not) have (?:access to )?(?:a |an |the |any )?(?:[`"']?[\w.:-]+[`"']? )?tools?\b|\bno tools? (?:is |are )?available\b|\btool (?:named |called )?[`"']?[\w.:-]+[`"']? (?:is not available|isn't available|is unavailable)\b/i;

export function isUnparsedToolCall(text: string, tools: any = null) {
    return TOOL_CALL_MARKUP.test(text) && !parseToolCallJson(text, tools);
}

export function deniesTool(text: string) {
    return TOOL_DENIAL.test(text);
}

export function isBrokenToolCall(text: string, tools: any = null) {
    return hasRejectedToolCall(text) || isToolCallFragment(text, tools) || isUnparsedToolCall(text, tools) || deniesTool(text)
        || (hasFabricatedTranscript(text) && !parseToolCallJson(text, tools));
}

export function stripRejectedToolCalls(text: string) {
    return text.replace(new RegExp(REJECTED_TOOL_CALL.source, 'g'), '').replace(/\n{3,}/g, '\n\n').trim();
}
