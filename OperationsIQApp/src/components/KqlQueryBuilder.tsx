/**
 * KqlQueryBuilder: an editor panel for one canonical KQL query in the
 * ConfigPage. Shows a monospace textarea, inline column documentation, and a
 * "Preview" button that executes the query and shows results in a table.
 * Uses a simple FluentUI Textarea (monospace styled) to avoid a Monaco
 * dependency.
 */

import { useState } from 'react';
import { ErrorMessageBar } from './ErrorMessageBar';
import {
  Button,
  Spinner,
  MessageBar,
  MessageBarBody,
  Text,
  Caption1,
  Badge,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Play24Regular, ChevronDown16Regular, ChevronRight16Regular } from '@fluentui/react-icons';
import { executeKql, rowsToObjects } from '../lib/eventhouse';
import type { KqlOptions } from '../lib/connectionProfile';
import type { CanonicalQuerySpec } from '../lib/canonicalModel';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  editorRow: {
    display: 'flex',
    gap: tokens.spacingHorizontalM,
    alignItems: 'flex-start',
    minWidth: 0,
  },
  editorWrap: { flex: 1, minWidth: 0 },
  textarea: {
    width: '100%',
    minHeight: '140px',
    fontFamily: 'Consolas, "Courier New", monospace',
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    padding: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    resize: 'vertical',
    boxSizing: 'border-box',
  },
  toolbar: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    alignItems: 'center',
    marginTop: tokens.spacingVerticalXS,
  },
  docsToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    cursor: 'pointer',
    userSelect: 'none',
    color: tokens.colorNeutralForeground2,
  },
  docsPanel: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalS,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  colTable: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: tokens.fontSizeBase200,
  },
  colTh: {
    textAlign: 'left' as const,
    padding: '2px 8px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground2,
    fontWeight: tokens.fontWeightSemibold,
  },
  colTd: {
    padding: '2px 8px',
    verticalAlign: 'top' as const,
  },
  preview: {
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    overflowX: 'auto',
  },
  previewTable: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: tokens.fontSizeBase200,
  },
  previewTh: {
    padding: '4px 8px',
    textAlign: 'left' as const,
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    fontWeight: tokens.fontWeightSemibold,
    whiteSpace: 'nowrap' as const,
  },
  previewTd: {
    padding: '3px 8px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    maxWidth: '200px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  previewCaption: {
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    color: tokens.colorNeutralForeground3,
  },
});

export interface KqlQueryBuilderProps {
  query: string;
  onChange: (kql: string) => void;
  spec: CanonicalQuerySpec;
  profileOpts: KqlOptions;
  disabled?: boolean;
}

/** Query builder + preview component for one canonical KQL query. */
export function KqlQueryBuilder({
  query,
  onChange,
  spec,
  profileOpts,
  disabled,
}: KqlQueryBuilderProps) {
  const styles = useStyles();
  const [docsOpen, setDocsOpen] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewRows, setPreviewRows] = useState<Record<string, unknown>[] | null>(null);
  const [previewCols, setPreviewCols] = useState<string[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const runPreview = async () => {
    const previewKql = `${query.trim()}\n| take 1000`;
    setPreviewing(true);
    setPreviewError(null);
    setPreviewRows(null);
    try {
      const table = await executeKql(previewKql, profileOpts);
      setPreviewCols(table.columns.map((c) => c.name));
      setPreviewRows(rowsToObjects(table));
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <div className={styles.root}>
      <Caption1>{spec.description}</Caption1>

      <div className={styles.editorRow}>
        <div className={styles.editorWrap}>
          <textarea
            className={styles.textarea}
            value={query}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            spellCheck={false}
          />
          <div className={styles.toolbar}>
            <Button
              appearance="secondary"
              size="small"
              icon={previewing ? <Spinner size="tiny" /> : <Play24Regular />}
              onClick={runPreview}
              disabled={disabled || previewing || !query.trim()}
            >
              Preview (top 1 000)
            </Button>
          </div>
        </div>
      </div>

      {/* Column documentation toggle */}
      <div
        className={styles.docsToggle}
        onClick={() => setDocsOpen((o) => !o)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && setDocsOpen((o) => !o)}
      >
        {docsOpen ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
        <Text size={100}>Expected columns</Text>
      </div>

      {docsOpen && (
        <div className={styles.docsPanel}>
          <table className={styles.colTable}>
            <thead>
              <tr>
                <th className={styles.colTh}>Column</th>
                <th className={styles.colTh}>Type</th>
                <th className={styles.colTh}>Required</th>
                <th className={styles.colTh}>Description</th>
              </tr>
            </thead>
            <tbody>
              {spec.columns.map((col) => (
                <tr key={col.name}>
                  <td className={styles.colTd}>
                    <code>{col.name}</code>
                  </td>
                  <td className={styles.colTd}>
                    <Caption1>{col.type}</Caption1>
                  </td>
                  <td className={styles.colTd}>
                    {col.required ? (
                      <Badge appearance="filled" color="brand" size="small">required</Badge>
                    ) : (
                      <Badge appearance="tint" size="small">optional</Badge>
                    )}
                  </td>
                  <td className={styles.colTd}>
                    <Caption1>{col.description}</Caption1>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Preview results */}
      {previewError && (
        <ErrorMessageBar error={previewError} />
      )}
      {previewRows && previewRows.length > 0 && (
        <div className={styles.preview}>
          <div className={styles.previewCaption}>
            <Caption1>{previewRows.length} rows</Caption1>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className={styles.previewTable}>
              <thead>
                <tr>
                  {previewCols.map((c) => (
                    <th key={c} className={styles.previewTh}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows.slice(0, 100).map((row, i) => (
                  <tr key={i}>
                    {previewCols.map((c) => (
                      <td key={c} className={styles.previewTd}>
                        {String(row[c] ?? '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {previewRows && previewRows.length === 0 && (
        <MessageBar intent="info">
          <MessageBarBody>Query returned no rows.</MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}
