import { describe, expect, test } from 'bun:test';

import { looksVisionCapable } from '../src/core/models/vision.ts';

describe('looksVisionCapable', () => {
  test('recognises vision model names', () => {
    for (const model of ['meta/llama-3.2-90b-vision-instruct', 'qwen/qwen2.5-vl-72b-instruct', 'ovhcloud/Qwen2.5-VL-72B-Instruct', 'gemini/gemini-2.5-flash', 'google/gemma-3-27b-it', 'meta/llama-4-maverick-17b-128e-instruct', 'mistralai/pixtral-large', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning']) {
      expect(looksVisionCapable(model)).toBeTrue();
    }
  });

  test('rejects text-only model names', () => {
    for (const model of ['openai/gpt-oss-120b', 'deepseek-ai/deepseek-v4.1-flash', 'nvidia/nemotron-3-super-120b-a12b', 'z-ai/glm-5.3', 'meta/llama-3.3-70b-instruct', 'qwen/qwen3-coder-480b']) {
      expect(looksVisionCapable(model)).toBeFalse();
    }
  });
});
