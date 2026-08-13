/**
 * Investigations & Evidence persistence, backed by the Rayfin data API
 * (client.data.Investigation / Evidence / EvidenceArtifact). An Investigation is
 * a named, described analysis session that acts as a container ("evidence pack");
 * each captured page is stored as a piece of Evidence with its ECharts graphs
 * saved as EvidenceArtifact rows (PNG + CSV). Row-level security scopes every
 * record to the signing-in user.
 */

import { client, getFabricAccountId, getFabricAccountEmail } from './rayfinClient';
import { getActiveProfileId } from './activeConnection';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Investigation {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  connection_profile_id?: string;
  created_at: Date;
  updated_at: Date;
}

export interface Evidence {
  id: string;
  investigation_id: string;
  user_id: string;
  page_key: string;
  page_name: string;
  user_name: string;
  annotation?: string;
  markdown: string;
  created_at: Date;
}

export type ArtifactKind = 'png' | 'csv' | 'markdown';

export interface EvidenceArtifact {
  id: string;
  evidence_id: string;
  user_id: string;
  kind: ArtifactKind;
  title: string;
  mime: string;
  ordinal: number;
  /** Chunk sequence within one (kind, ordinal), 0-based. */
  seq: number;
  /** Base64 PNG bytes (no data-URL prefix) for png; raw text for csv/markdown. */
  content: string;
  created_at: Date;
}

/** A chart captured from a page, ready to persist as two artifacts. */
export interface CapturedChart {
  title: string;
  /** PNG as a data URL (data:image/png;base64,...). */
  pngDataUrl: string;
  /** CSV text of the plotted data (may be empty when unavailable). */
  csv: string;
}

/** Everything needed to persist one captured page. */
export interface EvidenceCaptureInput {
  investigationId: string;
  pageKey: string;
  pageName: string;
  annotation?: string;
  markdown: string;
  charts: CapturedChart[];
}

export interface EvidenceWithArtifacts {
  evidence: Evidence;
  artifacts: EvidenceArtifact[];
}

// ---------------------------------------------------------------------------
// Field selections
// ---------------------------------------------------------------------------
//
// The Rayfin GraphQL query builder only returns the `id` field unless an
// explicit `.select([...])` is supplied (see @microsoft/rayfin-data
// GraphQLQueryBuilder.buildFieldSelection). Without these, reads would come
// back with every non-id column `undefined` — which is why investigation names
// (and all other fields) showed up blank.

const INVESTIGATION_FIELDS = [
  'id',
  'user_id',
  'name',
  'description',
  'created_at',
  'updated_at',
  'connection_profile_id',
] as const;

const EVIDENCE_FIELDS = [
  'id',
  'investigation_id',
  'user_id',
  'page_key',
  'page_name',
  'user_name',
  'annotation',
  'markdown',
  'created_at',
] as const;

const EVIDENCE_ARTIFACT_FIELDS = [
  'id',
  'evidence_id',
  'user_id',
  'kind',
  'title',
  'mime',
  'ordinal',
  'seq',
  'content',
  'created_at',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireUserId(): string {
  const userId = getFabricAccountId();
  if (!userId) throw new Error('User not authenticated. Please sign in first.');
  return userId;
}

/**
 * Maximum characters of `content` stored per EvidenceArtifact row. The backend
 * rejects a single GraphQL mutation whose serialized query exceeds 64 KB, so we
 * keep each chunk well under that to leave room for the mutation text, field
 * names, and other column values.
 */
const CHUNK_SIZE = 40000;

/** Split a string into <= CHUNK_SIZE pieces. Empty input yields no chunks. */
function chunkString(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += CHUNK_SIZE) out.push(s.slice(i, i + CHUNK_SIZE));
  return out;
}

/** Concatenate the chunks of one logical (kind, ordinal) artifact in seq order. */
function joinChunks(chunks: EvidenceArtifact[]): string {
  return [...chunks].sort((a, b) => a.seq - b.seq).map((c) => c.content).join('');
}

/**
 * Reassemble raw chunk rows into the page's markdown plus one merged artifact
 * per chart (kind png/csv, ordinal). Markdown chunks are folded into `markdown`
 * and excluded from the returned artifact list; the merged artifacts carry the
 * full reassembled `content` so the viewer can render/download them directly.
 */
function reassembleArtifacts(raw: EvidenceArtifact[]): {
  markdown: string;
  artifacts: EvidenceArtifact[];
} {
  const groups = new Map<string, EvidenceArtifact[]>();
  for (const a of raw) {
    const key = `${a.kind}#${a.ordinal}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(a);
  }

  let markdown = '';
  const artifacts: EvidenceArtifact[] = [];
  for (const [key, chunks] of groups) {
    const content = joinChunks(chunks);
    if (key.startsWith('markdown#')) {
      markdown = content;
      continue;
    }
    const first = [...chunks].sort((a, b) => a.seq - b.seq)[0];
    artifacts.push({ ...first, seq: 0, content });
  }
  artifacts.sort((a, b) => a.ordinal - b.ordinal || a.kind.localeCompare(b.kind));
  return { markdown, artifacts };
}

/** Strip the `data:...;base64,` prefix from a data URL, returning the bytes. */
function stripDataUrl(dataUrl: string): { mime: string; base64: string } {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (match) return { mime: match[1], base64: match[2] };
  return { mime: 'image/png', base64: dataUrl };
}

// ---------------------------------------------------------------------------
// Investigations
// ---------------------------------------------------------------------------

export async function listInvestigations(): Promise<Investigation[]> {
  const userId = requireUserId();
  const rows = await client.data.Investigation
    .select([...INVESTIGATION_FIELDS])
    .where({ user_id: userId })
    .orderBy({ updated_at: 'desc' })
    .execute();
  const pid = getActiveProfileId();
  const scoped = pid
    ? rows.filter((r) => (r as Investigation).connection_profile_id === pid)
    : rows;
  return scoped as Investigation[];
}

export async function createInvestigation(
  name: string,
  description?: string,
): Promise<Investigation> {
  const userId = requireUserId();
  const now = new Date();
  const result = await client.data.Investigation.create({
    user_id: userId,
    name,
    description: description || undefined,
    connection_profile_id: getActiveProfileId(),
    created_at: now,
    updated_at: now,
  });
  return result as Investigation;
}

export async function updateInvestigation(
  id: string,
  updates: { name?: string; description?: string },
): Promise<Investigation> {
  const result = await client.data.Investigation.update(
    { id },
    { ...updates, updated_at: new Date() },
  );
  return result as Investigation;
}

/** Delete an investigation and all of its evidence + artifacts. */
export async function deleteInvestigation(id: string): Promise<void> {
  const evidence = await listEvidence(id);
  for (const e of evidence) {
    await deleteEvidence(e.id);
  }
  await client.data.Investigation.delete({ id });
}

/** Bump an investigation's updated_at (e.g. after adding evidence). */
async function touchInvestigation(id: string): Promise<void> {
  try {
    await client.data.Investigation.update({ id }, { updated_at: new Date() });
  } catch {
    // Non-fatal: ordering-only side effect.
  }
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export async function listEvidence(investigationId: string): Promise<Evidence[]> {
  const rows = await client.data.Evidence
    .select([...EVIDENCE_FIELDS])
    .where({ investigation_id: investigationId })
    .orderBy({ created_at: 'asc' })
    .execute();
  return rows as Evidence[];
}

export async function listArtifacts(evidenceId: string): Promise<EvidenceArtifact[]> {
  const rows = await client.data.EvidenceArtifact
    .select([...EVIDENCE_ARTIFACT_FIELDS])
    .where({ evidence_id: evidenceId })
    .orderBy({ ordinal: 'asc' })
    .execute();
  return rows as EvidenceArtifact[];
}

export async function getEvidence(id: string): Promise<EvidenceWithArtifacts> {
  const evidence = (
    await client.data.Evidence.select([...EVIDENCE_FIELDS]).where({ id }).execute()
  )[0] as Evidence | undefined;
  if (!evidence) throw new Error(`Evidence ${id} not found.`);
  const raw = await listArtifacts(id);
  const { markdown, artifacts } = reassembleArtifacts(raw);
  // Prefer reassembled markdown; fall back to any inline value for old rows.
  evidence.markdown = markdown || evidence.markdown || '';
  return { evidence, artifacts };
}

/**
 * Persist one captured page. The Evidence row holds only small metadata; the
 * (potentially large) markdown snapshot and each chart's PNG/CSV are written as
 * chunked EvidenceArtifact rows so no single mutation exceeds the backend's
 * 64 KB cap.
 */
export async function addEvidence(input: EvidenceCaptureInput): Promise<Evidence> {
  const userId = requireUserId();
  const userName = getUserDisplayName();
  const now = new Date();

  const evidence = (await client.data.Evidence.create({
    investigation_id: input.investigationId,
    user_id: userId,
    page_key: input.pageKey,
    page_name: input.pageName,
    user_name: userName,
    annotation: input.annotation || undefined,
    created_at: now,
  })) as Evidence;

  const writeChunks = async (
    kind: ArtifactKind,
    title: string,
    mime: string,
    ordinal: number,
    text: string,
  ) => {
    const chunks = chunkString(text);
    for (let seq = 0; seq < chunks.length; seq += 1) {
      await client.data.EvidenceArtifact.create({
        evidence_id: evidence.id,
        user_id: userId,
        kind,
        title,
        mime,
        ordinal,
        seq,
        content: chunks[seq],
        created_at: now,
      });
    }
  };

  await writeChunks('markdown', 'markdown', 'text/markdown', 0, input.markdown);

  let ordinal = 0;
  for (const chart of input.charts) {
    const { mime, base64 } = stripDataUrl(chart.pngDataUrl);
    await writeChunks('png', chart.title, mime, ordinal, base64);
    if (chart.csv) await writeChunks('csv', chart.title, 'text/csv', ordinal, chart.csv);
    ordinal += 1;
  }

  await touchInvestigation(input.investigationId);
  return evidence;
}

export async function deleteEvidence(id: string): Promise<void> {
  const artifacts = await listArtifacts(id);
  for (const a of artifacts) {
    await client.data.EvidenceArtifact.delete({ id: a.id });
  }
  await client.data.Evidence.delete({ id });
}

/** The signing-in user's display name (email), used to stamp captured evidence. */
export function getUserDisplayName(): string {
  return getFabricAccountEmail() ?? getFabricAccountId() ?? 'Unknown user';
}
