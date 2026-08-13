import { describe, it, expect } from 'vitest';
import {
  agentsUrl,
  agentUrl,
  buildAgentBody,
  extractSystemInstructions,
  toUpdateBody,
} from './provisioning';
import type { FunctionToolDef } from './registry';

const tool = (name: string): FunctionToolDef => ({
  type: 'function',
  name,
  description: `desc for ${name}`,
  parameters: { type: 'object', properties: {} },
});

describe('extractSystemInstructions', () => {
  it('returns the fenced block after the System instructions heading', () => {
    const md = [
      '# Title',
      'intro prose',
      '',
      '## System instructions (paste into the Foundry agent)',
      'some lead-in',
      '```text',
      'You are the Operations advisor.',
      'Be concise.',
      '```',
      'trailing prose',
    ].join('\n');
    expect(extractSystemInstructions(md)).toBe(
      'You are the Operations advisor.\nBe concise.',
    );
  });

  it('ignores fenced blocks that appear before the heading', () => {
    const md = [
      '```text',
      'NOT the instructions',
      '```',
      '## System instructions',
      '```',
      'REAL instructions',
      '```',
    ].join('\n');
    expect(extractSystemInstructions(md)).toBe('REAL instructions');
  });

  it('throws when the heading is missing', () => {
    expect(() => extractSystemInstructions('# nothing here')).toThrow(
      /System instructions/,
    );
  });

  it('throws when the code block is empty', () => {
    const md = ['## System instructions', '```', '```'].join('\n');
    expect(() => extractSystemInstructions(md)).toThrow(/empty/);
  });
});

describe('buildAgentBody', () => {
  it('assembles a prompt-kind definition with tools', () => {
    const body = buildAgentBody({
      name: 'ops-iq',
      model: 'gpt-4o',
      instructions: 'do the thing',
      tools: [tool('a'), tool('b')],
      description: 'the ops agent',
    });
    expect(body).toEqual({
      name: 'ops-iq',
      description: 'the ops agent',
      definition: {
        kind: 'prompt',
        model: 'gpt-4o',
        instructions: 'do the thing',
        tools: [tool('a'), tool('b')],
      },
    });
  });

  it('omits description when not provided', () => {
    const body = buildAgentBody({
      name: 'ops-iq',
      model: 'gpt-4o',
      instructions: 'x',
      tools: [tool('a')],
    });
    expect(body).not.toHaveProperty('description');
  });

  it('refuses to build with zero tools', () => {
    expect(() =>
      buildAgentBody({ name: 'n', model: 'm', instructions: 'i', tools: [] }),
    ).toThrow(/zero tools/);
  });

  it('requires name, model and instructions', () => {
    expect(() =>
      buildAgentBody({ name: '', model: 'm', instructions: 'i', tools: [tool('a')] }),
    ).toThrow(/name/);
    expect(() =>
      buildAgentBody({ name: 'n', model: '', instructions: 'i', tools: [tool('a')] }),
    ).toThrow(/[Mm]odel/);
    expect(() =>
      buildAgentBody({ name: 'n', model: 'm', instructions: '  ', tools: [tool('a')] }),
    ).toThrow(/[Ii]nstructions/);
  });
});

describe('toUpdateBody', () => {
  it('drops the top-level name and keeps definition + description', () => {
    const created = buildAgentBody({
      name: 'ops-iq',
      model: 'gpt-4o',
      instructions: 'do the thing',
      tools: [tool('a')],
      description: 'the ops agent',
    });
    const update = toUpdateBody(created);
    expect(update).toEqual({
      description: 'the ops agent',
      definition: created.definition,
    });
    expect(update).not.toHaveProperty('name');
  });

  it('omits description when the create body had none', () => {
    const created = buildAgentBody({
      name: 'ops-iq',
      model: 'gpt-4o',
      instructions: 'x',
      tools: [tool('a')],
    });
    const update = toUpdateBody(created);
    expect(update).not.toHaveProperty('description');
    expect(update.definition).toBe(created.definition);
  });
});

describe('agentsUrl', () => {
  it('builds the agents endpoint with the api-version query', () => {
    expect(
      agentsUrl('https://r.services.ai.azure.com/api/projects/p'),
    ).toBe('https://r.services.ai.azure.com/api/projects/p/agents?api-version=v1');
  });

  it('trims a trailing slash and honors a custom api version', () => {
    expect(agentsUrl('https://x/api/projects/p/', '2025-05-01')).toBe(
      'https://x/api/projects/p/agents?api-version=2025-05-01',
    );
  });
});

describe('agentUrl', () => {
  it('builds the single-agent endpoint with the api-version query', () => {
    expect(
      agentUrl('https://r.services.ai.azure.com/api/projects/p', 'operations-advisor'),
    ).toBe(
      'https://r.services.ai.azure.com/api/projects/p/agents/operations-advisor?api-version=v1',
    );
  });

  it('trims a trailing slash, encodes the name and honors a custom api version', () => {
    expect(agentUrl('https://x/api/projects/p/', 'ops advisor', '2025-05-01')).toBe(
      'https://x/api/projects/p/agents/ops%20advisor?api-version=2025-05-01',
    );
  });
});
