export function normalizeToken(raw: string) {
  let value = raw.trim().replace(/^bearer\s+/i, '');
  if (value.startsWith('{')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed?.value === 'string') value = parsed.value;
    } catch {}
  }
  return value.trim().replace(/^"(.*)"$/, '$1');
}
