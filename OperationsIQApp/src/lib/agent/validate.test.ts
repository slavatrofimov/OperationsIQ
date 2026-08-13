import { describe, it, expect } from 'vitest';
import { validateArgs } from './validate';
import type { JsonSchema } from './types';

const schema: JsonSchema = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    confidence: { type: 'number', minimum: 0.5, maximum: 0.999 },
    aggregation: { type: 'string', enum: ['avg', 'min', 'max'] },
    scope: {
      type: 'object',
      properties: { level1: { type: 'string' } },
      additionalProperties: false,
    },
  },
  required: ['query'],
};

describe('validateArgs', () => {
  it('accepts valid args and applies defaults', () => {
    const r = validateArgs(schema, { query: 'boiler temp' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ query: 'boiler temp', limit: 10 });
  });

  it('flags a missing required field', () => {
    const r = validateArgs(schema, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/query is required/);
  });

  it('rejects a wrong primitive type', () => {
    const r = validateArgs(schema, { query: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/query must be a string/);
  });

  it('enforces integer-ness', () => {
    const r = validateArgs(schema, { query: 'x', limit: 2.5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/limit must be an integer/);
  });

  it('enforces numeric bounds', () => {
    const tooLow = validateArgs(schema, { query: 'x', limit: 0 });
    const tooHigh = validateArgs(schema, { query: 'x', limit: 999 });
    expect(tooLow.ok).toBe(false);
    expect(tooHigh.ok).toBe(false);
  });

  it('enforces enum membership', () => {
    const bad = validateArgs(schema, { query: 'x', aggregation: 'median' });
    const good = validateArgs(schema, { query: 'x', aggregation: 'avg' });
    expect(bad.ok).toBe(false);
    expect(good.ok).toBe(true);
  });

  it('validates nested objects and strips unknown keys under additionalProperties:false', () => {
    const r = validateArgs(schema, {
      query: 'x',
      scope: { level1: 'PlantA', bogus: 'drop-me' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const scope = r.value.scope as Record<string, unknown>;
      expect(scope.level1).toBe('PlantA');
      expect('bogus' in scope).toBe(false);
    }
  });

  it('does not coerce a numeric string into a number', () => {
    const r = validateArgs(schema, { query: 'x', confidence: '0.9' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/confidence must be a number/);
  });
});
