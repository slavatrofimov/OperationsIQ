/**
 * SAX-VSM helpers: parse train/classify results and persist trained models to
 * Rayfin (VsmModel + VsmModelTerm). A model's term weights are read back and
 * materialized into an inline KQL datatable for classification, so no
 * Eventhouse-side model table is needed.
 */
import { client, getFabricAccountId } from './rayfinClient';
import { getActiveProfileId } from './activeConnection';
import type { KustoTable } from './eventhouse';
import type { VsmTerm } from './kql';

function indexer(table: KustoTable) {
  const map = new Map(table.columns.map((c, i) => [c.name, i]));
  return (name: string): number => map.get(name) ?? -1;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** Parse `sax_vsm_train` output into (class_label, word, weight) terms. */
export function parseVsmTerms(table: KustoTable): VsmTerm[] {
  const at = indexer(table);
  const iClass = at('class_label');
  const iWord = at('word');
  const iWeight = at('weight');
  return table.rows.map((r) => ({
    class_label: String(r[iClass] ?? ''),
    word: String(r[iWord] ?? ''),
    weight: num(r[iWeight]),
  }));
}

/** One contributing word behind a class score. */
export interface VsmContributingWord {
  word: string;
  contribution: number;
  weight: number;
}

/** Per-class cosine score with its top contributing words. */
export interface VsmClassScore {
  classLabel: string;
  cosineSimilarity: number;
  topWords: VsmContributingWord[];
}

/** Parsed `sax_vsm_classify` result for one input series. */
export interface VsmClassifyResult {
  predictedClass: string;
  confidence: number;
  isAmbiguous: boolean;
  classScores: VsmClassScore[];
}

/** Parse `sax_vsm_classify` output (single input series) into a typed result. */
export function parseVsmClassifyResult(table: KustoTable): VsmClassifyResult | null {
  const at = indexer(table);
  const iPred = at('predicted_class');
  const iConf = at('confidence');
  const iAmb = at('is_ambiguous');
  const iScores = at('class_scores');
  const r = table.rows[0];
  if (!r) return null;

  const rawScores = Array.isArray(r[iScores]) ? (r[iScores] as unknown[]) : [];
  const classScores: VsmClassScore[] = rawScores
    .map((s) => {
      const b = (s ?? {}) as Record<string, unknown>;
      const topRaw = Array.isArray(b.top_words) ? (b.top_words as unknown[]) : [];
      return {
        classLabel: String(b.class_label ?? ''),
        cosineSimilarity: num(b.cosine_similarity),
        topWords: topRaw.map((w) => {
          const wb = (w ?? {}) as Record<string, unknown>;
          return {
            word: String(wb.word ?? ''),
            contribution: num(wb.contribution),
            weight: num(wb.weight),
          };
        }),
      };
    })
    .sort((a, b) => b.cosineSimilarity - a.cosineSimilarity);

  return {
    predictedClass: String(r[iPred] ?? ''),
    confidence: num(r[iConf]),
    isAmbiguous: Boolean(r[iAmb]),
    classScores,
  };
}

/** Parameters shared by train/classify, stored alongside a model. */
export interface VsmModelParams {
  windowSize: number;
  paaSize: number;
  alphabetSize: number;
  znormThreshold: number;
  numerosityReduction: string;
}

/** A saved model as surfaced to the UI. */
export interface VsmModelSummary {
  id: string;
  name: string;
  params: VsmModelParams;
  createdAt: Date;
}

/** Persist a trained model and its term weights under a user-chosen name. */
export async function saveVsmModel(
  name: string,
  params: VsmModelParams,
  terms: VsmTerm[],
): Promise<string> {
  const userId = getFabricAccountId();
  if (!userId) throw new Error('Sign in with Fabric before saving a model.');
  const model = await client.data.VsmModel.create({
    user_id: userId,
    name,
    window_size: params.windowSize,
    paa_size: params.paaSize,
    alphabet_size: params.alphabetSize,
    znorm_threshold: params.znormThreshold,
    numerosity_reduction: params.numerosityReduction,
    connection_profile_id: getActiveProfileId(),
    created_at: new Date(),
  });
  for (const t of terms) {
    await client.data.VsmModelTerm.create({
      user_id: userId,
      vsm_model_id: model.id,
      class_label: t.class_label,
      word: t.word,
      weight: t.weight,
    });
  }
  return model.id;
}

/** List the current user's saved models, newest first. */
export async function listVsmModels(): Promise<VsmModelSummary[]> {
  const rows = await client.data.VsmModel.select([
    'id',
    'name',
    'window_size',
    'paa_size',
    'alphabet_size',
    'znorm_threshold',
    'numerosity_reduction',
    'created_at',
    'connection_profile_id',
  ]).execute();
  const pid = getActiveProfileId();
  const scoped = pid ? rows.filter((r) => r.connection_profile_id === pid) : rows;
  return scoped
    .map((r) => ({
      id: r.id,
      name: r.name,
      params: {
        windowSize: r.window_size,
        paaSize: r.paa_size,
        alphabetSize: r.alphabet_size,
        znormThreshold: r.znorm_threshold,
        numerosityReduction: r.numerosity_reduction,
      },
      createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    }))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** Read back a saved model's term weights for inline classification. */
export async function loadVsmTerms(modelId: string): Promise<VsmTerm[]> {
  const rows = await client.data.VsmModelTerm.select(['class_label', 'word', 'weight'])
    .where({ vsm_model_id: { eq: modelId } })
    .execute();
  return rows.map((r) => ({ class_label: r.class_label, word: r.word, weight: r.weight }));
}

/** Delete a saved model and all of its term rows. */
export async function deleteVsmModel(modelId: string): Promise<void> {
  const terms = await client.data.VsmModelTerm.select(['id'])
    .where({ vsm_model_id: { eq: modelId } })
    .execute();
  for (const t of terms) await client.data.VsmModelTerm.delete({ id: t.id });
  await client.data.VsmModel.delete({ id: modelId });
}
