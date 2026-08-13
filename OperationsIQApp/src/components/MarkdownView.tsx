import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Body1,
  Body1Strong,
  Subtitle1,
  Subtitle2,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { ReactNode } from 'react';
import { normalizeStoredMarkdown } from '../lib/markdown';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    lineHeight: tokens.lineHeightBase200,
    wordBreak: 'break-word',
  },
  // Headings sit closer to preceding content and are stepped down one level from
  // their semantic size so a leading H2 headline doesn't dominate a narrow panel.
  heading: {
    marginTop: tokens.spacingVerticalXS,
    marginBottom: 0,
    lineHeight: tokens.lineHeightBase300,
  },
  list: { paddingLeft: tokens.spacingHorizontalL, margin: 0 },
  code: {
    fontFamily: tokens.fontFamilyMonospace,
    backgroundColor: tokens.colorNeutralBackground3,
    padding: `0 ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusSmall,
  },
  pre: {
    fontFamily: tokens.fontFamilyMonospace,
    backgroundColor: tokens.colorNeutralBackground3,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    overflowX: 'auto',
  },
  tableScroll: { overflowX: 'auto' },
  hr: { border: 'none', borderTop: `1px solid ${tokens.colorNeutralStroke2}`, width: '100%' },
});

export interface MarkdownViewProps {
  markdown: string;
}

/**
 * Renders stored Markdown safely with react-markdown + remark-gfm, mapping block
 * elements to Fluent UI components so captured Evidence matches the app's look.
 * react-markdown is XSS-safe by default (no dangerouslySetInnerHTML).
 */
export function MarkdownView({ markdown }: MarkdownViewProps) {
  const styles = useStyles();
  const normalized = normalizeStoredMarkdown(markdown);
  return (
    <div className={styles.root}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <Subtitle1 as="h1" className={styles.heading} block>
              {children as ReactNode}
            </Subtitle1>
          ),
          h2: ({ children }) => (
            <Subtitle2 as="h2" className={styles.heading} block>
              {children as ReactNode}
            </Subtitle2>
          ),
          h3: ({ children }) => (
            <Body1Strong as="h3" className={styles.heading} block>
              {children as ReactNode}
            </Body1Strong>
          ),
          h4: ({ children }) => (
            <Body1Strong as="h4" className={styles.heading} block>
              {children as ReactNode}
            </Body1Strong>
          ),
          p: ({ children }) => <Body1 as="p">{children as ReactNode}</Body1>,
          ul: ({ children }) => <ul className={styles.list}>{children as ReactNode}</ul>,
          ol: ({ children }) => <ol className={styles.list}>{children as ReactNode}</ol>,
          li: ({ children }) => (
            <li>
              <Body1 as="span">{children as ReactNode}</Body1>
            </li>
          ),
          hr: () => <hr className={styles.hr} />,
          code: ({ children, className }) =>
            className?.includes('language-') ? (
              <pre className={styles.pre}>
                <code>{children as ReactNode}</code>
              </pre>
            ) : (
              <code className={styles.code}>{children as ReactNode}</code>
            ),
          table: ({ children }) => (
            <div className={styles.tableScroll}>
              <Table size="small">{children as ReactNode}</Table>
            </div>
          ),
          thead: ({ children }) => <TableHeader>{children as ReactNode}</TableHeader>,
          tbody: ({ children }) => <TableBody>{children as ReactNode}</TableBody>,
          tr: ({ children }) => <TableRow>{children as ReactNode}</TableRow>,
          th: ({ children }) => <TableHeaderCell>{children as ReactNode}</TableHeaderCell>,
          td: ({ children }) => <TableCell>{children as ReactNode}</TableCell>,
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}
