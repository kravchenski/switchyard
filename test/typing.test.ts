import { describe, expect, test } from 'bun:test';
import { humanType } from '../src/browser/typing.ts';

function mockPage() {
  const typed: string[] = [];
  const pressed: string[] = [];
  const inserted: string[] = [];
  const page = {
    keyboard: {
      type: async (text: string) => { typed.push(text); },
      press: async (key: string) => { pressed.push(key); },
      insertText: async (text: string) => { inserted.push(text); },
    },
  };
  return { page: page as never, typed, pressed, inserted };
}

describe('humanType', () => {
  test('types words with key events and never passes newlines to type()', async () => {
    const { page, typed, pressed } = mockPage();
    await humanType(page, 'hello brave\nsecond line', () => 1);
    expect(typed.join('')).toBe('hello bravesecond line');
    expect(typed.every(chunk => !chunk.includes('\n'))).toBeTrue();
    expect(pressed).toEqual(['Shift+Enter']);
  });

  test('keeps a single line without pressing any keys', async () => {
    const { page, typed, pressed } = mockPage();
    await humanType(page, 'just one line', () => 1);
    expect(typed.join('')).toBe('just one line');
    expect(pressed).toEqual([]);
  });

  test('falls back to a paste for very long text', async () => {
    const { page, typed, inserted } = mockPage();
    const long = 'x'.repeat(4_000);
    await humanType(page, long, () => 1);
    expect(inserted).toEqual([long]);
    expect(typed).toEqual([]);
  });

  test('does nothing for an empty prompt', async () => {
    const { page, typed, pressed, inserted } = mockPage();
    await humanType(page, '', () => 1);
    expect(typed).toEqual([]);
    expect(pressed).toEqual([]);
    expect(inserted).toEqual([]);
  });
});
