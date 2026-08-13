import type { VsmModel } from './VsmModel.js';
import type { VsmModelTerm } from './VsmModelTerm.js';
import type { Annotation } from './Annotation.js';
import type { SavedView } from './SavedView.js';
import type { SavedDerivedMetric } from './SavedDerivedMetric.js';
import type { ConnectionProfile } from './ConnectionProfile.js';
import type { DataSource } from './DataSource.js';
import type { Signal } from './Signal.js';
import type { AnalysisJob } from './AnalysisJob.js';
import type { ResultArtifact } from './ResultArtifact.js';
import type { Label } from './Label.js';
import type { LabelCategory } from './LabelCategory.js';
import type { AlertRule } from './AlertRule.js';
import type { ModelOutput } from './ModelOutput.js';
import type { AlertEvent } from './AlertEvent.js';
import type { ScenarioRun } from './ScenarioRun.js';
import type { Investigation } from './Investigation.js';
import type { Evidence } from './Evidence.js';
import type { EvidenceArtifact } from './EvidenceArtifact.js';
import type { SpcBaseline } from './SpcBaseline.js';
import type { SignalMetadata } from './SignalMetadata.js';
import type { ActivatorAlert } from './ActivatorAlert.js';

/**
 * Registered entity set for the Operations IQ app. The Rayfin CLI
 * compiles these into the Fabric SQL schema, GraphQL API, and the type-safe
 * RayfinClient (client.data.<entity>). Add every entity class here.
 */
export type OperationsIqAppSchema = {
  VsmModel: VsmModel;
  VsmModelTerm: VsmModelTerm;
  Annotation: Annotation;
  SavedView: SavedView;
  SavedDerivedMetric: SavedDerivedMetric;
  ConnectionProfile: ConnectionProfile;
  // Matrix Profile entities
  DataSource: DataSource;
  Signal: Signal;
  AnalysisJob: AnalysisJob;
  ResultArtifact: ResultArtifact;
  Label: Label;
  LabelCategory: LabelCategory;
  AlertRule: AlertRule;
  ModelOutput: ModelOutput;
  AlertEvent: AlertEvent;
  ScenarioRun: ScenarioRun;
  // Investigations & Evidence (case-study capture)
  Investigation: Investigation;
  Evidence: Evidence;
  EvidenceArtifact: EvidenceArtifact;
  // Governed SPC baselines (Phase I/II control limits + spec)
  SpcBaseline: SpcBaseline;
  // Governed per-signal process-health metadata (limits, rules, SPC binding)
  SignalMetadata: SignalMetadata;
  // App-side pointers to Fabric Activator (Reflex) alerts
  ActivatorAlert: ActivatorAlert;
};