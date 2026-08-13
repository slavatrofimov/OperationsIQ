import { describe, it, expect } from 'vitest';
import { optionToCsv } from './pageCapture';

describe('optionToCsv', () => {
  it('returns empty for a chart with no series', () => {
    expect(optionToCsv({ series: [] })).toBe('');
    expect(optionToCsv({})).toBe('');
  });

  it('builds a CSV from aligned [x, y] pair series', () => {
    const csv = optionToCsv({
      series: [
        { name: 'A', data: [[1, 10], [2, 20]] },
        { name: 'B', data: [[1, 11], [2, 21]] },
      ],
    });
    expect(csv).toBe(['x,A,B', '1,10,11', '2,20,21'].join('\r\n'));
  });

  it('does not throw when a later series carries scalar points', () => {
    // Pair detection must tolerate mixed pair/scalar series, such as a signal
    // with [x, y] points plus scalar reference-line values.
    const run = () =>
      optionToCsv({
        series: [
          { name: 'signal', data: [[1, 5], [2, 6]] },
          { name: 'threshold', data: [76.1346, 76.1346] },
        ],
      });
    expect(run).not.toThrow();
    const csv = run();
    // The pair series is still captured; the scalar series is simply skipped.
    expect(csv).toContain('x,signal,threshold');
    expect(csv).toContain('1,5,');
    expect(csv).toContain('2,6,');
  });

  it('builds a CSV from a category axis plus scalar value series', () => {
    const csv = optionToCsv({
      xAxis: [{ data: ['Mon', 'Tue'] }],
      series: [{ name: 'count', data: [3, 4] }],
    });
    expect(csv).toBe(['category,count', 'Mon,3', 'Tue,4'].join('\r\n'));
  });

  it('falls back to an index column for scalar series without a category axis', () => {
    const csv = optionToCsv({
      series: [{ name: 'v', data: [9, 8, 7] }],
    });
    expect(csv).toBe(['index,v', '0,9', '1,8', '2,7'].join('\r\n'));
  });
});
