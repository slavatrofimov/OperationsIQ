// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readJsonBody } from './fabricDiscovery';

const fakeResponse = (body: string) => ({ text: async () => body }) as unknown as Response;

describe('readJsonBody', () => {
  it('returns an empty object for an empty body (void LRO like updateDefinition)', async () => {
    await expect(readJsonBody(fakeResponse(''))).resolves.toEqual({});
  });

  it('returns an empty object for a whitespace-only body', async () => {
    await expect(readJsonBody(fakeResponse('   \n'))).resolves.toEqual({});
  });

  it('parses a non-empty JSON body (create path returns the item)', async () => {
    await expect(
      readJsonBody<{ id: string }>(fakeResponse(JSON.stringify({ id: 'abc', displayName: 'X' }))),
    ).resolves.toEqual({ id: 'abc', displayName: 'X' });
  });
});
