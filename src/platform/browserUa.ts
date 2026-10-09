import { findBrowserExecutable } from './browserExecutable.ts';

export interface BrowserFingerprint {
    version: string;
    major: string;
    userAgent: string;
    secChUa: string;
}

const FALLBACK_VERSION = '141.0.0.0';

function fingerprint(version: string): BrowserFingerprint {
    const major = version.split('.')[0]!;
    return {
        version,
        major,
        userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`,
        secChUa: `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not_A Brand";v="24"`,
    };
}

let cached: BrowserFingerprint = fingerprint(FALLBACK_VERSION);
let started = false;

function detectOnce() {
    if (started) return;
    started = true;
    try {
        const executable = findBrowserExecutable();
        if (!executable) return;
        const proc = Bun.spawn([executable, '--version'], { stdout: 'pipe', stderr: 'pipe' });
        const timer = setTimeout(() => proc.kill(), 1_000);
        new Response(proc.stdout)
            .text()
            .then(text => {
                clearTimeout(timer);
                const version = /(\d+\.\d+\.\d+\.\d+)/.exec(text)?.[1];
                if (version) cached = fingerprint(version);
            })
            .catch(() => clearTimeout(timer));
    } catch {}
}

export function browserFingerprint(): BrowserFingerprint {
    detectOnce();
    return cached;
}

export function browserHeaders(): Record<string, string> {
    const fp = browserFingerprint();
    return {
        'user-agent': fp.userAgent,
        'sec-ch-ua': fp.secChUa,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Linux"',
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
    };
}
