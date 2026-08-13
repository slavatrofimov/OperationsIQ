import { describe, it, expect } from 'vitest';
import { looksLikeExplainScreen } from './explainIntent';

describe('looksLikeExplainScreen', () => {
  it('matches an explain-verb plus a screen reference', () => {
    for (const t of [
      'Explain what I am looking at',
      'Can you analyze this chart?',
      'summarize these results',
      'walk me through what is on this screen',
      "what am i looking at here",
      'interpret the graph shown here',
    ]) {
      expect(looksLikeExplainScreen(t)).toBe(true);
    }
  });

  it('does NOT hijack generic questions without a screen reference', () => {
    for (const t of [
      'explain motifs',
      'analyze the boiler temperature trend last week',
      'forecast tag 42 for the next day',
      'what is a discord?',
      '',
      '   ',
    ]) {
      expect(looksLikeExplainScreen(t)).toBe(false);
    }
  });
});
