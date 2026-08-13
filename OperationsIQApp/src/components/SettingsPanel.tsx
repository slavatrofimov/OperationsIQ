import { useState } from 'react';
import {
  Accordion,
  AccordionItem,
  AccordionHeader,
  AccordionPanel,
  Field,
  Select,
  Switch,
  Slider,
  Label,
  Input,
  Button,
  Divider,
  Caption1,
  Body1,
  Spinner,
  MessageBar,
  MessageBarBody,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Delete16Regular, Save16Regular } from '@fluentui/react-icons';
import { withInfo } from './fieldInfo';
import {
  LAYOUT_OPTIONS,
  type ExploreSettings,
  type LayoutMode,
} from '../lib/exploreSettings';
import type { SavedViewSummary } from '../lib/savedViews';

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingVerticalS },
  row: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  toggles: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  savedList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  savedItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
  },
  savedMeta: { display: 'flex', flexDirection: 'column' },
  saveRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end' },
});

export interface SettingsPanelProps {
  settings: ExploreSettings;
  onSettingsChange: (patch: Partial<ExploreSettings>) => void;
  savedViews: SavedViewSummary[];
  savedViewsBusy: boolean;
  savedViewsError: string | null;
  signedIn: boolean;
  onSaveView: (name: string) => void;
  onLoadView: (id: string) => void;
  onDeleteView: (id: string) => void;
}

/** Collapsible configuration pane controlling all Explore settings + saved views. */
export function SettingsPanel({
  settings,
  onSettingsChange,
  savedViews,
  savedViewsBusy,
  savedViewsError,
  signedIn,
  onSaveView,
  onLoadView,
  onDeleteView,
}: SettingsPanelProps) {
  const styles = useStyles();
  const [viewName, setViewName] = useState('');

  return (
    <Accordion multiple collapsible defaultOpenItems={['layout']}>
      <AccordionItem value="anomalies">
        <AccordionHeader>Anomalies</AccordionHeader>
        <AccordionPanel>
          <div className={styles.section}>
            <Switch
              checked={settings.showAnomalies}
              label="Detect & overlay anomalies"
              onChange={(_, d) => onSettingsChange({ showAnomalies: d.checked })}
            />
            <div className={styles.row}>
              <Label>Sensitivity ({settings.sensitivity.toFixed(1)}) &mdash; lower is more sensitive</Label>
              <Slider
                min={0.5}
                max={5}
                step={0.1}
                value={settings.sensitivity}
                disabled={!settings.showAnomalies}
                onChange={(_, d) => onSettingsChange({ sensitivity: d.value })}
              />
            </div>
            <Switch
              checked={settings.showBaseline}
              label="Show decomposition baseline (detail)"
              onChange={(_, d) => onSettingsChange({ showBaseline: d.checked })}
            />
          </div>
        </AccordionPanel>
      </AccordionItem>

      <AccordionItem value="layout">
        <AccordionHeader>Chart layout</AccordionHeader>
        <AccordionPanel>
          <div className={styles.section}>
            <Field label={withInfo('Detail layout', 'How multiple selected series are arranged. Combined overlays them in one chart; Separate stacks one chart each; Small multiples shows a compact grid for side-by-side comparison.')}>
              <Select
                value={settings.layout}
                onChange={(_, d) => onSettingsChange({ layout: d.value as LayoutMode })}
              >
                {LAYOUT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <div className={styles.toggles}>
              <Switch
                checked={settings.sharedYAxis}
                label="Shared Y axis (separate / small multiples)"
                onChange={(_, d) => onSettingsChange({ sharedYAxis: d.checked })}
              />
              <Switch
                checked={settings.smoothLines}
                label="Smooth lines"
                onChange={(_, d) => onSettingsChange({ smoothLines: d.checked })}
              />
            </div>
          </div>
        </AccordionPanel>
      </AccordionItem>

      <AccordionItem value="events">
        <AccordionHeader>Events &amp; statistics</AccordionHeader>
        <AccordionPanel>
          <div className={styles.section}>
            <Switch
              checked={settings.showEvents}
              label="Show event flags on overview"
              onChange={(_, d) => onSettingsChange({ showEvents: d.checked })}
            />
            <Switch
              checked={settings.showStatistics}
              label="Show statistics & correlation"
              onChange={(_, d) => onSettingsChange({ showStatistics: d.checked })}
            />
            <Switch
              checked={settings.showDistributions}
              label="Show value distributions"
              onChange={(_, d) => onSettingsChange({ showDistributions: d.checked })}
            />
          </div>
        </AccordionPanel>
      </AccordionItem>

      <AccordionItem value="views">
        <AccordionHeader>Saved views</AccordionHeader>
        <AccordionPanel>
          <div className={styles.section}>
            {!signedIn && <Caption1>Sign in with Fabric to save and load views.</Caption1>}
            {savedViewsError && (
              <MessageBar intent="error">
                <MessageBarBody>{savedViewsError}</MessageBarBody>
              </MessageBar>
            )}
            <div className={styles.saveRow}>
              <Field label="Save current view as" style={{ flex: 1 }}>
                <Input
                  value={viewName}
                  placeholder="My view"
                  disabled={!signedIn || savedViewsBusy}
                  onChange={(_, d) => setViewName(d.value)}
                />
              </Field>
              <Button
                appearance="primary"
                icon={<Save16Regular />}
                disabled={!signedIn || savedViewsBusy || viewName.trim().length === 0}
                onClick={() => {
                  onSaveView(viewName.trim());
                  setViewName('');
                }}
              >
                Save
              </Button>
            </div>
            <Divider />
            {savedViewsBusy && <Spinner size="tiny" label="Working..." />}
            {!savedViewsBusy && savedViews.length === 0 ? (
              <Caption1>No saved views yet.</Caption1>
            ) : (
              <div className={styles.savedList}>
                {savedViews.map((v) => (
                  <div key={v.id} className={styles.savedItem}>
                    <div className={styles.savedMeta}>
                      <Body1>{v.name}</Body1>
                      <Caption1>
                        {v.config.tagIds.length} tags &middot; {v.createdAt.toLocaleDateString()}
                      </Caption1>
                    </div>
                    <div>
                      <Button size="small" appearance="secondary" onClick={() => onLoadView(v.id)}>
                        Load
                      </Button>{' '}
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<Delete16Regular />}
                        aria-label="Delete view"
                        onClick={() => onDeleteView(v.id)}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}
