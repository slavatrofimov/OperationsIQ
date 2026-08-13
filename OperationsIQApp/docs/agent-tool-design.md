# Agent tool-output design guide

How to shape the **result** of any Operations Advisor tool so the agent can reason
about it well. This applies to every analysis adapter under `src/lib/agent/tools/`
(forecast, and anything added later: anomalies, correlation, root-cause, similarity,
regression, decomposition, …), not just forecasting.

The tool *plumbing* is covered by the doc-comments in `src/lib/agent/types.ts`
(the `build*Query -> executeKql -> parse* -> analytics` seam, client-side execution,
RLS/profile scoping). This guide is specifically about **what a tool returns to the
model and in what form**.

## Core principle: summarize, don't dump

More rows is not more insight. LLMs — even multimodal ones — reason **poorly over
long raw numeric arrays**: they cannot reliably do arithmetic across hundreds of
points, and a giant array burns context, latency, and money while creating a false
sense of rigor. A tool's job is to hand the model **decision-relevant structure**,
not raw resolution.

Every tool result should be *small by default* and *drillable on demand*.

## The `ToolResult` contract

Return the uniform `ToolResult` (`src/lib/agent/types.ts`):

- **`summary`** — 1–3 lines the model can quote verbatim. Always present, even on
  error. State the headline finding and the single most important caveat.
- **`data`** — a **compact** structured payload. Never a raw multi-thousand-point
  series. This is where the extracted features + a downsampled preview + a result
  handle go (see below).
- **`chart`** — an optional `{ title, pngDataUrl, csv }` for multimodal turns and for
  showing the user. The `pngDataUrl`/`csv` are **stripped before the result is sent
  to the model as text** — the image rides on a message, not a tool output (see
  "Multimodal").
- **`error`** — `{ code, message }`; return `ok:false` via `toolError()`, never throw.

## The six practices

Apply these in roughly this priority order.

### 1. Feature extraction (highest value)

Post-process the analytics **once, on the client**, into a small object of salient,
named features. This is the single biggest lever on analysis quality. Prefer scalars
and short labelled records over arrays. Typical families of features:

- **Trend / direction**: slope, total change, % change, `rising | falling | flat`.
- **Level & extrema**: first / last / min / max / mean, **and the timestamps of the
  extrema** (naïve even-sampling is exactly what loses these).
- **Uncertainty**: the spread metric your method produces (e.g. σ, CI half-width),
  how it evolves (start vs end, widening rate).
- **Event probabilities**: threshold/breach probabilities, first-crossing time,
  expected count/duration of the event.
- **Fit / quality caveats**: in-sample residual behaviour, goodness-of-fit,
  **fraction of input that was interpolated or missing** (data coverage). Surface
  anything that should make the model hedge.

### 2. Nuance-preserving downsampling

When you must include a series preview, **do not evenly sample** — that drops spikes
and troughs, the exact "nuance" that matters. Use **min/max-per-bucket** (emit the
minimum and maximum point in each bucket) or **LTTB**. This preserves visual and
analytic fidelity at a fixed, small token budget. Cap previews to a few dozen points.

### 3. Selective columns

Send only what the model needs. Never ship the full input series. Drop internal
decomposition arrays unless summarized. Round aggressively (3 significant digits is
plenty for interpretation). Prefer a short preview + features over any full column.

### 4. Multimodal chart

Attach a **rendered PNG** of the result (reuse the app's ECharts export path). The
multimodal model reads *shape* — seasonality, regime shifts, band flare, clustering —
far better than it reads numbers. Rules:

- The chart is **complementary**, not a replacement for numeric features: the model
  reads charts *approximately*, so keep numbers authoritative for exact values.
- One clean, **labelled** chart (axes, units, legend, threshold line) is cheap
  relative to thousands of numbers.
- The image must ride on a **message content block**, not on the tool output (tool
  outputs are text-only). See `foundryClient` for the vision follow-up pass.
- Reuse the evidence-capture chart/CSV shape (`pageCapture.ts` / `CapturedChart`) so
  tool charts and page evidence look identical to the user.

### 5. Progressive disclosure + result handle

Keep the default payload small, but make the full data reachable:

- Cache the full analytic result in memory under a short **handle** (e.g.
  `forecastId`) and return the handle in `data`.
- Provide a **drill-down tool** (e.g. `forecast_detail`) that takes the handle plus a
  window (time or index range) and returns full-resolution points **only** for that
  region, still capped by a `maxPoints` ceiling. The agent pulls detail exactly where
  its reasoning needs it — nothing is permanently hidden, and context stays lean.

**Shared backbone.** Rather than each tool inventing its own cache + detail tool,
series-producing analysis tools stash their aligned tracks in the generic
`seriesCache` (`putSeries(x_ms, tracks, meta) → seriesId`) and return that `seriesId`.
A single `series_detail` tool drills into any cached entry by handle, track name, and
window. `forecast` / `forecast_detail` keep their bespoke pair (the forecast handle
also carries model params), but every other multi-track tool should reuse
`putSeries` + `series_detail` so there is exactly one drill-down surface for the agent
to learn.

### 6. Agent-controlled fidelity

Where useful, expose an optional `maxPoints` / `detail` argument so the agent can
decide how much resolution it needs for a given question.

## Always surface method assumptions

State the assumptions behind any derived quantity so the model does not over-trust it.
For example, a forecast band built from a random-walk √(steps-ahead) widening under a
Gaussian error and cross-bin independence should say so ("up to X%" for a union
probability that is really an upper bound). Encode these caveats in `summary` and/or a
`caveats` field in `data` — the model will faithfully repeat what you give it.

## Anti-patterns

- ❌ Returning the full series as JSON "so the model has everything".
- ❌ Even-step downsampling that erases extrema.
- ❌ Stuffing a base64 image into the tool-output text (huge, and invisible to vision).
- ❌ Throwing from a tool instead of returning `ok:false`.
- ❌ Unrounded floats and internal columns the model will never use.

## Checklist for a new tool

- [ ] `summary` states the finding + the key caveat.
- [ ] `data` carries extracted **features**, not raw arrays.
- [ ] Any preview uses **min/max / LTTB** downsampling and is capped.
- [ ] Floats rounded; internal columns dropped.
- [ ] A **chart** is produced when a picture aids interpretation.
- [ ] Full data is reachable via a **handle + drill-down tool**.
- [ ] Method **assumptions/limitations** are stated.
- [ ] Errors returned via `toolError`, never thrown.

## Naming & description convention (discoverability)

As the toolset grows, the agent picks the right tool almost entirely from its
**name** and **description**, so treat both as part of the tool's contract. Keep
them consistent so tools stay easy to discover and hard to confuse.

### Names

- **`snake_case`, lower-case**, matching the OpenAI function-tool convention and
  what the model sees in every run (`resolve_tags`, `forecast`, `forecast_detail`).
- **`verb_noun`** for actions (`resolve_tags`, `forecast`); a **`<base>_<facet>`**
  suffix for a drill-down/variant of an existing tool (`forecast_detail`) so
  related tools sort and read together.
- **Read-only by default.** A future side-effecting tool should make the effect
  obvious in the verb (`create_…`, `update_…`, `delete_…`, `save_…`, `set_…`,
  `capture_…`) — never a euphemism —
  since only these can trip the `readOnly` / `allowSideEffects` policy gate.
- Stable and unique: the registry throws on a duplicate name. Renaming a tool is a
  breaking change to the agent's learned behaviour — prefer adding a new tool.

### Descriptions

Write the description as a short brief to the model. In order:

1. **What it does** in one sentence (the capability, not the implementation).
2. **When to use it / prerequisites** — e.g. "Call `resolve_tags` first to obtain
   `tagId`." State ordering dependencies explicitly; the model relies on them.
3. **What it returns** at a high level (features + preview + handle + chart), so the
   model knows a follow-up/drill-down tool exists.
4. **Key constraints** — units and formats (e.g. "Times are ISO 8601, UTC"),
   ranges, and which arguments are required together.

Keep it a few sentences: enough to route correctly, not a manual. Put exhaustive
per-argument detail in the JSON-Schema `description` of each parameter, not in the
tool description. Don't restate the schema in prose.

The three pilot tools already follow this convention: `resolve_tags` (verb_noun,
"ALWAYS call this first…"), `forecast` (states prerequisites, output shape, and the
`forecast_detail` follow-up, ISO-8601 constraint), and `forecast_detail` (the
`<base>_<facet>` drill-down naming, "Use this after `forecast`…"). New tools should
match this shape.

## Out of scope (future follow-ups)

- **Streaming (SSE)** of run/assistant output is intentionally NOT implemented. The
  client uses request/response polling (`runOnce` in `foundryClient.ts`). Adding an
  SSE transport for token-by-token streaming is a separate future effort and would
  slot in alongside — not replace — the existing polling path.
