import { describe, expect, test } from 'bun:test';

import { decide, decisionMessages, readDecisionAnswers, readDecisionRequest } from '../src/core/decisions/engine.ts';

const skillRequest = {
  model: 'jev-latest',
  state: { request: 'Make me a pptx deck', recent_context: '' },
  questions: {
    which: { type: 'choice', instructions: 'Which skill?', criteria: { pptx: 'PowerPoint files', docx: 'Word files' } },
    'gate::prose_suffices': { type: 'noul', instructions: 'Is prose enough?' },
    flag: { type: 'boolean', instructions: 'Is it a file task?' },
  },
};

describe('decision API', () => {
  test('reads a TypeSafe System One request and rejects broken ones', () => {
    expect(readDecisionRequest(skillRequest).questions.which!.criteria).toEqual({ pptx: 'PowerPoint files', docx: 'Word files' });
    expect(() => readDecisionRequest({ questions: {} })).toThrow('1 to 64');
    expect(() => readDecisionRequest({ questions: { a: { type: 'rank', instructions: 'x' } } })).toThrow('choice, noul or boolean');
    expect(() => readDecisionRequest({ questions: { a: { type: 'choice', instructions: 'x' } } })).toThrow('criteria');
  });

  test('asks for every key and option and turns the reply into System One answers', () => {
    const request = readDecisionRequest(skillRequest);
    const prompt = decisionMessages(request)[1]!.content as string;
    expect(prompt).toContain('request: Make me a pptx deck');
    expect(prompt).toContain('"which": {"probabilities": {"pptx": 0.0, "docx": 0.0}}');
    expect(prompt).not.toContain('…');
    const answers = readDecisionAnswers(request, 'Sure: {"which": {"probabilities": {"pptx": 3, "docx": 1}}, "gate::prose_suffices": {"yes": 0.1}, "flag": 0.8}');
    expect(answers).toEqual({
      which: { choice: 'pptx', confidence: 0.75, probabilities: { pptx: 0.75, docx: 0.25 } },
      'gate::prose_suffices': { noul: 0.1, confidence: 0.9 },
      flag: { boolean: true, probability: 0.8 },
    });
    expect(readDecisionAnswers(request, '{}').which).toEqual({ choice: 'pptx', confidence: 0.5, probabilities: { pptx: 0.5, docx: 0.5 } });
    expect(() => readDecisionAnswers(request, 'no json here')).toThrow('did not answer with JSON');
  });

  test('passes the reader to the completion so a bad answer can move on to another model', async () => {
    const request = readDecisionRequest(skillRequest);
    const replies = ['not json', '{"which": {"probabilities": {"docx": 1}}}'];
    const result = await decide(request, async (_messages, read) => {
      for (const reply of replies) {
        try {
          return read(reply);
        } catch {}
      }
      throw new Error('none');
    });
    expect(result.which).toMatchObject({ choice: 'docx' });
  });
});
