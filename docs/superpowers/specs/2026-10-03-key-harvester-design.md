# Key Harvester Design

Status: approved, 2026-10-03

## Goal

Let the user add/log in their own accounts in the browser session, then run a single
command that visits each provider's dashboard and automatically obtains (creates if
missing, refreshes if stale) API keys from those logged-in accounts — with explicit
user consent before anything runs.

## Non-goals

- No OAuth apps, no official provider APIs, no Google Cloud keys — browser automation only.
- No scheduled/auto runs: the command starts manually and asks one consent question.
- No billing/plan actions of any kind (see Safety).
- No changes to how keys are resolved at runtime (`savedApiKey()` already picks them up).

## UX (CLI)

New command: `bun run account harvest [--profile <id>] [--provider <id>]`

1. Print what will happen, then ask once:
   `This will open provider dashboards in your browser session and create/update API keys for your logged-in accounts. Continue? (y/n)`
2. `n` → exit 0, nothing touched. `y` → run the harvest.
3. End with a report table:
   `provider | status | detail` where status ∈ `created | updated | unchanged | skipped | failed`,
   detail carries a reason (`not signed in`, `redirected`, `selector mismatch`, …)
   and a key preview (`sk-…a1b2`).

Default profile is `default` (the main session the user signs in with). `--provider`
limits the run to a single provider id from the catalog.

## Architecture

| Piece | File | Responsibility |
|---|---|---|
| Adapter configs | `src/providers/key-adapters.ts` | Per-provider selectors, key pattern, URL; validated against `catalog.ts` |
| Harvest engine | `src/browser/key-harvest.ts` | One browser per run, walks providers, extract/create/store, collects results |
| CLI wiring | `src/cli/accounts.ts` + `scripts/accounts.ts` | `harvest` subcommand, consent prompt, report printing, dependency injection for tests |

### Engine flow (per provider, sequential)

1. Open page, `goto(keyUrl)` (domcontentloaded, 30s timeout).
2. **Host guard**: current URL host must match `keyUrl` host (subdomains allowed).
   Redirect to a login page → `skipped: not signed in` + hint `bun run account connect`.
3. **Extract**: read existing key via adapter `keySelectors` → fallback: scan the DOM
   (input values, `<code>`, visible text) for `keyPattern`.
4. **Create** (only if nothing found): click `createSelectors` (first visible match),
   fill `nameFieldSelectors` with `free-qwen-api-<YYYYMMDD>`, confirm dialogs via
   `confirmSelectors`, wait for the key to appear (15s).
5. **Validate**: length ≥ 16, no whitespace, matches `keyPattern`.
6. **Store** (see Storage), record result, close page, next provider.
7. Any error at any step → `failed` with the manual fallback (`keyUrl` + one-line
   instruction); the run always continues with the remaining providers.

### Adapter config shape

```ts
interface ProviderKeyAdapter {
  provider: string;             // catalog id, e.g. "gemini"
  keyUrl: string;               // must equal catalog keyUrl (test-enforced)
  keyPattern: RegExp;           // provider-shaped key, used for scan + validation
  createSelectors?: string[];   // "Create API key", "Generate key", …
  nameFieldSelectors?: string[];// key-name input on the create form
  confirmSelectors?: string[];  // "I agree" / "Confirm" dialogs
  keySelectors?: string[];      // where an existing key is displayed
}
```

All 21 catalog entries with a `keyUrl` get an adapter. Adapters are data-only; the
engine is provider-agnostic and works even when selectors are missing (host guard +
DOM scan + manual fallback still apply).

### Safety rules

- Click only selectors declared in the adapter config — never generic "clickables".
- Refuse to click any button whose visible text matches `/\b(pay|buy|upgrade|subscribe|billing)\b/i`
  → `failed: refusing to click "<text>"`.
- Host guard runs before every click; a navigation away from the key page aborts
  that provider.
- Fail closed: anything ambiguous → `failed`, never a blind click.

## Storage

- Sink: existing `CredentialStore.addApiKey` (`session/credentials.enc`).
- Label = profile id (`default` / `acct-xxxxxx`), so each provider keeps at most one
  harvested key per profile.
- Dedup: if the token already exists for the provider → `unchanged`.
- Update: if the label exists with a different token → remove the old record, add the
  new one → `updated`.
- New token, no label conflict → `created`.
- Runtime pickup is automatic: `savedApiKey()` reads the store; `POST /v1/gateway/refresh`
  invalidates the 60s key cache.

## Error handling & report

- Per-provider isolation: one failure never aborts the run.
- Login wall, host mismatch, selector miss, timeout, validation failure each map to a
  distinct detail string in the report.
- Exit code: 0 if at least one provider is `created`/`updated`/`unchanged` or the run
  was declined; 1 if every attempted provider ended in `failed`.

## Testing

- `test/key-adapters.test.ts` — every catalog entry with `keyUrl` has an adapter,
  URLs are identical, `keyPattern` is non-empty, no duplicate providers.
- `test/key-harvest.test.ts` — engine against fake page objects (no browser):
  extract path, create path, host-guard skip, login skip, refusal-to-click,
  validation failure, store dedup/update semantics.
- `test/key-harvest-browser.test.ts` (gated by `RUN_BROWSER_TESTS=1`) — local HTTP
  server serving a fake dashboard (key list + "Create" button) → real CDP browser →
  end-to-end: create → extract → record lands in a temp credential store.

## Future work (out of scope)

- `--all-profiles` batch runs across every `acct-*` profile.
- Harvest from the web UI / desktop app (they can call the same CLI later).
- Verifying harvested keys against each provider's live endpoint after storing.
