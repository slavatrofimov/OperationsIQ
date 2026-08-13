/**
 * Tag catalog access. Reads hierarchy and metadata from the Eventhouse so the
 * UI can present a friendly, hierarchy-aware tag browser. An active Connection
 * Profile is required: its canonical KQL queries (hierarchy + metadata) drive
 * the catalog. Read-only; runs under the user's delegated Kusto token (RLS
 * enforced).
 */
import { queryRows } from './eventhouse';
import type { ConnectionProfile, KqlOptions } from './connectionProfile';

export interface TagInfo {
  tagId: string;       // SignalId
  tagName: string;     // SignalName
  metric: string;      // MetricName
  description: string;
  engUnits: string;    // UnitOfMeasure
  samplingFrequency?: string;
  level1?: string;
  level2?: string;
  level3?: string;
  level4?: string;
  level5?: string;
  level6?: string;
  level7?: string;
  level8?: string;
  level9?: string;
  level10?: string;
  // Backward-compat aliases (derived from level1..level4)
  plant?: string;    // = level1
  factory?: string;  // = level2
  line?: string;     // = level3
  station?: string;  // = level4

  // --- Governed process-health metadata (optional) ---------------------------
  // Sourced from the SignalMetadata store (Fabric App SQL DB, mirrored to OneLake
  // and surfaced as a KQL external table joined into the metadata base query), or
  // merged client-side via mergeSignalMetadata(). All optional: consumers treat
  // them as overridable defaults, never hard constraints.
  /** Target operating value. */
  operatingSetpoint?: number;
  /** Upper / lower operating envelope. */
  upperOperatingLimit?: number;
  lowerOperatingLimit?: number;
  /** Maximum expected rate of change (engineering units per minute). */
  maxRateOfChange?: number;
  /** Specification limits (product/process spec). */
  usl?: number;
  lsl?: number;
  target?: number;
  /** Plausible physical range for sensor validation. */
  physicalMin?: number;
  physicalMax?: number;
  sensorUncertainty?: number;
  /** Id of the approved SpcBaseline supplying control limits, if bound. */
  activeBaselineId?: string;
  /** Preferred control-chart family ('i-mr' | 'xbar-r' | 'xbar-s'). */
  preferredChartType?: string;
  /** Preferred special-cause rule profile key. */
  ruleProfile?: string;
  /** Recommended alert threshold / deviation-band confidence. */
  recommendedAlertThreshold?: number;
  recommendedConfidence?: number;
}

// ---------------------------------------------------------------------------
// Profile-based query (canonical schema)
// ---------------------------------------------------------------------------

export interface CanonicalRow {
  SignalId: string;
  SignalName?: string;
  MetricName?: string;
  UnitOfMeasure?: string;
  SamplingFrequency?: string;
  Description?: string;
  Level1?: string;
  Level2?: string;
  Level3?: string;
  Level4?: string;
  Level5?: string;
  Level6?: string;
  Level7?: string;
  Level8?: string;
  Level9?: string;
  Level10?: string;
  // Governed process-health metadata (optional; from the SignalMetadata external table).
  OperatingSetpoint?: number | string;
  UpperOperatingLimit?: number | string;
  LowerOperatingLimit?: number | string;
  MaxRateOfChange?: number | string;
  USL?: number | string;
  LSL?: number | string;
  Target?: number | string;
  PhysicalMin?: number | string;
  PhysicalMax?: number | string;
  SensorUncertainty?: number | string;
  ActiveBaselineId?: string;
  PreferredChartType?: string;
  RuleProfile?: string;
  RecommendedAlertThreshold?: number | string;
  RecommendedConfidence?: number | string;
}

/**
 * Build the shared `let`-prelude that binds a canonical `Catalog` table (one row
 * per signal, hierarchy + governed metadata joined and projected to the canonical
 * column names). Both {@link listTags} and the scalable catalog service
 * (`lib/catalog.ts`) reuse this so their column shape stays identical — callers
 * append their own `Catalog | …` operators (search / paging / summarize / count).
 *
 * Optional columns are resolved with `column_ifexists` so profiles whose queries
 * omit them (e.g. SamplingFrequency or Level5–Level10) still work.
 */
export function buildCatalogPrelude(profile: ConnectionProfile): string {
  return `let Hierarchy = (
${profile.hierarchyQuery}
);
let Metadata = (
${profile.metadataQuery}
);
let Catalog = (
Hierarchy
| join kind=leftouter (Metadata) on SignalId
| project SignalId,
    SignalName = column_ifexists("SignalName", ""),
    MetricName = column_ifexists("MetricName", ""),
    UnitOfMeasure = column_ifexists("UnitOfMeasure", ""),
    SamplingFrequency = column_ifexists("SamplingFrequency", ""),
    Description = column_ifexists("Description", ""),
    Level1 = column_ifexists("Level1", ""),
    Level2 = column_ifexists("Level2", ""),
    Level3 = column_ifexists("Level3", ""),
    Level4 = column_ifexists("Level4", ""),
    Level5 = column_ifexists("Level5", ""),
    Level6 = column_ifexists("Level6", ""),
    Level7 = column_ifexists("Level7", ""),
    Level8 = column_ifexists("Level8", ""),
    Level9 = column_ifexists("Level9", ""),
    Level10 = column_ifexists("Level10", ""),
    OperatingSetpoint = column_ifexists("OperatingSetpoint", real(null)),
    UpperOperatingLimit = column_ifexists("UpperOperatingLimit", real(null)),
    LowerOperatingLimit = column_ifexists("LowerOperatingLimit", real(null)),
    MaxRateOfChange = column_ifexists("MaxRateOfChange", real(null)),
    USL = column_ifexists("USL", real(null)),
    LSL = column_ifexists("LSL", real(null)),
    Target = column_ifexists("Target", real(null)),
    PhysicalMin = column_ifexists("PhysicalMin", real(null)),
    PhysicalMax = column_ifexists("PhysicalMax", real(null)),
    SensorUncertainty = column_ifexists("SensorUncertainty", real(null)),
    ActiveBaselineId = column_ifexists("ActiveBaselineId", ""),
    PreferredChartType = column_ifexists("PreferredChartType", ""),
    RuleProfile = column_ifexists("RuleProfile", ""),
    RecommendedAlertThreshold = column_ifexists("RecommendedAlertThreshold", real(null)),
    RecommendedConfidence = column_ifexists("RecommendedConfidence", real(null))
);`;
}

/**
 * Normalize canonical `Catalog` rows into {@link TagInfo}. `column_ifexists`
 * fills missing string columns with "" — those are mapped back to `undefined` so
 * hierarchy levels and optional fields behave as before; numeric columns default
 * to `real(null)` and are coerced to a finite number or `undefined`.
 */
export function mapCanonicalRows(rows: CanonicalRow[]): TagInfo[] {
  const clean = (v?: string): string | undefined => (v ? v : undefined);
  const optNum = (v?: number | string): number | undefined => {
    if (v == null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return rows.map((r) => ({
    tagId: r.SignalId,
    tagName: r.SignalName ?? r.SignalId,
    metric: r.MetricName ?? '',
    description: r.Description ?? '',
    engUnits: r.UnitOfMeasure ?? '',
    samplingFrequency: clean(r.SamplingFrequency),
    level1: clean(r.Level1),
    level2: clean(r.Level2),
    level3: clean(r.Level3),
    level4: clean(r.Level4),
    level5: clean(r.Level5),
    level6: clean(r.Level6),
    level7: clean(r.Level7),
    level8: clean(r.Level8),
    level9: clean(r.Level9),
    level10: clean(r.Level10),
    // backward-compat aliases
    plant: clean(r.Level1),
    factory: clean(r.Level2),
    line: clean(r.Level3),
    station: clean(r.Level4),
    // governed process-health metadata (from the SignalMetadata external table)
    operatingSetpoint: optNum(r.OperatingSetpoint),
    upperOperatingLimit: optNum(r.UpperOperatingLimit),
    lowerOperatingLimit: optNum(r.LowerOperatingLimit),
    maxRateOfChange: optNum(r.MaxRateOfChange),
    usl: optNum(r.USL),
    lsl: optNum(r.LSL),
    target: optNum(r.Target),
    physicalMin: optNum(r.PhysicalMin),
    physicalMax: optNum(r.PhysicalMax),
    sensorUncertainty: optNum(r.SensorUncertainty),
    activeBaselineId: clean(r.ActiveBaselineId),
    preferredChartType: clean(r.PreferredChartType),
    ruleProfile: clean(r.RuleProfile),
    recommendedAlertThreshold: optNum(r.RecommendedAlertThreshold),
    recommendedConfidence: optNum(r.RecommendedConfidence),
  }));
}

async function listTagsFromProfile(
  profile: ConnectionProfile,
  kqlOpts: KqlOptions,
): Promise<TagInfo[]> {
  const csl = `${buildCatalogPrelude(profile)}
Catalog
| order by SignalId asc`;
  const rows = await queryRows<CanonicalRow>(csl, kqlOpts);
  return mapCanonicalRows(rows);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all signals with hierarchy and metadata. Requires an active Connection
 * Profile: its canonical KQL queries (hierarchy + metadata) are used. Throws
 * when no profile is supplied — the app cannot browse a catalog without one.
 */
export async function listTags(
  profile?: ConnectionProfile | null,
  kqlOpts?: KqlOptions,
): Promise<TagInfo[]> {
  if (!profile) {
    throw new Error(
      'No active connection profile: select or configure a connection before browsing signals.',
    );
  }
  return listTagsFromProfile(profile, kqlOpts ?? {});
}

