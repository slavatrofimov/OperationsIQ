import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  subscribeInteraction,
  requestInteraction,
  hasInteractionListener,
  newInteractionId,
  __resetInteractionForTests,
  type InteractionRequest,
} from './interaction';

const req = (over: Partial<InteractionRequest> = {}): InteractionRequest => ({
  id: 'intx_1',
  kind: 'confirm',
  prompt: 'Proceed?',
  options: [{ label: 'Approve', style: 'primary' }, { label: 'Cancel' }],
  ...over,
});

describe('interaction bus', () => {
  beforeEach(() => __resetInteractionForTests());

  it('reports no listener until something subscribes', () => {
    expect(hasInteractionListener()).toBe(false);
    const off = subscribeInteraction(() => {});
    expect(hasInteractionListener()).toBe(true);
    off();
    expect(hasInteractionListener()).toBe(false);
  });

  it('delivers a request to every subscriber and returns true', () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeInteraction(a);
    subscribeInteraction(b);
    const r = req();
    expect(requestInteraction(r)).toBe(true);
    expect(a).toHaveBeenCalledWith(r);
    expect(b).toHaveBeenCalledWith(r);
  });

  it('returns false and calls nobody when there is no listener', () => {
    expect(requestInteraction(req())).toBe(false);
  });

  it('stops delivering after unsubscribe', () => {
    const fn = vi.fn();
    const off = subscribeInteraction(fn);
    off();
    expect(requestInteraction(req())).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('mints unique-ish ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newInteractionId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id.startsWith('intx_')).toBe(true);
  });
});
