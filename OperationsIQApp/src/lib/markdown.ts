/**
 * Normalisation for stored Evidence Markdown before it is rendered.
 *
 * Evidence Markdown is written to the Rayfin/DAB backend by inlining the string
 * into a GraphQL mutation, where control characters are escaped (newline →
 * `\n`, tab → `\t`, backslash → `\\`, …). That escaped form is meant to be
 * un-escaped by the GraphQL server before storage, so a correct round-trip
 * returns real newlines. When that un-escaping does not happen, the retrieved
 * Markdown contains the literal two-character sequence `\n` instead of real
 * line breaks. react-markdown then sees a single line and renders the whole
 * document as one block — the `#`, `|`, and `-` characters show up verbatim,
 * i.e. "Markdown as plain text".
 *
 * {@link normalizeStoredMarkdown} repairs that case. Because every captured
 * page begins with a `# {pageName}\n\n_Captured …_` header, any well-formed
 * capture always contains real newlines; therefore Markdown that has *no* real
 * line breaks but *does* contain escaped ones was unambiguously mangled and is
 * safe to un-escape. Correctly stored Markdown is returned unchanged.
 */

/** Reverse the GraphQL string escaping applied when writing (single pass). */
function unescapeGraphQLString(value: string): string {
  return value.replace(/\\([\\nrt"])/g, (_, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case '"':
        return '"';
      case '\\':
        return '\\';
      default:
        return ch;
    }
  });
}

/**
 * Return render-ready Markdown, repairing content whose newlines were left in
 * their escaped `\n` form by a failed GraphQL round-trip. No-op for Markdown
 * that already contains real line breaks (the normal case).
 */
export function normalizeStoredMarkdown(markdown: string): string {
  if (!markdown) return markdown;
  const hasRealNewline = /\r?\n/.test(markdown);
  const hasEscapedNewline = /\\n/.test(markdown);
  if (!hasRealNewline && hasEscapedNewline) {
    return unescapeGraphQLString(markdown);
  }
  return markdown;
}
