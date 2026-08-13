import type { PageKey } from './pages';
import type { IndustryKey } from './industries';
import { industryLabel } from './industries';
import {
  getTemplate,
  CATEGORY_LABELS,
  type TemplateCategory,
} from './playbookTemplates';

/**
 * Domain playbooks (functional spec §Playbooks / §Multi-industry).
 *
 * A domain playbook is a lightweight implementation of a PlaybookTemplate for a
 * specific industry and domain. It re-uses the template's ordered steps but
 * re-describes them in the industry's own terminology (title, summary, "why it
 * matters", and optional per-step text).
 *
 * Resolving a playbook (resolvePlaybook) layers the template step text with the
 * domain step overrides, producing a ResolvedPlaybook that the Playbooks page
 * renders and hands off to the Operations Advisor with concrete,
 * industry-specific guidance.
 */

// ---------------------------------------------------------------------------
// Authoring model
// ---------------------------------------------------------------------------

export interface StepOverride {
  title?: string;
  detail?: string;
}

export interface DomainPlaybook {
  id: string;
  /** The template this playbook implements. */
  templateId: string;
  industry: IndustryKey;
  /** Sub-domain within the industry (e.g. 'Upstream', 'Wind', 'HVAC'). */
  domain: string;
  title: string;
  summary: string;
  whyItMatters: string;
  /** Per-step text overrides keyed by step index. */
  stepOverrides?: Record<number, StepOverride>;
}

// ---------------------------------------------------------------------------
// Resolved model (rendered / launched)
// ---------------------------------------------------------------------------

export interface ResolvedStep {
  page: PageKey;
  title: string;
  detail: string;
}

export interface ResolvedPlaybook {
  id: string;
  templateId: string;
  title: string;
  summary: string;
  whyItMatters: string;
  category: TemplateCategory;
  industry: IndustryKey;
  domain: string;
  startPage: PageKey;
  steps: ResolvedStep[];
}

/**
 * Backward-compatible alias. The app consumes the resolved shape (title,
 * summary, steps with page/detail, startPage), which ResolvedPlaybook
 * satisfies.
 */
export type Playbook = ResolvedPlaybook;

// ---------------------------------------------------------------------------
// Domain playbook catalog
// ---------------------------------------------------------------------------

export const DOMAIN_PLAYBOOKS: DomainPlaybook[] = [
  // --- Oil & Gas ------------------------------------------------------------
  {
    id: 'og_well_underperformance',
    templateId: 'underperformance_diagnosis',
    industry: 'oil_gas',
    domain: 'Upstream',
    title: 'Well underperformance',
    summary: 'Diagnose why a well is producing below its expected rate.',
    whyItMatters:
      'Sustained underperformance means lost production and can signal decline, blockage, or artificial-lift problems that compound if left unaddressed.',
    stepOverrides: {
      0: { detail: 'Plot the well’s production rate over the recent window and compare it to prior periods.' },
      3: { detail: 'Rank upstream signals (tubing/casing pressure, choke, GOR) by lagged correlation to the rate drop.' },
    },
  },
  {
    id: 'og_compressor_anomaly',
    templateId: 'anomaly_investigation',
    industry: 'oil_gas',
    domain: 'Upstream',
    title: 'Compressor anomaly',
    summary: 'Investigate abnormal vibration or temperature on a gas compressor.',
    whyItMatters:
      'Early anomaly detection on rotating equipment prevents unplanned trips and catastrophic mechanical failure.',
    stepOverrides: {
      0: { detail: 'Monitor vibration/bearing temperature against the expected band; note breach spans.' },
    },
  },
  {
    id: 'og_pipeline_leak',
    templateId: 'balance_loss',
    industry: 'oil_gas',
    domain: 'Midstream',
    title: 'Pipeline leak suspicion',
    summary: 'Assess a possible leak from a pressure/flow imbalance.',
    whyItMatters:
      'Leaks are safety-critical and environmentally sensitive; fast, evidence-based triage reduces spill volume and regulatory exposure.',
    stepOverrides: {
      1: { detail: 'Monitor inlet-vs-outlet flow/pressure balance for a sustained divergence.' },
      2: { detail: 'Order segment/meter signals by when they moved to bracket the leak location.' },
    },
  },
  {
    id: 'og_refinery_drift',
    templateId: 'drift_detection',
    industry: 'oil_gas',
    domain: 'Downstream',
    title: 'Refinery unit drift',
    summary: 'Detect slow drift in a process unit away from its baseline.',
    whyItMatters:
      'Gradual drift erodes yield and product quality before it trips hard limits; catching it early protects margin.',
  },
  {
    id: 'og_wellhead_sensor_validation',
    templateId: 'sensor_validation',
    industry: 'oil_gas',
    domain: 'Upstream',
    title: 'Wellhead sensor validation',
    summary: 'Decide whether a wellhead reading is a real change or a bad transmitter.',
    whyItMatters:
      'Acting on a faulty transmitter causes wrong artificial-lift decisions and false alarms; validating first preserves trust in the data.',
  },
  {
    id: 'og_esp_maintenance',
    templateId: 'predictive_maintenance',
    industry: 'oil_gas',
    domain: 'Artificial lift',
    title: 'ESP degradation',
    summary: 'Catch electric submersible pump wear before it fails downhole.',
    whyItMatters:
      'A failed ESP means an expensive workover and deferred production; forecasting motor current/temperature buys time to plan a pull.',
    stepOverrides: {
      0: { detail: 'Trend ESP motor current, intake pressure, and winding temperature over time.' },
    },
  },
  {
    id: 'og_flare_optimization',
    templateId: 'efficiency_optimization',
    industry: 'oil_gas',
    domain: 'Downstream',
    title: 'Fuel-gas / flare optimization',
    summary: 'Reduce fuel-gas burn and flaring without upsetting the unit.',
    whyItMatters:
      'Fuel and flare losses are a direct margin and emissions cost; trimming them safely compounds across the plant.',
  },

  // --- Power & Renewables ---------------------------------------------------
  {
    id: 'pr_wind_underperformance',
    templateId: 'underperformance_diagnosis',
    industry: 'power_renewables',
    domain: 'Wind',
    title: 'Turbine underperformance',
    summary: 'Diagnose a turbine producing below its power curve.',
    whyItMatters:
      'A turbine off its power curve is lost generation revenue and often an early sign of pitch, yaw, or drivetrain issues.',
    stepOverrides: {
      2: { detail: 'Compare actual power against the expected power-curve band for the measured wind speed.' },
      3: { detail: 'Rank pitch angle, yaw error, and nacelle vibration by correlation to the power deficit.' },
    },
  },
  {
    id: 'pr_gearbox_pdm',
    templateId: 'predictive_maintenance',
    industry: 'power_renewables',
    domain: 'Wind',
    title: 'Gearbox bearing degradation',
    summary: 'Forecast gearbox bearing wear from temperature and vibration.',
    whyItMatters:
      'Gearbox replacement is one of the costliest wind O&M events; early warning enables a planned, crane-scheduled repair.',
  },
  {
    id: 'pr_solar_soiling',
    templateId: 'drift_detection',
    industry: 'power_renewables',
    domain: 'Solar',
    title: 'PV soiling / degradation drift',
    summary: 'Detect a slow decline in array performance ratio.',
    whyItMatters:
      'Soiling and module degradation quietly erode yield; catching the drift schedules cleaning or service at the right time.',
  },
  {
    id: 'pr_inverter_anomaly',
    templateId: 'anomaly_investigation',
    industry: 'power_renewables',
    domain: 'Solar',
    title: 'Inverter anomaly',
    summary: 'Investigate abnormal inverter temperature or clipping.',
    whyItMatters:
      'Inverter faults take whole strings offline; fast triage restores generation and prevents thermal damage.',
  },
  {
    id: 'pr_transformer_thermal',
    templateId: 'threshold_breach_forecast',
    industry: 'power_renewables',
    domain: 'Grid',
    title: 'Transformer thermal limit',
    summary: 'Forecast when a transformer hot-spot will breach its rating.',
    whyItMatters:
      'Exceeding thermal limits ages insulation fast; a forecasted breach-risk readout supports load-management review before a breach.',
  },
  {
    id: 'pr_turbine_benchmark',
    templateId: 'comparative_benchmarking',
    industry: 'power_renewables',
    domain: 'Wind',
    title: 'Turbine fleet benchmarking',
    summary: 'Compare turbines to find the persistent underperformer.',
    whyItMatters:
      'Ranking turbines against their peers surfaces the worst performer and the settings worth replicating fleet-wide.',
  },

  // --- Discrete Manufacturing ----------------------------------------------
  {
    id: 'mf_spindle_pdm',
    templateId: 'predictive_maintenance',
    industry: 'manufacturing',
    domain: 'CNC machining',
    title: 'Spindle bearing wear',
    summary: 'Forecast CNC spindle bearing wear from vibration and load.',
    whyItMatters:
      'A spindle seizure scraps the part and the bearing; early warning schedules a swap between jobs, not mid-cut.',
  },
  {
    id: 'mf_cycle_anomaly',
    templateId: 'anomaly_investigation',
    industry: 'manufacturing',
    domain: 'Assembly',
    title: 'Cycle-time anomaly',
    summary: 'Investigate stations drifting off their normal cycle time.',
    whyItMatters:
      'A single slow station throttles the whole line; catching the anomaly protects takt time and throughput.',
  },
  {
    id: 'mf_quality_excursion',
    templateId: 'quality_excursion',
    industry: 'manufacturing',
    domain: 'Assembly',
    title: 'Dimensional quality excursion',
    summary: 'Investigate parts drifting outside dimensional tolerance.',
    whyItMatters:
      'Out-of-tolerance parts mean scrap, rework, and customer escapes; finding the driver fast contains the affected lot.',
  },
  {
    id: 'mf_oee_drift',
    templateId: 'drift_detection',
    industry: 'manufacturing',
    domain: 'Line',
    title: 'Throughput / OEE drift',
    summary: 'Detect a slow decline in line throughput or OEE.',
    whyItMatters:
      'OEE erodes quietly through micro-stops and speed loss; catching the drift keeps the line on target.',
  },
  {
    id: 'mf_robot_startup',
    templateId: 'transient_validation',
    industry: 'manufacturing',
    domain: 'Robotics',
    title: 'Robot cell startup validation',
    summary: 'Validate a robot cell’s startup sequence against a good run.',
    whyItMatters:
      'Abnormal startup torque or timing signals mechanical wear or a mis-teach before it causes a crash.',
  },

  // --- Chemicals & Process --------------------------------------------------
  {
    id: 'ch_reactor_runaway',
    templateId: 'anomaly_investigation',
    industry: 'chemicals',
    domain: 'Reactor',
    title: 'Exothermic runaway early warning',
    summary: 'Catch an accelerating reactor temperature before runaway.',
    whyItMatters:
      'Thermal runaway is a major safety hazard; detecting the accelerating trend early enables cooling or quench in time.',
    stepOverrides: {
      0: { detail: 'Watch reactor temperature and its rate-of-rise against the safe operating band.' },
    },
  },
  {
    id: 'ch_distillation_quality',
    templateId: 'quality_excursion',
    industry: 'chemicals',
    domain: 'Distillation',
    title: 'Column purity excursion',
    summary: 'Investigate product purity drifting off spec on a column.',
    whyItMatters:
      'Off-spec product is downgraded or reprocessed; linking purity to reflux and reboiler duty contains the loss.',
  },
  {
    id: 'ch_heat_exchanger_fouling',
    templateId: 'drift_detection',
    industry: 'chemicals',
    domain: 'Utilities',
    title: 'Heat-exchanger fouling',
    summary: 'Detect fouling from a slow decline in heat-transfer efficiency.',
    whyItMatters:
      'Fouling raises energy use and cuts capacity; tracking the drift schedules cleaning before it forces a slowdown.',
  },
  {
    id: 'ch_batch_benchmark',
    templateId: 'comparative_benchmarking',
    industry: 'chemicals',
    domain: 'Batch',
    title: 'Batch-to-batch benchmarking',
    summary: 'Compare batches to find the golden and the outlier runs.',
    whyItMatters:
      'Overlaying batch profiles reveals which runs deviate and which conditions produce the best yield.',
  },
  {
    id: 'ch_mass_balance',
    templateId: 'balance_loss',
    industry: 'chemicals',
    domain: 'Process',
    title: 'Mass-balance loss',
    summary: 'Find an unaccounted material loss across a unit’s balance.',
    whyItMatters:
      'A persistent mass-balance gap points to a leak, measurement error, or diversion — each with cost and safety impact.',
  },

  // --- Water & Wastewater ---------------------------------------------------
  {
    id: 'wt_pump_pdm',
    templateId: 'predictive_maintenance',
    industry: 'water',
    domain: 'Pumping',
    title: 'Pump degradation',
    summary: 'Forecast pump wear from efficiency, vibration, and current.',
    whyItMatters:
      'A failed pump risks overflow or supply loss; early warning enables a planned rebuild instead of an emergency call-out.',
  },
  {
    id: 'wt_network_leak',
    templateId: 'balance_loss',
    industry: 'water',
    domain: 'Distribution',
    title: 'Network leak / NRW',
    summary: 'Detect non-revenue water from district metering imbalance.',
    whyItMatters:
      'Leaks waste treated water and revenue; balancing inflow against consumption localizes losses for repair crews.',
  },
  {
    id: 'wt_effluent_quality',
    templateId: 'quality_excursion',
    industry: 'water',
    domain: 'Treatment',
    title: 'Effluent quality excursion',
    summary: 'Investigate turbidity or nutrient levels breaching permit limits.',
    whyItMatters:
      'A permit exceedance carries regulatory penalties; correlating it to process drivers helps correct and document it fast.',
  },
  {
    id: 'wt_sensor_validation',
    templateId: 'sensor_validation',
    industry: 'water',
    domain: 'Treatment',
    title: 'Turbidity sensor validation',
    summary: 'Decide whether a turbidity spike is real or a fouled probe.',
    whyItMatters:
      'A fouled probe triggers false permit alarms and needless dosing; validating first avoids chemical waste.',
  },

  // --- Mining & Metals ------------------------------------------------------
  {
    id: 'mn_conveyor_pdm',
    templateId: 'predictive_maintenance',
    industry: 'mining',
    domain: 'Materials handling',
    title: 'Conveyor idler / belt wear',
    summary: 'Forecast conveyor wear from idler temperature and drive current.',
    whyItMatters:
      'A conveyor failure halts the whole material flow; early warning schedules idler swaps during planned stops.',
  },
  {
    id: 'mn_crusher_anomaly',
    templateId: 'anomaly_investigation',
    industry: 'mining',
    domain: 'Comminution',
    title: 'Crusher anomaly',
    summary: 'Investigate abnormal crusher power draw or vibration.',
    whyItMatters:
      'Tramp metal or a bearing fault can wreck a crusher; catching the anomaly protects a critical, hard-to-replace asset.',
  },
  {
    id: 'mn_mill_efficiency',
    templateId: 'efficiency_optimization',
    industry: 'mining',
    domain: 'Comminution',
    title: 'Mill energy optimization',
    summary: 'Reduce specific energy per tonne on a grinding mill.',
    whyItMatters:
      'Grinding is the largest energy consumer on most sites; small specific-energy gains cut cost and emissions at scale.',
  },

  // --- Buildings & HVAC -----------------------------------------------------
  {
    id: 'bl_chiller_efficiency',
    templateId: 'efficiency_optimization',
    industry: 'buildings',
    domain: 'HVAC',
    title: 'Chiller efficiency (kW/ton)',
    summary: 'Find and close efficiency loss on a chiller plant.',
    whyItMatters:
      'Chillers dominate building energy; improving kW/ton delivers immediate, measurable utility savings.',
  },
  {
    id: 'bl_ahu_drift',
    templateId: 'drift_detection',
    industry: 'buildings',
    domain: 'HVAC',
    title: 'Air-handler performance drift',
    summary: 'Detect drift in AHU supply temperature or fan efficiency.',
    whyItMatters:
      'AHU drift wastes energy and hurts comfort; catching it early avoids complaints and reactive service calls.',
  },
  {
    id: 'bl_energy_anomaly',
    templateId: 'anomaly_investigation',
    industry: 'buildings',
    domain: 'Energy',
    title: 'Building energy anomaly',
    summary: 'Investigate an unexpected spike in building energy use.',
    whyItMatters:
      'Energy anomalies flag faults, schedule errors, or equipment left running — quick, cheap wins when found early.',
  },
  {
    id: 'bl_comfort_forecast',
    templateId: 'threshold_breach_forecast',
    industry: 'buildings',
    domain: 'HVAC',
    title: 'Zone temperature breach',
    summary: 'Forecast whether a zone will drift outside its comfort band.',
    whyItMatters:
      'Predicting a comfort breach gives operators time to review comfort-risk options instead of reacting to complaints.',
  },

  // --- Data Centers & IT ----------------------------------------------------
  {
    id: 'dc_cooling_pdm',
    templateId: 'predictive_maintenance',
    industry: 'datacenter',
    domain: 'Cooling',
    title: 'CRAC / CRAH degradation',
    summary: 'Forecast cooling-unit degradation from temperature and fan data.',
    whyItMatters:
      'A cooling failure risks a thermal shutdown of live racks; early warning schedules service before capacity is lost.',
  },
  {
    id: 'dc_pue_drift',
    templateId: 'drift_detection',
    industry: 'datacenter',
    domain: 'Energy',
    title: 'PUE efficiency drift',
    summary: 'Detect a slow rise in power usage effectiveness.',
    whyItMatters:
      'Rising PUE means more energy spent on overhead than compute; catching the drift protects efficiency targets.',
  },
  {
    id: 'dc_thermal_forecast',
    templateId: 'threshold_breach_forecast',
    industry: 'datacenter',
    domain: 'Thermal',
    title: 'Hot-aisle thermal breach',
    summary: 'Forecast whether a hot aisle will exceed its temperature limit.',
    whyItMatters:
      'A predicted thermal breach gives operators time to review load-shift or cooling options before equipment throttles or trips.',
  },
  {
    id: 'dc_power_anomaly',
    templateId: 'anomaly_investigation',
    industry: 'datacenter',
    domain: 'Power',
    title: 'Power-draw anomaly',
    summary: 'Investigate an abnormal change in rack or PDU power draw.',
    whyItMatters:
      'Power anomalies flag failing hardware or runaway workloads and can threaten circuit limits if ignored.',
  },

  // --- Pharma & Life Sciences ----------------------------------------------
  {
    id: 'ph_bioreactor_quality',
    templateId: 'quality_excursion',
    industry: 'pharma',
    domain: 'Bioprocess',
    title: 'Bioreactor batch excursion',
    summary: 'Investigate a critical quality attribute drifting off target.',
    whyItMatters:
      'A bioreactor excursion can lose a high-value batch; linking it to process parameters supports investigation and CAPA.',
  },
  {
    id: 'ph_coldchain_breach',
    templateId: 'threshold_breach_forecast',
    industry: 'pharma',
    domain: 'Cold chain',
    title: 'Cold-chain excursion',
    summary: 'Forecast whether storage temperature will breach its limit.',
    whyItMatters:
      'A cold-chain breach can spoil product and trigger a costly deviation; a forecast buys time to review corrective options.',
  },
  {
    id: 'ph_cleanroom_drift',
    templateId: 'drift_detection',
    industry: 'pharma',
    domain: 'Cleanroom',
    title: 'Differential-pressure drift',
    summary: 'Detect slow drift in cleanroom cascade pressures.',
    whyItMatters:
      'Cascade pressure drift risks contamination and GMP findings; catching it early avoids a room excursion.',
  },
  {
    id: 'ph_probe_validation',
    templateId: 'sensor_validation',
    industry: 'pharma',
    domain: 'Bioprocess',
    title: 'DO / pH probe validation',
    summary: 'Decide whether a probe shift is real or a drifting sensor.',
    whyItMatters:
      'A drifting probe drives wrong dosing and false deviations; validation against redundant probes protects the batch.',
  },

  // --- Food & Beverage ------------------------------------------------------
  {
    id: 'fb_pasteurizer_quality',
    templateId: 'quality_excursion',
    industry: 'food_bev',
    domain: 'Processing',
    title: 'Pasteurization CCP excursion',
    summary: 'Investigate a pasteurizer breaching its critical control point.',
    whyItMatters:
      'A CCP excursion is a food-safety event requiring hold and review; fast root-cause limits the affected product.',
  },
  {
    id: 'fb_refrigeration_pdm',
    templateId: 'predictive_maintenance',
    industry: 'food_bev',
    domain: 'Cold storage',
    title: 'Refrigeration compressor wear',
    summary: 'Forecast refrigeration compressor degradation.',
    whyItMatters:
      'A compressor failure risks spoiling stored product; early warning schedules service before temperature is lost.',
  },
  {
    id: 'fb_filling_anomaly',
    templateId: 'anomaly_investigation',
    industry: 'food_bev',
    domain: 'Packaging',
    title: 'Fill-weight anomaly',
    summary: 'Investigate a filler drifting off target weight.',
    whyItMatters:
      'Overfill gives away product; underfill risks compliance action. Catching the anomaly protects both.',
  },

  // --- Automotive -----------------------------------------------------------
  {
    id: 'au_engine_testcell',
    templateId: 'transient_validation',
    industry: 'automotive',
    domain: 'Powertrain test',
    title: 'Engine test-cell transient',
    summary: 'Validate an engine test transient against a reference run.',
    whyItMatters:
      'Abnormal transient response flags a rig or engine issue before it invalidates an expensive test campaign.',
  },
  {
    id: 'au_battery_thermal',
    templateId: 'threshold_breach_forecast',
    industry: 'automotive',
    domain: 'EV battery',
    title: 'Cell thermal runaway forecast',
    summary: 'Forecast whether a cell will breach its thermal limit under test.',
    whyItMatters:
      'Thermal runaway is a severe safety hazard; a forecasted breach-risk readout supports abort-decision review with lead time.',
  },
  {
    id: 'au_paint_quality',
    templateId: 'quality_excursion',
    industry: 'automotive',
    domain: 'Paint shop',
    title: 'Paint booth quality excursion',
    summary: 'Investigate a finish-quality excursion in the paint booth.',
    whyItMatters:
      'Paint defects drive costly rework and rejects; linking them to booth conditions contains the affected bodies.',
  },

  // --- Aerospace & Defense --------------------------------------------------
  {
    id: 'ae_engine_health',
    templateId: 'predictive_maintenance',
    industry: 'aerospace',
    domain: 'Propulsion',
    title: 'Engine EGT margin degradation',
    summary: 'Forecast exhaust-gas-temperature margin decline on an engine.',
    whyItMatters:
      'Shrinking EGT margin predicts an engine removal; forecasting it supports fleet planning and on-wing time.',
  },
  {
    id: 'ae_structural_anomaly',
    templateId: 'anomaly_investigation',
    industry: 'aerospace',
    domain: 'Airframe',
    title: 'Structural vibration anomaly',
    summary: 'Investigate an abnormal structural vibration signature.',
    whyItMatters:
      'A new vibration signature can indicate structural fatigue; early triage informs an inspection decision.',
  },

  // --- Transportation & Fleet ----------------------------------------------
  {
    id: 'tr_locomotive_pdm',
    templateId: 'predictive_maintenance',
    industry: 'transportation',
    domain: 'Rail',
    title: 'Traction motor degradation',
    summary: 'Forecast traction-motor wear from temperature and current.',
    whyItMatters:
      'A traction-motor failure strands a locomotive; early warning supports depot-planning review before failure.',
  },
  {
    id: 'tr_fleet_benchmark',
    templateId: 'comparative_benchmarking',
    industry: 'transportation',
    domain: 'Fleet',
    title: 'Fuel-efficiency benchmarking',
    summary: 'Compare vehicles to find fuel-efficiency outliers.',
    whyItMatters:
      'Benchmarking fuel burn across a fleet surfaces the worst units and the driving/maintenance patterns worth spreading.',
  },
  {
    id: 'tr_brake_thermal',
    templateId: 'threshold_breach_forecast',
    industry: 'transportation',
    domain: 'Rail',
    title: 'Brake thermal breach',
    summary: 'Forecast whether brake temperature will breach its limit on a grade.',
    whyItMatters:
      'Overheated brakes are a safety risk on long descents; a forecast supports speed or handling decisions.',
  },

  // --- Semiconductor --------------------------------------------------------
  {
    id: 'sm_tool_drift',
    templateId: 'drift_detection',
    industry: 'semiconductor',
    domain: 'Fab',
    title: 'Etch / deposition tool drift',
    summary: 'Detect a process tool drifting from its qualified window.',
    whyItMatters:
      'Tool drift silently degrades yield; catching it before it exceeds control limits avoids scrapped wafers.',
  },
  {
    id: 'sm_chamber_anomaly',
    templateId: 'anomaly_investigation',
    industry: 'semiconductor',
    domain: 'Fab',
    title: 'Chamber pressure anomaly',
    summary: 'Investigate an abnormal chamber pressure or flow signature.',
    whyItMatters:
      'A chamber anomaly can ruin a lot of wafers; fast triage protects both the wafers and the tool.',
  },
  {
    id: 'sm_yield_correlation',
    templateId: 'event_correlation',
    industry: 'semiconductor',
    domain: 'Yield',
    title: 'Yield-loss correlation',
    summary: 'Correlate a yield-loss event across tool and process signals.',
    whyItMatters:
      'Yield excursions rarely have one obvious cause; lead/lag influence screening helps separate earlier-moving candidates from symptoms.',
  },

  // --- Marine & Shipping ----------------------------------------------------
  {
    id: 'ma_engine_pdm',
    templateId: 'predictive_maintenance',
    industry: 'marine',
    domain: 'Propulsion',
    title: 'Main engine degradation',
    summary: 'Forecast main-engine wear from exhaust temperature and pressures.',
    whyItMatters:
      'An engine failure at sea is a serious event; early warning enables repair in port on a planned schedule.',
  },
  {
    id: 'ma_fuel_efficiency',
    templateId: 'efficiency_optimization',
    industry: 'marine',
    domain: 'Voyage',
    title: 'Voyage fuel efficiency',
    summary: 'Reduce fuel burn for a given speed and trim.',
    whyItMatters:
      'Bunker fuel is a vessel’s largest operating cost; small, sustained efficiency gains add up across a voyage.',
  },

  // --- Agriculture & AgTech -------------------------------------------------
  {
    id: 'ag_irrigation_anomaly',
    templateId: 'anomaly_investigation',
    industry: 'agriculture',
    domain: 'Irrigation',
    title: 'Irrigation flow anomaly',
    summary: 'Investigate an abnormal flow or pressure in an irrigation zone.',
    whyItMatters:
      'A flow anomaly can mean a burst line or blocked emitter — wasting water or starving a crop if left unaddressed.',
  },
  {
    id: 'ag_greenhouse_drift',
    templateId: 'drift_detection',
    industry: 'agriculture',
    domain: 'Greenhouse',
    title: 'Climate setpoint drift',
    summary: 'Detect greenhouse temperature or humidity drifting from setpoint.',
    whyItMatters:
      'Climate drift stresses crops and raises energy use; catching it early protects both yield and cost.',
  },

  // --- Vibration & spectral analysis ---------------------------------------
  {
    id: 'og_compressor_vibration',
    templateId: 'vibration_diagnosis',
    industry: 'oil_gas',
    domain: 'Rotating equipment',
    title: 'Compressor vibration diagnosis',
    summary: 'Diagnose a gas-compressor vibration fault from its spectrum.',
    whyItMatters:
      'Compressors are critical, hard-to-replace assets; identifying a bearing or imbalance frequency early turns a trip into a planned repair.',
    stepOverrides: {
      1: { detail: 'Read the spectrum for 1× running-speed (imbalance/misalignment) and bearing defect frequencies plus their harmonics; use the spectrogram to see a peak grow as the fault develops.' },
    },
  },
  {
    id: 'pr_gearbox_vibration',
    templateId: 'vibration_diagnosis',
    industry: 'power_renewables',
    domain: 'Wind',
    title: 'Gearbox bearing frequency',
    summary: 'Pinpoint a gearbox bearing fault from its vibration frequency.',
    whyItMatters:
      'Gearbox repairs are among the costliest wind O&M events; catching the defect frequency early enables a crane-scheduled, planned intervention.',
    stepOverrides: {
      1: { detail: 'Match peaks to gear-mesh and bearing defect frequencies for the running speed; a rising sideband family around gear-mesh often signals developing tooth or bearing wear.' },
    },
  },
  {
    id: 'mf_spindle_vibration',
    templateId: 'vibration_diagnosis',
    industry: 'manufacturing',
    domain: 'CNC machining',
    title: 'Spindle vibration diagnosis',
    summary: 'Diagnose CNC spindle bearing wear from its vibration spectrum.',
    whyItMatters:
      'A spindle bearing fault degrades surface finish and risks a seizure mid-cut; the frequency signature warns before the part is scrapped.',
  },
  {
    id: 'bl_fan_vibration',
    templateId: 'vibration_diagnosis',
    industry: 'buildings',
    domain: 'HVAC',
    title: 'Fan imbalance diagnosis',
    summary: 'Diagnose an AHU or cooling-tower fan imbalance from vibration.',
    whyItMatters:
      'Fan imbalance or a worn bearing wastes energy and risks a failure that takes a zone offline; the spectrum locates it before it worsens.',
    stepOverrides: {
      1: { detail: 'A dominant peak at 1× fan speed points to imbalance; blade-pass-frequency peaks or a rising bearing frequency point to a mechanical fault.' },
    },
  },
  {
    id: 'ma_shaftline_vibration',
    templateId: 'vibration_diagnosis',
    industry: 'marine',
    domain: 'Propulsion',
    title: 'Shaftline vibration diagnosis',
    summary: 'Diagnose propulsion shaftline vibration from its spectrum.',
    whyItMatters:
      'Shaftline vibration from misalignment, a worn bearing, or a fouled propeller stresses the drivetrain; identifying the frequency guides the right repair in port.',
  },
  {
    id: 'mn_crusher_vibration',
    templateId: 'vibration_diagnosis',
    industry: 'mining',
    domain: 'Comminution',
    title: 'Crusher vibration diagnosis',
    summary: 'Diagnose abnormal crusher vibration from its frequency content.',
    whyItMatters:
      'Crusher bearing or eccentric faults can wreck a critical asset; the vibration spectrum distinguishes a developing fault from normal load swings.',
  },

  // --- Operating regime & cycles -------------------------------------------
  {
    id: 'ch_batch_cycle',
    templateId: 'operating_cycle_analysis',
    industry: 'chemicals',
    domain: 'Batch',
    title: 'Batch phase-cycle analysis',
    summary: 'Discover the phase sequence and dwell times of a batch process.',
    whyItMatters:
      'Consistent phase timing is central to batch yield and quality; mining the real sequence reveals over-long holds and abnormal paths that erode both.',
    stepOverrides: {
      0: { detail: 'Inspect the batch signal (temperature or reaction rate) to pick bands that map to charge, heat-up, hold, and cool-down phases.' },
    },
  },
  {
    id: 'mf_machine_cycle',
    templateId: 'operating_cycle_analysis',
    industry: 'manufacturing',
    domain: 'Assembly',
    title: 'Machine cycle-time analysis',
    summary: 'Discover a machine’s real duty cycle and cycle-time states.',
    whyItMatters:
      'Hidden micro-stops and variable cycle times throttle throughput; mining the state sequence quantifies where takt time is actually lost.',
  },
  {
    id: 'wt_pump_dutycycle',
    templateId: 'operating_cycle_analysis',
    industry: 'water',
    domain: 'Pumping',
    title: 'Pump duty-cycle / short-cycling',
    summary: 'Detect pump short-cycling from its start/stop state sequence.',
    whyItMatters:
      'Short-cycling wears pumps and wastes energy; mining the run/stop sequence and dwell times exposes cycling that a level trend hides.',
    stepOverrides: {
      0: { detail: 'Review the pump current or flow to set off / running bands so each start and stop becomes a state change.' },
    },
  },
  {
    id: 'og_compressor_dutycycle',
    templateId: 'operating_cycle_analysis',
    industry: 'oil_gas',
    domain: 'Compression',
    title: 'Compressor load-cycle analysis',
    summary: 'Discover a compressor’s loading/unloading cycle behaviour.',
    whyItMatters:
      'Frequent load/unload or recycle cycling wastes fuel and wears the machine; mining the cycle sequence quantifies the pattern and its dwell times.',
  },
  {
    id: 'ph_bioreactor_cycle',
    templateId: 'operating_cycle_analysis',
    industry: 'pharma',
    domain: 'Bioprocess',
    title: 'Bioreactor stage-cycle analysis',
    summary: 'Discover the stage sequence and dwell times of a bioreactor run.',
    whyItMatters:
      'Stage timing drives batch consistency and CQA outcomes; mining the real sequence flags runs that dwell too long or take an abnormal path.',
  },

  // --- Regime-shift investigation ------------------------------------------
  {
    id: 'og_choke_change',
    templateId: 'regime_shift_investigation',
    industry: 'oil_gas',
    domain: 'Upstream',
    title: 'Production step after choke change',
    summary: 'Pin a production step change to a choke or setpoint change.',
    whyItMatters:
      'Dating the exact rate break and matching it to a choke move separates a deliberate change from an unexpected decline or blockage.',
    stepOverrides: {
      3: { detail: 'Correlate choke position, tubing/casing pressure, and GOR around the break to confirm whether the step was operator-driven or a well problem.' },
    },
  },
  {
    id: 'sm_tool_regime_shift',
    templateId: 'regime_shift_investigation',
    industry: 'semiconductor',
    domain: 'Fab',
    title: 'Tool operating-point shift',
    summary: 'Detect and date a process tool moving to a new operating point.',
    whyItMatters:
      'A tool that settles at a new level silently shifts yield; dating the break and tying it to a PM or recipe change contains the exposed lots.',
  },
  {
    id: 'bl_setpoint_shift',
    templateId: 'regime_shift_investigation',
    industry: 'buildings',
    domain: 'HVAC',
    title: 'BMS setpoint-change impact',
    summary: 'Confirm a level shift after a BMS setpoint or schedule change.',
    whyItMatters:
      'Setpoint and schedule edits can quietly raise energy use; dating the break and correlating related signals checks whether the metric shifted as expected.',
  },
  {
    id: 'pr_output_shift',
    templateId: 'regime_shift_investigation',
    industry: 'power_renewables',
    domain: 'Grid',
    title: 'Output regime shift',
    summary: 'Date a step change in plant output and compare it with candidate causes.',
    whyItMatters:
      'An output step can be curtailment, a trip, or a developing fault; dating the break and correlating related signals helps narrow the candidate explanation.',
  },
  {
    id: 'fb_line_changeover',
    templateId: 'regime_shift_investigation',
    industry: 'food_bev',
    domain: 'Processing',
    title: 'Line changeover shift',
    summary: 'Confirm a process level shift around a product changeover.',
    whyItMatters:
      'A changeover that leaves the line at a new operating point can affect quality or throughput; dating the break confirms whether the transition settled correctly.',
  },

  // --- Cross-industry: business-function playbooks -------------------------

  // Finance & FP&A
  {
    id: 'ci_fin_revenue_forecast',
    templateId: 'kpi_target_forecast',
    industry: 'cross_industry',
    domain: 'Finance & FP&A',
    title: 'Revenue & cash-flow forecast vs plan',
    summary: 'Forecast revenue or cash flow and see whether you are pacing to plan.',
    whyItMatters:
      'Finance lives or dies by the forecast; estimating plan risk mid-period leaves room to review spend or guidance before the close.',
    stepOverrides: {
      0: { title: 'Review the revenue trend', detail: 'Plot revenue or net cash flow by period and note the current run-rate.' },
      2: { title: 'Project to period-end vs plan', detail: 'Forecast to quarter/year-end with plan as the threshold and read the estimated probability of hitting it.' },
    },
  },
  {
    id: 'ci_fin_spend_anomaly',
    templateId: 'kpi_anomaly_diagnosis',
    industry: 'cross_industry',
    domain: 'Finance & FP&A',
    title: 'Spend / expense anomaly',
    summary: 'Investigate an unexpected jump in spend and rank candidate drivers.',
    whyItMatters:
      'An unexplained cost spike is either a data error or a real leak; dating it and ranking cost centers turns a budget surprise into a focused follow-up list.',
    stepOverrides: {
      0: { title: 'Spot the cost spike', detail: 'Plot spend by period and mark the jump that needs explaining.' },
      3: { title: 'Rank the cost drivers', detail: 'Rank cost centers or vendors by how well their movement explains the spike.' },
    },
  },
  {
    id: 'ci_fin_margin_erosion',
    templateId: 'metric_erosion_earlywarning',
    industry: 'cross_industry',
    domain: 'Finance & FP&A',
    title: 'Gross-margin erosion early warning',
    summary: 'Catch a slow slide in gross margin before it dents the quarter.',
    whyItMatters:
      'Margin rarely collapses in one step — it drifts as costs creep and discounts widen; catching the slide early protects profitability while there is still time to price or renegotiate.',
    stepOverrides: {
      0: { title: 'Inspect the margin trend', detail: 'Overlay gross-margin % baseline and recent trend to reveal a slow decline.' },
    },
  },
  {
    id: 'ci_fin_seasonal_cashcost',
    templateId: 'seasonality_planning',
    industry: 'cross_industry',
    domain: 'Finance & FP&A',
    title: 'Seasonal cash & cost patterns',
    summary: 'Map the repeating seasonal patterns in cash and cost to plan the year.',
    whyItMatters:
      'Cash and cost swing predictably with the calendar; making those patterns explicit turns budgeting and liquidity planning from guesswork into a schedule.',
    stepOverrides: {
      1: { title: 'Map cash/cost seasonality', detail: 'Use month-of-year and day-of-week heatmaps to see when cash and costs peak.' },
    },
  },

  // Sales & Revenue
  {
    id: 'ci_sales_pipeline_forecast',
    templateId: 'kpi_target_forecast',
    industry: 'cross_industry',
    domain: 'Sales & Revenue',
    title: 'Pipeline & bookings forecast vs quota',
    summary: 'Forecast bookings and check whether you are pacing to quota.',
    whyItMatters:
      'Knowing early that the quarter may fall short lets sales leadership review deal priorities instead of missing quota with no warning.',
    stepOverrides: {
      0: { title: 'Review the bookings trend', detail: 'Plot bookings or closed-won by period and note the run-rate.' },
      2: { title: 'Project to quota', detail: 'Forecast to period-end with quota as the threshold and read the estimated probability of hitting it.' },
    },
  },
  {
    id: 'ci_sales_drop_investigation',
    templateId: 'kpi_anomaly_diagnosis',
    industry: 'cross_industry',
    domain: 'Sales & Revenue',
    title: 'Sales drop investigation',
    summary: 'Investigate a sudden drop in sales and rank candidate drivers.',
    whyItMatters:
      'A sharp sales decline could be a seasonal blip, a competitor move, or a broken funnel; dating it and ranking drivers helps prioritize what to check next.',
    stepOverrides: {
      0: { title: 'Spot the sales drop', detail: 'Plot sales by period and mark the decline that needs explaining.' },
      3: { title: 'Rank the drivers', detail: 'Rank regions, products, or funnel stages by how well they explain the drop.' },
    },
  },
  {
    id: 'ci_sales_segment_benchmark',
    templateId: 'segment_benchmarking',
    industry: 'cross_industry',
    domain: 'Sales & Revenue',
    title: 'Region / rep / product benchmarking',
    summary: 'Compare sales segments to find leaders and laggards.',
    whyItMatters:
      'Ranking comparable regions, reps, or products surfaces the laggard that needs coaching and the leader whose playbook is worth copying.',
    stepOverrides: {
      0: { title: 'Overlay the segments', detail: 'Compare sales across regions, reps, or products to spot the outlier.' },
    },
  },
  {
    id: 'ci_sales_demand_seasonality',
    templateId: 'seasonality_planning',
    industry: 'cross_industry',
    domain: 'Sales & Revenue',
    title: 'Demand seasonality planning',
    summary: 'Map the repeating demand patterns to plan capacity and promotions.',
    whyItMatters:
      'Demand peaks and troughs on a predictable calendar; making it explicit lets sales and ops staff up, stock up, and time promotions to match.',
    stepOverrides: {
      1: { title: 'Map demand seasonality', detail: 'Use day-of-week and season heatmaps to see when demand peaks and dips.' },
    },
  },

  // Marketing
  {
    id: 'ci_mkt_campaign_impact',
    templateId: 'intervention_impact',
    industry: 'cross_industry',
    domain: 'Marketing',
    title: 'Campaign lift measurement',
    summary: 'Assess whether a campaign coincided with a measurable metric shift.',
    whyItMatters:
      'Checking whether lift appears around the campaign, rather than assuming it caused the change, helps decide whether the spend deserves deeper review.',
    stepOverrides: {
      0: { title: 'Bracket around the launch', detail: 'Zoom to the window spanning before and after the campaign launch.' },
      1: { title: 'Detect the lift', detail: 'Find the most significant break in the metric and classify it as a level or trend change.' },
    },
  },
  {
    id: 'ci_mkt_traffic_anomaly',
    templateId: 'kpi_anomaly_diagnosis',
    industry: 'cross_industry',
    domain: 'Marketing',
    title: 'Traffic / conversion anomaly',
    summary: 'Investigate a sudden move in traffic or conversion rate.',
    whyItMatters:
      'A conversion spike or crash can be a winning creative or a broken landing page; dating it and ranking drivers tells you which fast.',
    stepOverrides: {
      0: { title: 'Spot the move', detail: 'Plot traffic or conversion rate and mark the sudden change.' },
      3: { title: 'Rank the drivers', detail: 'Rank channels, campaigns, or pages by how well they explain the change.' },
    },
  },
  {
    id: 'ci_mkt_channel_drivers',
    templateId: 'kpi_driver_analysis',
    industry: 'cross_industry',
    domain: 'Marketing',
    title: 'Channel spend efficiency drivers',
    summary: 'Find which channels and factors are most associated with conversions or CAC.',
    whyItMatters:
      'Budget decisions benefit from knowing which channels have the strongest association with the outcome before deeper validation.',
    stepOverrides: {
      0: { title: 'Frame the target metric', detail: 'Plot the outcome you want to explain — conversions, CAC, or ROAS.' },
      1: { title: 'Rank channel drivers', detail: 'Regress the outcome on channel spend and mix to rank what explains the most.' },
    },
  },
  {
    id: 'ci_mkt_lead_forecast',
    templateId: 'kpi_target_forecast',
    industry: 'cross_industry',
    domain: 'Marketing',
    title: 'Lead-volume forecast vs target',
    summary: 'Forecast lead volume and check whether you are pacing to target.',
    whyItMatters:
      'If lead flow will fall short of what sales needs, catching it early lets marketing shift budget before the pipeline dries up a quarter later.',
    stepOverrides: {
      0: { title: 'Review the lead trend', detail: 'Plot lead volume by period and note the run-rate.' },
      2: { title: 'Project to the MQL target', detail: 'Forecast to period-end with the lead target as the threshold and read the estimated probability of hitting it.' },
    },
  },

  // HR & People
  {
    id: 'ci_hr_attrition_earlywarning',
    templateId: 'metric_erosion_earlywarning',
    industry: 'cross_industry',
    domain: 'HR & People',
    title: 'Attrition early warning',
    summary: 'Catch a rising attrition trend before it becomes a retention crisis.',
    whyItMatters:
      'Attrition builds quietly before it spikes; spotting the upward drift early gives HR time to review comp, workload, or management signals before key people leave.',
    stepOverrides: {
      0: { title: 'Inspect the attrition trend', detail: 'Overlay the attrition-rate baseline and recent trend to reveal a slow rise.' },
    },
  },
  {
    id: 'ci_hr_headcount_pacing',
    templateId: 'kpi_target_forecast',
    industry: 'cross_industry',
    domain: 'HR & People',
    title: 'Hiring & headcount pacing',
    summary: 'Forecast headcount against plan to see if hiring is on pace.',
    whyItMatters:
      'Hiring that lags plan quietly starves teams; projecting the ramp shows whether recruiting needs to accelerate before the gap hurts delivery.',
    stepOverrides: {
      0: { title: 'Review the headcount trend', detail: 'Plot headcount or net hires by period and note the ramp rate.' },
      2: { title: 'Project to the hiring plan', detail: 'Forecast to period-end with the headcount plan as the threshold and read the estimated probability of hitting it.' },
    },
  },
  {
    id: 'ci_hr_overtime_anomaly',
    templateId: 'kpi_anomaly_diagnosis',
    industry: 'cross_industry',
    domain: 'HR & People',
    title: 'Overtime / absenteeism anomaly',
    summary: 'Investigate a spike in overtime or absenteeism and rank candidate causes.',
    whyItMatters:
      'A sudden rise in overtime or absence often signals burnout or a staffing gap; dating it and ranking teams helps prioritize where to review staffing conditions.',
    stepOverrides: {
      0: { title: 'Spot the spike', detail: 'Plot overtime hours or absence rate and mark the sudden rise.' },
      3: { title: 'Rank the drivers', detail: 'Rank departments or shifts by how well they explain the spike.' },
    },
  },

  // Customer Success
  {
    id: 'ci_cs_churn_earlywarning',
    templateId: 'metric_erosion_earlywarning',
    industry: 'cross_industry',
    domain: 'Customer Success',
    title: 'Churn early warning',
    summary: 'Catch a slow rise in churn before it hits recurring revenue.',
    whyItMatters:
      'Churn compounds quietly; spotting the upward drift early lets CS launch save plays before the revenue base erodes.',
    stepOverrides: {
      0: { title: 'Inspect the churn trend', detail: 'Overlay the churn-rate baseline and recent trend to reveal a slow rise.' },
    },
  },
  {
    id: 'ci_cs_support_forecast',
    templateId: 'kpi_target_forecast',
    industry: 'cross_industry',
    domain: 'Customer Success',
    title: 'Support-volume forecast & staffing',
    summary: 'Forecast ticket volume to staff support ahead of demand.',
    whyItMatters:
      'Understaffed queues blow up SLAs and CSAT; forecasting volume lets support schedule to the wave instead of reacting to it.',
    stepOverrides: {
      0: { title: 'Review the ticket trend', detail: 'Plot support ticket volume by period and note the run-rate.' },
      2: { title: 'Project the volume', detail: 'Forecast ticket volume to plan staffing against the expected load.' },
    },
  },
  {
    id: 'ci_cs_csat_impact',
    templateId: 'intervention_impact',
    industry: 'cross_industry',
    domain: 'Customer Success',
    title: 'CSAT / NPS change impact',
    summary: 'Assess whether a change coincided with a measurable CSAT or NPS shift.',
    whyItMatters:
      'Checking whether satisfaction shifted around a new onboarding flow or policy — rather than assuming causality — helps decide whether the initiative deserves deeper review.',
    stepOverrides: {
      0: { title: 'Bracket around the change', detail: 'Zoom to the window spanning before and after the process or policy change.' },
      1: { title: 'Detect the shift', detail: 'Find the most significant break in CSAT/NPS and classify it.' },
    },
  },
  {
    id: 'ci_cs_support_spike',
    templateId: 'kpi_anomaly_diagnosis',
    industry: 'cross_industry',
    domain: 'Customer Success',
    title: 'Support-spike investigation',
    summary: 'Investigate a sudden surge in tickets and rank candidate triggers.',
    whyItMatters:
      'A ticket surge may trace to a release, outage, or policy change; dating it and ranking drivers helps narrow the trigger before it snowballs.',
    stepOverrides: {
      0: { title: 'Spot the surge', detail: 'Plot ticket volume and mark the sudden spike.' },
      3: { title: 'Rank the drivers', detail: 'Rank products, releases, or issue types by how well they explain the surge.' },
    },
  },

  // Supply Chain & Ops
  {
    id: 'ci_sc_demand_forecast',
    templateId: 'kpi_target_forecast',
    industry: 'cross_industry',
    domain: 'Supply Chain & Ops',
    title: 'Demand forecast for planning',
    summary: 'Forecast demand to drive inventory and capacity planning.',
    whyItMatters:
      'Every stockout and every pile of excess inventory starts with a bad demand number; a seasonally-aware forecast keeps service high and working capital low.',
    stepOverrides: {
      0: { title: 'Review the demand trend', detail: 'Plot units or orders by period and note the run-rate.' },
      2: { title: 'Project demand', detail: 'Forecast demand to drive reorder and capacity decisions.' },
    },
  },
  {
    id: 'ci_sc_leadtime_drift',
    templateId: 'metric_erosion_earlywarning',
    industry: 'cross_industry',
    domain: 'Supply Chain & Ops',
    title: 'Supplier lead-time drift',
    summary: 'Catch supplier lead-times slowly creeping up before they hurt service.',
    whyItMatters:
      'Lead-times drift out long before a supplier misses outright; catching the creep early lets you re-buffer or re-source before a stockout.',
    stepOverrides: {
      0: { title: 'Inspect the lead-time trend', detail: 'Overlay the lead-time baseline and recent trend to reveal a slow increase.' },
    },
  },
  {
    id: 'ci_sc_supplier_benchmark',
    templateId: 'segment_benchmarking',
    industry: 'cross_industry',
    domain: 'Supply Chain & Ops',
    title: 'Supplier / DC benchmarking',
    summary: 'Compare suppliers or distribution centers to find leaders and laggards.',
    whyItMatters:
      'Ranking suppliers or DCs on the same metric surfaces the underperformer to fix and the top performer whose practices to standardize.',
    stepOverrides: {
      0: { title: 'Overlay the segments', detail: 'Compare on-time rate or cost across suppliers or distribution centers.' },
    },
  },

  // Product & Web
  {
    id: 'ci_pw_launch_impact',
    templateId: 'intervention_impact',
    industry: 'cross_industry',
    domain: 'Product & Web',
    title: 'Feature-launch engagement impact',
    summary: 'Measure whether a feature launch moved engagement.',
    whyItMatters:
      'Checking whether engagement shifted around a launch — rather than assuming causality — helps decide whether to double down or roll back.',
    stepOverrides: {
      0: { title: 'Bracket around the launch', detail: 'Zoom to the window spanning before and after the feature release.' },
      1: { title: 'Detect the shift', detail: 'Find the most significant break in the engagement metric and classify it.' },
    },
  },
  {
    id: 'ci_pw_retention_drivers',
    templateId: 'kpi_driver_analysis',
    industry: 'cross_industry',
    domain: 'Product & Web',
    title: 'Activation / retention driver analysis',
    summary: 'Find which behaviors are most associated with activation or retention.',
    whyItMatters:
      'Product roadmaps need evidence before treating behaviors as levers; ranking drivers points follow-up analysis at the strongest associations.',
    stepOverrides: {
      0: { title: 'Frame the target metric', detail: 'Plot the outcome you want to explain — activation or retention rate.' },
      1: { title: 'Rank behavior drivers', detail: 'Regress the outcome on usage behaviors to rank what explains the most.' },
    },
  },
  {
    id: 'ci_pw_usage_anomaly',
    templateId: 'kpi_anomaly_diagnosis',
    industry: 'cross_industry',
    domain: 'Product & Web',
    title: 'Usage / performance anomaly',
    summary: 'Investigate a sudden move in usage or performance metrics.',
    whyItMatters:
      'A drop in usage or a latency spike can be a broken release or a real behavior shift; dating it and ranking drivers helps prioritize what to check first.',
    stepOverrides: {
      0: { title: 'Spot the move', detail: 'Plot the usage or performance metric and mark the sudden change.' },
      3: { title: 'Rank the drivers', detail: 'Rank features, releases, or cohorts by how well they explain the change.' },
    },
  },
];

/**
 * Business functions covered by the Cross-Industry domain, in display order.
 * Used by the Playbooks page to build the "Business function" sub-filter.
 */
export const CROSS_INDUSTRY_FUNCTIONS = [
  'Finance & FP&A',
  'Sales & Revenue',
  'Marketing',
  'HR & People',
  'Customer Success',
  'Supply Chain & Ops',
  'Product & Web',
] as const;

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a domain playbook against its template into a concrete
 * ResolvedPlaybook with industry-specific step text.
 */
export function resolvePlaybook(
  wf: DomainPlaybook,
): ResolvedPlaybook | undefined {
  const template = getTemplate(wf.templateId);
  if (!template) return undefined;

  const steps: ResolvedStep[] = template.steps.map((s, i) => {
    const ov = wf.stepOverrides?.[i];
    return {
      page: s.page,
      title: ov?.title ?? s.title,
      detail: ov?.detail ?? s.detail,
    };
  });

  return {
    id: wf.id,
    templateId: wf.templateId,
    title: wf.title,
    summary: wf.summary,
    whyItMatters: wf.whyItMatters,
    category: template.category,
    industry: wf.industry,
    domain: wf.domain,
    startPage: template.startPage,
    steps,
  };
}

/** Resolve every domain playbook (skips any with an unknown template). */
export function resolveAllPlaybooks(): ResolvedPlaybook[] {
  return DOMAIN_PLAYBOOKS.map((w) => resolvePlaybook(w)).filter(
    (w): w is ResolvedPlaybook => !!w,
  );
}

export function getDomainPlaybook(id: string): DomainPlaybook | undefined {
  return DOMAIN_PLAYBOOKS.find((w) => w.id === id);
}

/** Resolve a single playbook by id. */
export function getPlaybook(id: string): ResolvedPlaybook | undefined {
  const wf = getDomainPlaybook(id);
  return wf ? resolvePlaybook(wf) : undefined;
}

/**
 * Keyword search over a resolved playbook. Case-insensitive substring match
 * across the fields a user is likely to search by: title, summary, why it
 * matters, business domain, category label, and industry label. An empty or
 * whitespace-only query matches everything.
 */
export function playbookMatchesQuery(
  w: ResolvedPlaybook,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const haystack = [
    w.title,
    w.summary,
    w.whyItMatters,
    w.domain,
    CATEGORY_LABELS[w.category],
    industryLabel(w.industry),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

/** Playbooks for a given industry. */
export function playbooksForIndustry(
  industry: IndustryKey,
): ResolvedPlaybook[] {
  return resolveAllPlaybooks().filter((w) => w.industry === industry);
}

/** Count of playbooks per industry (for catalog badges). */
export function playbookCountByIndustry(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of DOMAIN_PLAYBOOKS) out[w.industry] = (out[w.industry] ?? 0) + 1;
  return out;
}

// Re-export template pieces the UI needs from one place.
export {
  TEMPLATES,
  CATEGORY_LABELS,
  getTemplate,
} from './playbookTemplates';
export type {
  TemplateCategory,
  PlaybookTemplate,
} from './playbookTemplates';
