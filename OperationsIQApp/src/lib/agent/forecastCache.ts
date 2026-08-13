import type { ForecastResult } from '../forecast';

export interface ForecastMeta {
  signalId: string;
  binLabel: string;
  binSeconds: number;
  confidence: number;
  threshold?: number;
  direction?: 'above' | 'below';
}

const MAX_FORECASTS = 20;
let seq = 0;
const cache = new Map<string, { result: ForecastResult; meta: ForecastMeta }>();

export function putForecast(result: ForecastResult, meta: ForecastMeta): string {
  const id = `fc_${++seq}`;
  cache.set(id, { result, meta });
  while (cache.size > MAX_FORECASTS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return id;
}

export function getForecast(id: string) {
  const entry = cache.get(id);
  if (!entry) return undefined;
  cache.delete(id);
  cache.set(id, entry);
  return entry;
}
