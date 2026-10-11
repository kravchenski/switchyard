export interface BrowserToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

type BrowserToolContent =
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string };

export interface BrowserToolResult {
    content: BrowserToolContent[];
    isError?: boolean;
}

export interface BridgeSocket {
    send(data: string): void;
    close(code?: number, reason?: string): void;
}

export interface ToolListStore {
    load(): string | undefined;
    save(value: string): void;
}

type ExtensionMessage =
    | { type: 'hello'; version?: string; tools: BrowserToolDefinition[] }
    | { type: 'result'; id: string; result: BrowserToolResult }
    | { type: 'ping' };

interface PendingCall {
    resolve(result: BrowserToolResult): void;
    timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_CALL_TIMEOUT_MS = 120_000;

function errorResult(text: string): BrowserToolResult {
    return { content: [{ type: 'text', text }], isError: true };
}

/** Connects MCP clients to the browser extension: one extension socket, many tool calls matched by id. */
export class BrowserHub {
    private socket: BridgeSocket | undefined;
    private extensionVersion: string | undefined;
    private toolList: BrowserToolDefinition[] | undefined;
    private readonly pending = new Map<string, PendingCall>();
    private nextId = 0;

    constructor(private readonly store?: ToolListStore, private readonly callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS) {}

    get connected() {
        return this.socket !== undefined;
    }

    status() {
        return { connected: this.connected, extensionVersion: this.extensionVersion, tools: this.tools().length };
    }

    /** Tools the extension offered, remembered across restarts so agents see them before the browser connects. */
    tools(): BrowserToolDefinition[] {
        if (!this.toolList) {
            try {
                const saved = this.store?.load();
                this.toolList = saved ? JSON.parse(saved) as BrowserToolDefinition[] : [];
            } catch {
                this.toolList = [];
            }
        }
        return this.toolList;
    }

    open(socket: BridgeSocket) {
        if (this.socket && this.socket !== socket) this.socket.close(4000, 'Replaced by a newer connection');
        this.socket = socket;
    }

    close(socket: BridgeSocket) {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.extensionVersion = undefined;
        for (const [id, call] of this.pending) {
            clearTimeout(call.timer);
            call.resolve(errorResult('The browser extension disconnected before the tool finished'));
            this.pending.delete(id);
        }
    }

    message(socket: BridgeSocket, raw: string) {
        let message: ExtensionMessage;
        try {
            message = JSON.parse(raw) as ExtensionMessage;
        } catch {
            return;
        }
        if (message.type === 'ping') {
            socket.send(JSON.stringify({ type: 'pong' }));
        } else if (message.type === 'hello' && Array.isArray(message.tools)) {
            if (this.socket !== socket) this.open(socket);
            this.extensionVersion = message.version;
            this.toolList = message.tools;
            this.store?.save(JSON.stringify(message.tools));
        } else if (message.type === 'result') {
            const call = this.pending.get(message.id);
            if (!call) return;
            clearTimeout(call.timer);
            this.pending.delete(message.id);
            call.resolve(message.result ?? errorResult('The extension returned no result'));
        }
    }

    call(name: string, args: unknown): Promise<BrowserToolResult> {
        const socket = this.socket;
        if (!socket) {
            return Promise.resolve(errorResult('The Switchyard browser extension is not connected. Open Chrome with the extension installed and check that the bridge is on in its settings.'));
        }
        const id = String(++this.nextId);
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                resolve(errorResult(`The browser did not answer ${name} within ${Math.round(this.callTimeoutMs / 1000)} s`));
            }, this.callTimeoutMs);
            this.pending.set(id, { resolve, timer });
            socket.send(JSON.stringify({ type: 'call', id, name, args: args ?? {} }));
        });
    }
}
