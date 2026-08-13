import { describe, it, expect } from 'vitest';
import { lookupMethod, listMethods, GLOSSARY } from './glossary';

describe('glossary', () => {
  it('lists every canonical method with a display title', () => {
    const methods = listMethods();
    expect(methods.length).toBe(GLOSSARY.length);
    for (const m of methods) {
      expect(m.term).toMatch(/^[a-z_]+$/);
      expect(m.title.length).toBeGreaterThan(2);
    }
  });

  it('resolves a canonical term', () => {
    expect(lookupMethod('discord')?.term).toBe('discord');
  });

  it('resolves case-insensitively and via aliases', () => {
    expect(lookupMethod('SAX')?.term).toBe('sax');
    expect(lookupMethod('prediction interval')?.term).toBe('forecast_band');
    expect(lookupMethod('I-MR')?.term).toBe('control_chart');
  });

  it('resolves a loose contains-match phrase', () => {
    expect(lookupMethod('the forecast band please')?.term).toBe('forecast_band');
  });

  it('returns null for an unknown term', () => {
    expect(lookupMethod('kalman filter')).toBeNull();
    expect(lookupMethod('')).toBeNull();
  });

  it('carries the honest caveats used to frame results', () => {
    expect(lookupMethod('granger_causality')?.caveats).toMatch(/NOT physical causation/);
  });
});
