import type { Page } from 'playwright-core';

const sleep = (ms: number) => Bun.sleep(ms);

const HUMAN_CHARS_LIMIT = 3_000;

export async function humanType(page: Page, text: string, random: () => number = Math.random): Promise<void> {
  if (!text) return;
  if (text.length > HUMAN_CHARS_LIMIT) {
    await page.keyboard.insertText(text);
    return;
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    await typeLine(page, lines[i]!, random);
    if (i < lines.length - 1) {
      await sleep(80 + random() * 170);
      await page.keyboard.press('Shift+Enter');
      await sleep(60 + random() * 140);
    }
  }
}

async function typeLine(page: Page, line: string, random: () => number): Promise<void> {
  const words = line.match(/\S+\s*/g);
  if (!words?.length) return;
  for (const word of words) {
    await page.keyboard.type(word);
    if (/[.!?]\s*$/.test(word)) {
      await sleep(180 + random() * 420);
    } else if (random() < 0.3) {
      await sleep(15 + random() * 55);
    }
  }
}
