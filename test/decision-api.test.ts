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
    expect(() => readDecisionRequest({ questions: {} })).toThrow('1 to 256');
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
      which: { type: 'choice', choice: 'pptx', confidence: 0.75, probabilities: { pptx: 0.75, docx: 0.25 } },
      'gate::prose_suffices': { type: 'noul', noul: 0.1, confidence: 0.9 },
      flag: { type: 'boolean', boolean: true, probability: 0.8 },
    });
    expect(readDecisionAnswers(request, '{}').which).toEqual({ type: 'choice', choice: 'pptx', confidence: 0.5, probabilities: { pptx: 0.5, docx: 0.5 } });
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

describe('Jev compatibility', () => {
  test('accepts fast-jev-compaction batches and keeps long histories for the decision model', () => {
    const questions = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`result_toolu_${index}`, { type: 'noul', instructions: `Keep the output of call ${index}` }]));
    const history = 'x'.repeat(50_000);
    const request = readDecisionRequest({ model: 'jev-latest', state: { goal: 'fix the test', history }, questions });
    expect(Object.keys(request.questions)).toHaveLength(100);
    expect(decisionMessages(request)[1]!.content).toContain(history);
    expect(() => readDecisionRequest({ questions: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`q${index}`, { type: 'noul', instructions: 'x' }])) })).toThrow('1 to 256');
  });

  test('tags every answer with its type as jevgrep expects', () => {
    const request = readDecisionRequest({ state: {}, questions: { pick: { type: 'choice', instructions: 'Which?', criteria: { a: 'A', b: 'B' } }, keep: { type: 'noul', instructions: 'Keep?' } } });
    const answers = readDecisionAnswers(request, '{"pick": {"probabilities": {"a": 0.2, "b": 0.8}}, "keep": {"yes": 0.7}}');
    expect(answers.pick).toMatchObject({ type: 'choice', choice: 'b' });
    expect(answers.keep).toEqual({ type: 'noul', noul: 0.7, confidence: 0.7 });
  });
});
