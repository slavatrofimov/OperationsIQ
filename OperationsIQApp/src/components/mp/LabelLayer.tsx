import { useState } from 'react';
import {
  Button,
  Checkbox,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { Label as LabelType, LabelCategory, LabelInput } from '../../lib/mp/types';
import { propagateLabel, suggestThreshold, type Span } from '../../lib/mp/labeling';
import { LabelFields } from './LabelFields';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  hint: { color: tokens.colorNeutralForeground3 },
});

/**
 * A single stretch to be labeled, on a specific signal. Multi-signal / AB jobs supply
 * several targets at once (one per participating sensor / window) so a single label
 * action labels the whole discovered event across every signal it touches.
 */
export interface LabelTarget {
  signalId: string;
  startIndex: number;
  length: number;
  /** Temporal resolution (seconds/sample) for this target's signal/window. */
  secondsPerSample?: number;
  /** Human-readable name of the signal/window (for the "what will be labeled" summary). */
  laneLabel?: string;
}

export interface LabelLayerProps {
  signalId: string;
  jobId?: string;
  /** Single-signal selection (back-compat). Ignored when {@link targets} is provided. */
  selection?: Span;
  /** Multi-target selection — labels every stretch across the participating signals. */
  targets?: LabelTarget[];
  kind: 'MOTIF' | 'DISCORD';
  categories: LabelCategory[];
  labels: LabelType[];
  mp?: number[];
  mpi?: number[];
  exclusionZone?: number;
  /** Temporal resolution (seconds/sample) of this run, stored with new labels. */
  secondsPerSample?: number;
  onCreate: (inputs: LabelInput[]) => void;
  onDelete?: (id: string) => void;
}

/**
 * Labeling panel (design spec §7.5): create a label for a selected span, optionally
 * "apply to all similar patterns" (propagated via the MP nearest-neighbor graph). Editing
 * and deleting existing labels is handled inline via the label chips (see LabelEditDialog).
 */
export function LabelLayer(props: LabelLayerProps) {
  const styles = useStyles();
  const [text, setText] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [confidence, setConfidence] = useState(0.8);
  const [applyAll, setApplyAll] = useState(false);

  const category = props.categories.find((c) => c.id === categoryId);

  // Normalize to a list of targets. `targets` (multi-signal) wins; otherwise fall back to
  // the single-signal `selection` on `signalId` for back-compat.
  const effectiveTargets: LabelTarget[] =
    props.targets && props.targets.length > 0
      ? props.targets
      : props.selection
        ? [
            {
              signalId: props.signalId,
              startIndex: props.selection.startIndex,
              length: props.selection.length,
              secondsPerSample: props.secondsPerSample,
            },
          ]
        : [];
  const hasSelection = effectiveTargets.length > 0;
  const single = effectiveTargets.length === 1 ? effectiveTargets[0] : undefined;

  // Nearest-neighbor propagation only makes sense for a single-signal motif seed.
  const canPropagate = !!(props.mp && props.mpi && single && props.kind === 'MOTIF');

  const similarCount = (() => {
    if (!applyAll || !canPropagate || !single) return 0;
    const mp = props.mp!;
    const spans = propagateLabel({
      seedIndex: single.startIndex,
      length: single.length,
      mp,
      mpi: props.mpi!,
      distThreshold: suggestThreshold(mp, single.startIndex),
      exclusionZone: props.exclusionZone ?? Math.ceil(single.length / 2),
    });
    return spans.length;
  })();

  const submit = () => {
    if (!hasSelection) return;
    const base: Omit<LabelInput, 'signalId' | 'startIndex' | 'length' | 'secondsPerSample'> = {
      jobId: props.jobId,
      kind: props.kind,
      text,
      // The store persists the category *id* (Label.labelCategory_id) and resolves the
      // name/color for display; store the id, not the name.
      category: category?.id,
      color: category?.color,
      confidence,
    };

    let inputs: LabelInput[];
    if (applyAll && canPropagate && single) {
      const mp = props.mp!;
      const spans = propagateLabel({
        seedIndex: single.startIndex,
        length: single.length,
        mp,
        mpi: props.mpi!,
        distThreshold: suggestThreshold(mp, single.startIndex),
        exclusionZone: props.exclusionZone ?? Math.ceil(single.length / 2),
      });
      // Propagation can legitimately return nothing (e.g. the seed sits outside the MP
      // array's bounds). Never drop the label in that case — fall back to labeling the
      // selected target(s) so "apply to all similar" still saves the seed itself.
      inputs =
        spans.length > 0
          ? spans.map((s) => ({
              ...base,
              signalId: single.signalId,
              startIndex: s.startIndex,
              length: s.length,
              secondsPerSample: single.secondsPerSample,
            }))
          : effectiveTargets.map((t) => ({
              ...base,
              signalId: t.signalId,
              startIndex: t.startIndex,
              length: t.length,
              secondsPerSample: t.secondsPerSample,
            }));
    } else {
      inputs = effectiveTargets.map((t) => ({
        ...base,
        signalId: t.signalId,
        startIndex: t.startIndex,
        length: t.length,
        secondsPerSample: t.secondsPerSample,
      }));
    }

    props.onCreate(inputs);
    setText('');
  };

  const selectionSummary = single
    ? `Selected stretch${single.laneLabel ? ` on ${single.laneLabel}` : ''}: samples ${single.startIndex}–${single.startIndex + single.length}`
    : `Labeling ${effectiveTargets.length} signals: ${effectiveTargets
        .map((t) => t.laneLabel ?? t.signalId)
        .join(', ')}`;

  // Nothing to show until the user queues a pattern for labeling (via the
  // "Label pattern" button in a pattern's detail).
  if (!hasSelection) return null;

  return (
    <div className={styles.root}>
      <Text weight="semibold">Label this pattern</Text>
      <div className={styles.form}>
        <Text size={200} className={styles.hint}>
          {selectionSummary}
        </Text>
        <LabelFields
          text={text}
          onText={setText}
          categoryId={categoryId}
          onCategoryId={setCategoryId}
          confidence={confidence}
          onConfidence={setConfidence}
          categories={props.categories}
          kind={props.kind}
        />

        {canPropagate && (
          <Checkbox
            checked={applyAll}
            onChange={(_, d) => setApplyAll(d.checked === true)}
            label={
              <span>
                Apply to all similar patterns
                {applyAll && similarCount > 0 ? ` (${similarCount} found)` : ''}
              </span>
            }
          />
        )}

        <Button appearance="primary" onClick={submit} disabled={!text.trim()}>
          Save label{applyAll && similarCount > 1 ? `s (${similarCount})` : ''}
        </Button>
      </div>
    </div>
  );
}
