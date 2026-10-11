import { z } from 'zod';

const blankToUndefined = (value: unknown) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value;

const port = (fallback: number) =>
    z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65_535).default(fallback));

const text = (fallback: string) => z.preprocess(blankToUndefined, z.string().default(fallback));

const optionalText = z.preprocess(blankToUndefined, z.string().optional());

/** The Switchyard browser extension; its manifest key pins this id. */
export const SWITCHYARD_EXTENSION_ORIGIN = 'chrome-extension://dammhajbcgfiiaokdhfchhncfaknaemj';

const envSchema = z.object({
    UNIFIED_PORT: port(3260),
    HOST: text('127.0.0.1'),
    SESSION_DIR: text('session'),
    GATEWAY_API_KEY: optionalText,
    EXTENSION_ORIGINS: text(SWITCHYARD_EXTENSION_ORIGIN),
    AUTO_MODELS: optionalText,
    WEB_CHAT_MIN_INTERVAL_MS: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).max(600_000).default(2_000)),
    AUTO_FIRST_CHUNK_TIMEOUT_MS: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).max(600_000).default(60_000)),
    WEB_FIRST_CHUNK_TIMEOUT_MS: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).max(600_000).default(150_000)),
    WEB_CHAT_WARMUP: z.preprocess(blankToUndefined, z.enum(['on', 'off']).default('on')),
    MODEL_REFRESH_MINUTES: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).max(10_080).default(360)),
});

export type Config = z.infer<typeof envSchema>;

export function parseEnv(env: Record<string, string | undefined>): Config {
    const result = envSchema.safeParse(env);
    if (!result.success) {
        const issues = result.error.issues.map(issue => `  ${issue.path.join('.')}: ${issue.message}`).join('\n');
        throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    return result.data;
}

export function loadConfig(env: Record<string, string | undefined> = process.env) {
    return parseEnv(env);
}
