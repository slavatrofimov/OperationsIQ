import { describe, it, expect, beforeEach } from 'vitest';
import type { ToolContext } from '../types';
import {
  subscribeInteraction,
  __resetInteractionForTests,
  type InteractionRequest,
} from '../interaction';
import { requestUserChoiceTool } from './requestUserChoice';

const ctx = { tags: [] } as unknown as ToolContext;

/** Subscribe a spy so the tool has a listener to publish to; returns captured requests. */
function withListener(): { requests: InteractionRequest[]; off: () => void } {
  const requests: InteractionRequest[] = [];
  const off = subscribeInteraction((r) => requests.push(r));
  return { requests, off };
}

describe('request_user_choice tool', () => {
  beforeEach(() => __resetInteractionForTests());

  it('is read-only so it works in every session without the side-effect grant', () => {
    expect(requestUserChoiceTool.readOnly).toBe(true);
  });

  it('publishes a confirm request (<=2 options) and returns ok', async () => {
    const { requests } = withListener();
    const res = await requestUserChoiceTool.run(
      {
        prompt: 'Save this derived metric?',
        options: [
          { label: 'Approve', style: 'primary' },
          { label: 'Cancel', style: 'default' },
        ],
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].kind).toBe('confirm');
    expect(requests[0].prompt).toBe('Save this derived metric?');
    expect(requests[0].options.map((o) => o.label)).toEqual(['Approve', 'Cancel']);
    expect(requests[0].options[0].style).toBe('primary');
  });

  it('classifies 3+ options as a choice list', async () => {
    const { requests } = withListener();
    await requestUserChoiceTool.run(
      { prompt: 'Which analysis?', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] },
      ctx,
    );
    expect(requests[0].kind).toBe('choice');
    expect(requests[0].allowMultiple).toBeFalsy();
  });

  it('honors allow_multiple only when there is more than one option', async () => {
    const { requests } = withListener();
    await requestUserChoiceTool.run(
      { prompt: 'Pick tags', options: [{ label: 'T1' }, { label: 'T2' }], allow_multiple: true },
      ctx,
    );
    expect(requests[0].kind).toBe('choice');
    expect(requests[0].allowMultiple).toBe(true);
  });

  it('drops blank-label options and fails when none remain', async () => {
    const { requests } = withListener();
    const res = await requestUserChoiceTool.run(
      { prompt: 'Proceed?', options: [{ label: '   ' }] },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('bad_args');
    expect(requests).toHaveLength(0);
  });

  it('rejects an empty prompt', async () => {
    withListener();
    const res = await requestUserChoiceTool.run({ prompt: '  ', options: [{ label: 'OK' }] }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('bad_args');
  });

  it('drops an invalid style rather than passing it through', async () => {
    const { requests } = withListener();
    await requestUserChoiceTool.run(
      // @ts-expect-error — deliberately invalid style to prove sanitization.
      { prompt: 'Go?', options: [{ label: 'Yes', style: 'flashy' }] },
      ctx,
    );
    expect(requests[0].options[0].style).toBeUndefined();
  });

  it('returns ok:false when no chat UI is listening', async () => {
    const res = await requestUserChoiceTool.run(
      { prompt: 'Proceed?', options: [{ label: 'Approve' }] },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('unavailable');
  });
});
