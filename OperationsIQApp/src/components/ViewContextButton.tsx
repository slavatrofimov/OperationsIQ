import { useState } from 'react';
import {
  OverlayDrawer,
  DrawerHeader,
  DrawerHeaderTitle,
  DrawerBody,
  Button,
  Tooltip,
  Subtitle2,
  Body1,
  Table,
  TableBody,
  TableRow,
  TableCell,
  TableHeader,
  TableHeaderCell,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Dismiss24Regular, Info24Regular } from '@fluentui/react-icons';
import {
  useCaptureContextReader,
  useHasCaptureContext,
  type CaptureContextSummary,
} from '../context/CaptureContext';

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
    gap: tokens.spacingVerticalXS,
  },
  paramCell: {
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'nowrap',
    verticalAlign: 'top',
    width: '40%',
  },
  valueCell: { wordBreak: 'break-word' },
  empty: { color: tokens.colorNeutralForeground3 },
});

/**
 * Header button that opens a side panel summarizing every filter and setting
 * that applies to the current page's analysis. It reads the same page-published
 * context used for evidence capture, so what the user reviews here is exactly
 * what gets saved. Rendered only when the active page publishes context.
 */
export function ViewContextButton() {
  const styles = useStyles();
  const readContext = useCaptureContextReader();
  const hasContext = useHasCaptureContext();

  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<CaptureContextSummary | null>(null);

  if (!hasContext) return null;

  const openPanel = () => {
    setSummary(readContext());
    setOpen(true);
  };

  const sections = (summary?.sections ?? []).filter((s) =>
    s.fields.some((f) => String(f.value ?? '').trim() !== ''),
  );

  return (
    <>
      <Tooltip content="View context" relationship="label" withArrow>
        <Button
          appearance="subtle"
          icon={<Info24Regular />}
          aria-label="View context"
          onClick={openPanel}
        />
      </Tooltip>

      <OverlayDrawer
        position="end"
        size="medium"
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
            Analysis context
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          <div className={styles.body}>
            {sections.length === 0 ? (
              <Body1 className={styles.empty}>
                No filters or settings are available for this page.
              </Body1>
            ) : (
              sections.map((section, i) => {
                const fields = section.fields.filter(
                  (f) => String(f.value ?? '').trim() !== '',
                );
                return (
                  <div key={section.title ?? i} className={styles.section}>
                    {section.title && <Subtitle2>{section.title}</Subtitle2>}
                    <Table size="small" aria-label={section.title ?? 'Parameters'}>
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>Parameter</TableHeaderCell>
                          <TableHeaderCell>Value</TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {fields.map((f) => (
                          <TableRow key={f.label}>
                            <TableCell className={styles.paramCell}>{f.label}</TableCell>
                            <TableCell className={styles.valueCell}>{f.value}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                );
              })
            )}
          </div>
        </DrawerBody>
      </OverlayDrawer>
    </>
  );
}
