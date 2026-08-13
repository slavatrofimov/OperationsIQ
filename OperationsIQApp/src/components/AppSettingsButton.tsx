import { useState } from 'react';
import {
  OverlayDrawer,
  DrawerHeader,
  DrawerHeaderTitle,
  DrawerBody,
  Button,
  Dropdown,
  Option,
  Switch,
  SpinButton,
  Field,
  Divider,
  Subtitle2,
  Caption1,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  Settings24Regular,
  Dismiss24Regular,
  PlugConnected24Regular,
  Lightbulb24Regular,
  NumberSymbol24Regular,
  Clock24Regular,
  Tag24Regular,
  DataHistogram24Regular,
  Search24Regular,
} from '@fluentui/react-icons';
import { useExplanationsSettings } from '../context/ExplanationsContext';
import {
  useTooltipSettings,
  MIN_TOOLTIP_DECIMALS,
  MAX_TOOLTIP_DECIMALS,
} from '../context/TooltipSettingsContext';
import { useTagDisplaySettings, type TagDisplayMode } from '../context/TagDisplayContext';
import {
  useTagSelectionLimitSettings,
  MIN_TAG_SELECTION_LIMIT,
  MAX_TAG_SELECTION_LIMIT,
} from '../context/TagSelectionLimitContext';
import {
  useDataLimits,
  MIN_VISUALIZATION_MAX_POINTS,
  MAX_VISUALIZATION_MAX_POINTS,
  MIN_PATTERN_SEARCH_MAX_POINTS,
  MAX_PATTERN_SEARCH_MAX_POINTS,
} from '../context/DataLimitsContext';
import { useTimezone } from '../context/TimezoneContext';
import { timezoneOptions } from '../lib/timezone';

const useStyles = makeStyles({
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    paddingBottom: tokens.spacingVerticalL,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  sectionTitle: { color: tokens.colorNeutralForeground2 },
  hint: { color: tokens.colorNeutralForeground3 },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
});

export interface AppSettingsButtonProps {
  /** Open the connection-profile chooser (Connections lives in settings now). */
  onOpenConnections: () => void;
}

/** Selectable tag-labelling modes shown in the Settings pane, in order. */
const TAG_DISPLAY_OPTIONS: { value: TagDisplayMode; label: string }[] = [
  { value: 'name', label: 'Tag name' },
  { value: 'id', label: 'Tag ID' },
  { value: 'nameId', label: 'Tag name with ID' },
];

/**
 * Header gear button that opens a single Settings pane. It consolidates the
 * previously-scattered header controls — the explanations toggle, chart tooltip
 * decimals, the tag-id display option, and a Connections entry — so the header
 * stays compact and uncluttered. (Industry lives on the Playbooks page, where it's
 * relevant.)
 */
export function AppSettingsButton({ onOpenConnections }: AppSettingsButtonProps) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);

  const { showExplanations, toggleExplanations } = useExplanationsSettings();
  const { decimals, setDecimals } = useTooltipSettings();
  const { tagDisplayMode, setTagDisplayMode } = useTagDisplaySettings();
  const { limit: tagSelectionLimit, setLimit: setTagSelectionLimit } =
    useTagSelectionLimitSettings();
  const {
    visualizationMaxPoints,
    patternSearchMaxPoints,
    setVisualizationMaxPoints,
    setPatternSearchMaxPoints,
  } = useDataLimits();
  const { preference: tzPreference, setPreference: setTzPreference } = useTimezone();

  const tzOptions = timezoneOptions();
  const currentTz = tzOptions.find((o) => o.value === tzPreference) ?? tzOptions[0];

  return (
    <>
      <Tooltip content="Settings" relationship="label" withArrow>
        <Button
          appearance="subtle"
          icon={<Settings24Regular />}
          aria-label="Settings"
          onClick={() => setOpen(true)}
        />
      </Tooltip>

      <OverlayDrawer
        position="end"
        size="small"
        open={open}
        onOpenChange={(_, data) => setOpen(data.open)}
      >
        <DrawerHeader>
          <DrawerHeaderTitle
            action={
              <Button
                appearance="subtle"
                aria-label="Close"
                icon={<Dismiss24Regular />}
                onClick={() => setOpen(false)}
              />
            }
          >
            Settings
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          <div className={styles.body}>
            <div className={styles.section}>
              <Subtitle2 className={styles.sectionTitle}>Display</Subtitle2>
              <div className={styles.row}>
                <Lightbulb24Regular />
                <Switch
                  checked={showExplanations}
                  onChange={toggleExplanations}
                  label={showExplanations ? 'Explanations shown' : 'Explanations hidden'}
                />
              </div>
              <Field label={
                <span className={styles.row}>
                  <NumberSymbol24Regular /> Chart tooltip decimal places
                </span>
              }>
                <SpinButton
                  value={decimals}
                  min={MIN_TOOLTIP_DECIMALS}
                  max={MAX_TOOLTIP_DECIMALS}
                  step={1}
                  onChange={(_, d) => {
                    const n = d.value ?? (d.displayValue != null ? Number(d.displayValue) : NaN);
                    if (Number.isFinite(n)) setDecimals(n);
                  }}
                />
              </Field>
              <Field label={
                <span className={styles.row}>
                  <Tag24Regular /> Tag label format
                </span>
              }>
                <Dropdown
                  value={
                    TAG_DISPLAY_OPTIONS.find((o) => o.value === tagDisplayMode)?.label ?? 'Tag name'
                  }
                  selectedOptions={[tagDisplayMode]}
                  onOptionSelect={(_, d) =>
                    d.optionValue && setTagDisplayMode(d.optionValue as TagDisplayMode)
                  }
                >
                  {TAG_DISPLAY_OPTIONS.map((o) => (
                    <Option key={o.value} value={o.value} text={o.label}>
                      {o.label}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
              <Caption1 className={styles.hint}>
                Choose how tags are labelled everywhere. “Tag name with ID” shows “Name (Id)” so tags
                that share a name stay distinguishable.
              </Caption1>
              <Field label={
                <span className={styles.row}>
                  <Tag24Regular /> Max tags per multi-select
                </span>
              }>
                <SpinButton
                  value={tagSelectionLimit}
                  min={MIN_TAG_SELECTION_LIMIT}
                  max={MAX_TAG_SELECTION_LIMIT}
                  step={1}
                  onChange={(_, d) => {
                    const n = d.value ?? (d.displayValue != null ? Number(d.displayValue) : NaN);
                    if (Number.isFinite(n)) setTagSelectionLimit(n);
                  }}
                />
              </Field>
              <Caption1 className={styles.hint}>
                Caps how many tags can be selected at once in a multi-select picker. Pickers ask
                you to narrow your selection when this limit would be exceeded.
              </Caption1>
              <Field label={
                <span className={styles.row}>
                  <Clock24Regular /> Analysis timezone
                </span>
              }>
                <Dropdown
                  value={currentTz.label}
                  selectedOptions={[currentTz.value]}
                  onOptionSelect={(_, d) => d.optionValue && setTzPreference(d.optionValue)}
                >
                  {tzOptions.map((o) => (
                    <Option key={o.value} value={o.value} text={o.label}>
                      {o.label}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
              <Caption1 className={styles.hint}>
                Aligns time bins, day/hour breakdowns and chart times to this zone. A fixed
                offset is used, so daylight-saving shifts aren’t auto-adjusted.
              </Caption1>
            </div>

            <Divider />

            <div className={styles.section}>
              <Subtitle2 className={styles.sectionTitle}>Data</Subtitle2>
              <Button
                appearance="secondary"
                icon={<PlugConnected24Regular />}
                onClick={() => {
                  setOpen(false);
                  onOpenConnections();
                }}
              >
                Connections
              </Button>
              <Caption1 className={styles.hint}>
                Choose or manage the Eventhouse connection profile used for queries.
              </Caption1>
              <Field label={
                <span className={styles.row}>
                  <DataHistogram24Regular /> Visualization max points
                </span>
              }>
                <SpinButton
                  value={visualizationMaxPoints}
                  min={MIN_VISUALIZATION_MAX_POINTS}
                  max={MAX_VISUALIZATION_MAX_POINTS}
                  step={1000}
                  onChange={(_, d) => {
                    const n = d.value ?? (d.displayValue != null ? Number(d.displayValue) : NaN);
                    if (Number.isFinite(n)) setVisualizationMaxPoints(n);
                  }}
                />
              </Field>
              <Caption1 className={styles.hint}>
                Caps how many points (bins) charts and analysis pages render, driving the
                adaptive bin width. Higher shows more detail but can slow the browser on
                large ranges.
              </Caption1>
              <Field label={
                <span className={styles.row}>
                  <Search24Regular /> Pattern search max points
                </span>
              }>
                <SpinButton
                  value={patternSearchMaxPoints}
                  min={MIN_PATTERN_SEARCH_MAX_POINTS}
                  max={MAX_PATTERN_SEARCH_MAX_POINTS}
                  step={10000}
                  onChange={(_, d) => {
                    const n = d.value ?? (d.displayValue != null ? Number(d.displayValue) : NaN);
                    if (Number.isFinite(n)) setPatternSearchMaxPoints(n);
                  }}
                />
              </Field>
              <Caption1 className={styles.hint}>
                Ceiling for the Matrix Profile / pattern-search wizard, whose Spark jobs can
                process far more points than charts render.
              </Caption1>
            </div>
          </div>
        </DrawerBody>
      </OverlayDrawer>
    </>
  );
}
