import { useMemo, useState } from 'react';
import { ErrorMessageBar } from '../components/ErrorMessageBar';
import {
  Body1,
  Button,
  Card,
  Field,
  Input,
  Spinner,
  Subtitle1,
  Subtitle2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  useRegisterCaptureContext,
  type CaptureContextSummary,
} from '../context/CaptureContext';
import { fmtWindow, tagNames, binningFields as captureBinningFields } from '../lib/captureContextHelpers';
import type { TagInfo } from '../lib/tags';
import { chooseBinFor, type BinningSettings } from '../lib/binningSettings';
import { buildCandlestickQuery } from '../lib/kql';
import { executeKql } from '../lib/eventhouse';
import {
  parseCandlestickRows,
  parseMaWindows,
  DEFAULT_MA_WINDOWS,
  type OhlcBar,
} from '../lib/candlestick';
import { useAsyncAction } from '../hooks/useAsync';
import { useControlledPage } from '../hooks/usePageController';
import { withInfo } from '../components/fieldInfo';
import {
  tagField,
  rangeField,
  binningFields as controllerBinningFields,
} from '../hooks/pageControllerFields';
import { pf, coerce } from '../hooks/usePageController';
import { TagSelect } from '../components/TagSelect';
import { type TimeRange } from '../components/TimeRangePicker';
import { AdaptiveBinningPanel } from '../components/AdaptiveBinningPanel';
import { CandlestickChart } from '../components/CandlestickChart';
import { PageIntro } from '../components/PageIntro';
import { OutputDescription } from '../components/OutputDescription';
import { EXPLAINERS } from '../lib/explainers';
import { usePageBinning } from '../context/BinningContext';
import { useSharedRange, useSharedPrimaryTag } from '../context/SelectionContext';
import { useTagLabeler } from '../context/TagDisplayContext';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  controls: {
    display: 'flex',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalL,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  actionRow: { display: 'flex', justifyContent: 'flex-end' },
  card: { padding: tokens.spacingVerticalL },
  cardActions: { display: 'flex', alignItems: 'center', marginBottom: tokens.spacingVerticalS },
});

interface CandlestickResult {
  tagId: string;
  bars: OhlcBar[];
}

/** Load pre-aggregated OHLC bars for one tag over a window at the chosen resolution. */
async function loadCandlestick(
  tagId: string,
  r: TimeRange,
  s: BinningSettings,
): Promise<CandlestickResult> {
  const bin = chooseBinFor({ start: r.start, end: r.end }, s);
  const table = await executeKql(
    buildCandlestickQuery({ tagId, start: r.start, end: r.end, binKql: bin.kql }),
  );
  return { tagId, bars: parseCandlestickRows(table) };
}

export interface TrendVolatilityPageProps {
  tags: TagInfo[];
}

/**
 * Trend & volatility page: summarize a single signal into per-interval OHLC
 * candles with a volume sub-panel and moving averages. Each candle spans one
 * adaptive time bin (open/high/low/close + raw-record count), and the moving
 * averages are derived client-side from the binned close.
 */
export function TrendVolatilityPage({ tags }: TrendVolatilityPageProps) {
  const styles = useStyles();
  const [tag, setTag] = useSharedPrimaryTag();
  const [range, setRange] = useSharedRange();
  const [maWindows, setMaWindows] = useState<number[]>(DEFAULT_MA_WINDOWS);
  const [maText, setMaText] = useState(DEFAULT_MA_WINDOWS.join(', '));
  const binning = usePageBinning();
  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);
  const labeler = useTagLabeler();

  const captureSummary = useMemo<CaptureContextSummary | null>(() => {
    if (tag.length === 0) return null;
    return {
      sections: [
        { title: 'Tags', fields: [{ label: 'Signal', value: tagNames(tag, nameById) }] },
        {
          title: 'Time range',
          fields: [{ label: 'Time window', value: fmtWindow(range.start, range.end) }],
        },
        {
          title: 'Configuration',
          fields: [
            ...captureBinningFields(binning.settings),
            { label: 'Moving averages', value: maWindows.join(', ') },
          ],
        },
      ],
    };
  }, [tag, nameById, range, binning.settings, maWindows]);
  useRegisterCaptureContext(captureSummary);

  const [state, run] = useAsyncAction(
    async (tagId: string, r: TimeRange, s: BinningSettings): Promise<CandlestickResult> =>
      loadCandlestick(tagId, r, s),
  );

  const load = () => {
    if (tag.length === 0) return;
    run(tag[0], range, binning.settings).catch(() => {});
  };

  const applyMaText = (text: string) => {
    const windows = parseMaWindows(text);
    setMaText(windows.join(', '));
    setMaWindows(windows);
  };

  const bars = state.data?.bars ?? [];
  const resultTag = state.data?.tagId ?? null;

  useControlledPage({
    pageKey: 'trendvolatility',
    title: 'Trend & volatility',
    fields: [
      tagField({ tags, current: tag, set: setTag }),
      rangeField({ current: range, set: setRange }),
      ...controllerBinningFields(binning),
      {
        field: pf.string('maWindows', 'Moving averages (bars)', maText, {
          description:
            'Comma-separated moving-average windows in bars/candles, e.g. "5, 10, 20, 30". Derived from the close price.',
        }),
        apply: (v) => applyMaText(coerce.string(v)),
      },
    ],
    canRun: tag.length > 0 && !state.loading,
    run: load,
    loading: state.loading,
    error: state.error ?? undefined,
    hasResult: bars.length > 0,
  });

  return (
    <div className={styles.root}>
      <Subtitle1>Trend &amp; volatility</Subtitle1>

      <PageIntro
        title="Trend & volatility"
        overview={EXPLAINERS.trendvolatility.overview}
        interpretation={EXPLAINERS.trendvolatility.interpretation}
        technical={EXPLAINERS.trendvolatility.technical}
      />

      <div className={styles.controls}>
        <div style={{ minWidth: 260 }}>
          <TagSelect
            tags={tags}
            selected={tag}
            onChange={setTag}
            info={EXPLAINERS.trendvolatility.inputs!.tag}
          />
        </div>
        <Field
          label={withInfo(
            'Moving averages (bars)',
            'Comma-separated moving-average windows in bars/candles, e.g. 5, 10, 20, 30. Derived from the close price.',
          )}
        >
          <Input
            value={maText}
            placeholder="5, 10, 20, 30"
            onChange={(_, d) => setMaText(d.value)}
            onBlur={() => applyMaText(maText)}
          />
        </Field>
      </div>

      <AdaptiveBinningPanel
        range={range}
        onRangeChange={setRange}
        signals={tag.map((id) => ({ tagId: id, name: nameById.get(id) ?? id }))}
        rangeInfo={EXPLAINERS.trendvolatility.inputs!.range}
        settings={binning.settings}
        onChange={binning.patch}
        onSaveAsDefault={binning.saveAsDefault}
        onReset={binning.resetToDefault}
        isCustom={binning.isCustom}
        hideAggregation
        disabled={state.loading}
        densityTagIds={tag}
        densityEnabled={!state.loading}
      />

      <div className={styles.actionRow}>
        <Button appearance="primary" disabled={tag.length === 0 || state.loading} onClick={load}>
          {state.loading ? <Spinner size="tiny" /> : 'Load'}
        </Button>
      </div>

      {state.error && (
        <ErrorMessageBar error={state.error} />
      )}

      {!resultTag ? (
        <Body1>
          {state.loading
            ? 'Loading\u2026'
            : 'Pick a signal and a range, then choose Load.'}
        </Body1>
      ) : (
        <Card className={styles.card}>
          <div className={styles.cardActions}>
            <Subtitle2>{labeler(resultTag, nameById.get(resultTag))}</Subtitle2>
          </div>
          <OutputDescription label="Candlestick chart">
            {EXPLAINERS.trendvolatility.outputs!.candlestick}
          </OutputDescription>
          <CandlestickChart
            bars={bars}
            name={labeler(resultTag, nameById.get(resultTag))}
            maWindows={maWindows}
          />
        </Card>
      )}
    </div>
  );
}
