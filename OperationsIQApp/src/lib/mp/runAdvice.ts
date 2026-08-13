/**
 * Per-run, adaptive interpretation (design principle: "dynamic per-run interpretation").
 *
 * The methodology panel explains what an analysis does in general; this turns the *actual*
 * outcome of a specific run into a short, plain-language verdict plus an actionable next
 * step for an operations analyst ("nothing stood out — try a shorter pattern length").
 * Pure and fully unit-tested — no MP jargon, no backend, no browser.
 */
import type { MethodFamily } from './methodology';
import type { Strength } from './interpret';

export type AdviceTone = 'positive' | 'suggestion' | 'neutral';

export interface RunAdvice {
  tone: AdviceTone;
  /** One-line verdict on how this run turned out. */
  headline: string;
  /** A concrete next step the analyst can take (empty when the result is already good). */
  detail: string;
}

export interface RunAdviceInput {
  family: MethodFamily;
  /** Number of patterns/anomalies/regimes/links the run produced. */
  resultCount: number;
  /** Strength of the strongest motif, when the run finds repeats. */
  topMotifStrength?: Strength;
  /** Strength of the most severe discord, when the run finds anomalies. */
  topDiscordStrength?: Strength;
  /** True while the job is still running (advice is withheld until it finishes). */
  running?: boolean;
}

const MOTIF_FAMILIES: ReadonlySet<MethodFamily> = new Set<MethodFamily>([
  'motif',
  'consensus',
  'chain',
  'similarity',
  'rule',
]);

const DISCORD_FAMILIES: ReadonlySet<MethodFamily> = new Set<MethodFamily>(['discord']);

/**
 * Produce a per-run verdict + next-step suggestion. Returns `undefined` while the job is
 * still running (there is nothing to advise on yet).
 */
export function runAdvice(input: RunAdviceInput): RunAdvice | undefined {
  if (input.running) return undefined;

  const { family, resultCount } = input;

  // Nothing found at all — always a suggestion, tailored to the analysis kind.
  if (resultCount === 0) {
    if (DISCORD_FAMILIES.has(family)) {
      return {
        tone: 'suggestion',
        headline: 'Nothing stood out as anomalous.',
        detail:
          'That often means the signal was stable over this window. To catch briefer events, try a shorter pattern length or a higher sensitivity.',
      };
    }
    if (family === 'segmentation') {
      return {
        tone: 'suggestion',
        headline: 'No clear regime changes were detected.',
        detail:
          'The behaviour looks consistent across this window. Try a longer window that spans a known change, or a different signal.',
      };
    }
    if (family === 'compare') {
      return {
        tone: 'suggestion',
        headline: 'No notable differences were found between the two windows.',
        detail:
          'The compared periods behaved similarly. Try comparing against a window you expect to differ, or adjust the pattern length.',
      };
    }
    return {
      tone: 'suggestion',
      headline: 'No repeating patterns were found.',
      detail:
        'Try a longer pattern length, or pick a window that contains more full cycles of the behaviour you expect to repeat.',
    };
  }

  // Discord-style runs: judge by the most severe anomaly.
  if (DISCORD_FAMILIES.has(family)) {
    if (input.topDiscordStrength === 'strong') {
      return {
        tone: 'positive',
        headline: `Found ${resultCount} anomal${resultCount === 1 ? 'y' : 'ies'}, at least one clearly unusual.`,
        detail:
          'Open the top-ranked anomaly to see its shape and timing, then label it if it matches a known fault.',
      };
    }
    if (input.topDiscordStrength === 'weak') {
      return {
        tone: 'suggestion',
        headline: `Found ${resultCount} candidate anomal${resultCount === 1 ? 'y' : 'ies'}, but none stand out strongly.`,
        detail:
          'These may be mild deviations. Confirm against context, or try a shorter pattern length to isolate briefer events.',
      };
    }
    return {
      tone: 'neutral',
      headline: `Found ${resultCount} candidate anomal${resultCount === 1 ? 'y' : 'ies'}.`,
      detail: 'Review the top-ranked anomalies and label any that match a known issue.',
    };
  }

  // Motif-style runs (incl. consensus, chain, similarity, rule): judge by repeat strength.
  if (MOTIF_FAMILIES.has(family)) {
    if (input.topMotifStrength === 'strong') {
      return {
        tone: 'positive',
        headline: `Found ${resultCount} pattern${resultCount === 1 ? '' : 's'}, including a strong, consistent repeat.`,
        detail:
          'This is a reliable pattern. Open it to inspect its shape, then label it to reuse it later.',
      };
    }
    if (input.topMotifStrength === 'weak') {
      return {
        tone: 'suggestion',
        headline: `Found ${resultCount} pattern${resultCount === 1 ? '' : 's'}, but the strongest repeat is weak.`,
        detail:
          'The matches are loose. Try a longer pattern length, or a window with more complete cycles, for a cleaner repeat.',
      };
    }
    return {
      tone: 'neutral',
      headline: `Found ${resultCount} pattern${resultCount === 1 ? '' : 's'}.`,
      detail: 'Open the top-ranked pattern to inspect its shape and decide whether to label it.',
    };
  }

  // Segmentation / compare / auto with results present.
  if (family === 'segmentation') {
    return {
      tone: 'positive',
      headline: `Detected ${resultCount} regime${resultCount === 1 ? '' : 's'} in this window.`,
      detail: 'Review where behaviour shifts and label any regime that maps to a known operating mode.',
    };
  }
  if (family === 'compare') {
    return {
      tone: 'positive',
      headline: `Highlighted ${resultCount} difference${resultCount === 1 ? '' : 's'} between the two windows.`,
      detail: 'Open the largest differences to see where and how the two periods diverge.',
    };
  }

  return {
    tone: 'neutral',
    headline: `Found ${resultCount} result${resultCount === 1 ? '' : 's'}.`,
    detail: 'Open the top-ranked result to inspect it in detail.',
  };
}
