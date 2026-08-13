#!/usr/bin/env python3
"""Generate OperationsIQApp/eventhouse/sample-data/contoso_sample.kql.

Build-time helper (not shipped in the deploy path). Emits a single self-contained
KQL file whose time window is RELATIVE to deploy time (now()-60d .. now()+60d),
with ~30 tags across a deeper plant hierarchy and richer, non-sinusoidal
variability. KQL now() is evaluated when the .set-or-replace runs, so the data
always looks current (2 months of history + 2 months of "arriving" future).
"""
import io
import os

# --- Tag catalog -------------------------------------------------------------
# Each tag: id, name, metric, desc, units, plant, factory, line, station,
# and archetype params. corr group tags share cP1/cP2/cPh so they co-move.
# an*: anomaly slots (kind: '', 'spike', 'ramp'; at = hours from window start;
# dur hours; mag magnitude). Grouped anomalies (same at/dur across tags of a
# station) create multivariate anomalies for the MVAD demo.
#
# columns:
# (tagid, name, metric, desc, units, plant, factory, line, station,
#  base, amp1, p1, amp2, p2, ph2, trend, driftAmp, driftRate, regimeAmp,
#  regimeFrac, noise, cAmp, cP1, cP2, cPh, dropFrac, dropLenH,
#  a1kind, a1at, a1dur, a1mag, a2kind, a2at, a2dur, a2mag)

HORIZON_H = 2880.0  # 120 days

def T(tagid, name, metric, desc, units, plant, factory, line, station, **k):
    d = dict(
        base=50, amp1=5, p1=24.0, amp2=0.0, p2=12.0, ph2=0.0, trend=0.0,
        driftAmp=0.0, driftRate=0.0, regimeAmp=0.0, regimeFrac=0.5, noise=0.5,
        cAmp=0.0, cP1=17.3, cP2=29.1, cPh=0.0, dropFrac=-1.0, dropLenH=0.0,
        a1kind='', a1at=0.0, a1dur=0.0, a1mag=0.0,
        a2kind='', a2at=0.0, a2dur=0.0, a2mag=0.0,
    )
    d.update(k)
    d.update(dict(tagid=tagid, name=name, metric=metric, desc=desc, units=units,
                  plant=plant, factory=factory, line=line, station=station))
    return d

P1, P2 = "Contoso Plant 1", "Contoso Plant 2"

tags = []

# --- Plant 1 / Assembly / Line A / Station 1 (correlated thermal group) ------
# A grouped multivariate anomaly (a2) hits this station's tags together.
mv1_at, mv1_dur = 1560.0, 6.0  # ~5 days after "now" (now()=1440h): upcoming event
tags += [
    T("p1-asm-la-s1-reactor-temp", "Reactor Temperature", "Temperature", "Reactor jacket temperature", "degC",
      P1, "Assembly", "Line A", "Station 1",
      base=72, amp1=6, p1=24, amp2=1.5, p2=8, ph2=0.6, trend=0.0008, noise=0.6,
      cAmp=2.5, cP1=19.7, cP2=31.3, cPh=0.2, driftAmp=1.5, driftRate=0.8,
      a1kind='ramp', a1at=1320.0, a1dur=3.0, a1mag=8.0,
      a2kind='spike', a2at=mv1_at, a2dur=mv1_dur, a2mag=6.0),
    T("p1-asm-la-s1-line-pressure", "Line Pressure", "Pressure", "Main line pressure", "bar",
      P1, "Assembly", "Line A", "Station 1",
      base=4.2, amp1=0.35, p1=12, amp2=0.1, p2=6, ph2=1.1, noise=0.05,
      cAmp=0.12, cP1=19.7, cP2=31.3, cPh=0.2, regimeAmp=0.3, regimeFrac=0.62,
      a2kind='spike', a2at=mv1_at, a2dur=mv1_dur, a2mag=0.5),
    T("p1-asm-la-s1-coolant-flow", "Coolant Flow", "Flow", "Coolant loop flow rate", "L/min",
      P1, "Assembly", "Line A", "Station 1",
      base=130, amp1=10, p1=24, amp2=3, p2=8, ph2=0.3, noise=1.5,
      cAmp=6, cP1=19.7, cP2=31.3, cPh=0.2,
      dropFrac=0.30, dropLenH=4.0,
      a2kind='spike', a2at=mv1_at, a2dur=mv1_dur, a2mag=-25.0),
]

# --- Plant 1 / Assembly / Line A / Station 2 (rotating equipment) ------------
tags += [
    T("p1-asm-la-s2-motor-vibration", "Motor Vibration", "Vibration", "Drive motor vibration RMS", "mm/s",
      P1, "Assembly", "Line A", "Station 2",
      base=2.1, amp1=0.5, p1=8, amp2=0.2, p2=3, ph2=0.9, trend=0.00035, noise=0.15,
      driftAmp=0.8, driftRate=1.4,
      a1kind='ramp', a1at=1180.0, a1dur=3.0, a1mag=7.5),   # bearing wear, before now
    T("p1-asm-la-s2-motor-rpm", "Motor Speed", "Rpm", "Drive motor speed", "rpm",
      P1, "Assembly", "Line A", "Station 2",
      base=1480, amp1=25, p1=24, amp2=8, p2=4, ph2=0.2, noise=6,
      regimeAmp=-60, regimeFrac=0.70),
    T("p1-asm-la-s2-motor-current", "Motor Current", "Current", "Drive motor current", "A",
      P1, "Assembly", "Line A", "Station 2",
      base=44, amp1=3.5, p1=24, amp2=1.2, p2=6, ph2=0.5, noise=0.8,
      cAmp=1.5, cP1=13.1, cP2=23.7, cPh=0.7,
      a1kind='spike', a1at=1620.0, a1dur=0.5, a1mag=18.0),
]

# --- Plant 1 / Assembly / Line B / Station 3 (curing oven) -------------------
tags += [
    T("p1-asm-lb-s3-oven-temp", "Oven Temperature", "Temperature", "Curing oven temperature", "degC",
      P1, "Assembly", "Line B", "Station 3",
      base=180, amp1=12, p1=24, amp2=4, p2=8, ph2=0.4, trend=-0.001, noise=1.2,
      regimeAmp=15, regimeFrac=0.55,
      a1kind='ramp', a1at=2040.0, a1dur=4.0, a1mag=22.0),   # after now
    T("p1-asm-lb-s3-fan-vibration", "Fan Vibration", "Vibration", "Exhaust fan vibration RMS", "mm/s",
      P1, "Assembly", "Line B", "Station 3",
      base=1.8, amp1=0.4, p1=6, amp2=0.15, p2=2, ph2=1.3, noise=0.12,
      a1kind='spike', a1at=1000.0, a1dur=0.3, a1mag=5.0),
    T("p1-asm-lb-s3-humidity", "Oven Humidity", "Humidity", "Curing oven relative humidity", "%RH",
      P1, "Assembly", "Line B", "Station 3",
      base=35, amp1=6, p1=24, amp2=2, p2=12, ph2=0.8, noise=0.9,
      dropFrac=0.66, dropLenH=6.0),
]

# --- Plant 1 / Utilities / Line U / Station U1 (site utilities) --------------
tags += [
    T("p1-utl-lu-s1-chiller-power", "Chiller Power", "Power", "Central chiller power draw", "kW",
      P1, "Utilities", "Line U", "Station U1",
      base=220, amp1=30, p1=24, amp2=10, p2=8, ph2=0.2, trend=0.002, noise=4,
      driftAmp=12, driftRate=1.1, cAmp=8, cP1=21.3, cP2=37.9, cPh=0.4),
    T("p1-utl-lu-s1-header-pressure", "Header Pressure", "Pressure", "Compressed air header pressure", "bar",
      P1, "Utilities", "Line U", "Station U1",
      base=7.0, amp1=0.4, p1=12, amp2=0.15, p2=4, ph2=1.0, noise=0.06,
      regimeAmp=-0.5, regimeFrac=0.48,
      a1kind='spike', a1at=1440.0, a1dur=0.4, a1mag=-1.2),   # right at now
    T("p1-utl-lu-s1-water-flow", "Cooling Water Flow", "Flow", "Cooling tower water flow", "L/min",
      P1, "Utilities", "Line U", "Station U1",
      base=520, amp1=40, p1=24, amp2=12, p2=8, ph2=0.6, noise=6,
      cAmp=18, cP1=21.3, cP2=37.9, cPh=0.4),
    T("p1-utl-lu-s1-tank-level", "Buffer Tank Level", "Level", "Coolant buffer tank level", "%",
      P1, "Utilities", "Line U", "Station U1",
      base=68, amp1=8, p1=48, amp2=3, p2=12, ph2=0.3, trend=-0.0009, noise=0.7,
      driftAmp=-6, driftRate=1.6),
]

# --- Plant 2 / Packaging / Line C / Station 5 (filler, correlated group) -----
mv2_at, mv2_dur = 960.0, 5.0  # ~20 days before now: historical multivariate event
tags += [
    T("p2-pkg-lc-s5-filler-torque", "Filler Torque", "Torque", "Capping head torque", "Nm",
      P2, "Packaging", "Line C", "Station 5",
      base=12, amp1=1.2, p1=8, amp2=0.4, p2=2, ph2=0.7, noise=0.2,
      cAmp=0.8, cP1=15.9, cP2=27.5, cPh=0.9,
      a2kind='ramp', a2at=mv2_at, a2dur=mv2_dur, a2mag=4.0),
    T("p2-pkg-lc-s5-conveyor-rpm", "Conveyor Speed", "Rpm", "Conveyor belt speed", "rpm",
      P2, "Packaging", "Line C", "Station 5",
      base=320, amp1=18, p1=24, amp2=6, p2=4, ph2=0.4, noise=3,
      cAmp=9, cP1=15.9, cP2=27.5, cPh=0.9, regimeAmp=-25, regimeFrac=0.58,
      a2kind='spike', a2at=mv2_at, a2dur=mv2_dur, a2mag=-40.0),
    T("p2-pkg-lc-s5-vacuum-pressure", "Vacuum Pressure", "Pressure", "Filler vacuum pressure", "kPa",
      P2, "Packaging", "Line C", "Station 5",
      base=-45, amp1=3, p1=12, amp2=1, p2=6, ph2=1.2, noise=0.5,
      cAmp=1.5, cP1=15.9, cP2=27.5, cPh=0.9,
      a2kind='ramp', a2at=mv2_at, a2dur=mv2_dur, a2mag=10.0),
]

# --- Plant 2 / Packaging / Line D / Station 6 (labeler) ----------------------
tags += [
    T("p2-pkg-ld-s6-labeler-temp", "Labeler Temperature", "Temperature", "Hot-melt applicator temperature", "degC",
      P2, "Packaging", "Line D", "Station 6",
      base=160, amp1=8, p1=24, amp2=3, p2=8, ph2=0.5, noise=1.1,
      regimeAmp=12, regimeFrac=0.64,
      a1kind='ramp', a1at=1740.0, a1dur=3.0, a1mag=18.0),
    T("p2-pkg-ld-s6-labeler-vibration", "Labeler Vibration", "Vibration", "Labeler head vibration RMS", "mm/s",
      P2, "Packaging", "Line D", "Station 6",
      base=1.5, amp1=0.35, p1=6, amp2=0.12, p2=2, ph2=1.0, trend=0.0003, noise=0.1,
      driftAmp=0.6, driftRate=1.3),
    T("p2-pkg-ld-s6-air-flow", "Air Knife Flow", "Flow", "Drying air-knife flow", "L/min",
      P2, "Packaging", "Line D", "Station 6",
      base=95, amp1=8, p1=24, amp2=2, p2=8, ph2=0.7, noise=1.2,
      dropFrac=0.42, dropLenH=3.0),
]

# --- Plant 2 / QA Lab / Line Q / Station 7 (lab environment, low noise) ------
tags += [
    T("p2-qa-lq-s7-lab-temp", "Lab Temperature", "Temperature", "QA lab ambient temperature", "degC",
      P2, "QA Lab", "Line Q", "Station 7",
      base=21, amp1=0.8, p1=24, amp2=0.2, p2=12, ph2=0.3, noise=0.08),
    T("p2-qa-lq-s7-lab-humidity", "Lab Humidity", "Humidity", "QA lab relative humidity", "%RH",
      P2, "QA Lab", "Line Q", "Station 7",
      base=45, amp1=3, p1=24, amp2=1, p2=12, ph2=0.6, noise=0.3,
      regimeAmp=4, regimeFrac=0.5),
    T("p2-qa-lq-s7-diff-pressure", "Cleanroom dP", "Pressure", "Cleanroom differential pressure", "Pa",
      P2, "QA Lab", "Line Q", "Station 7",
      base=15, amp1=1.5, p1=24, amp2=0.5, p2=8, ph2=0.9, noise=0.4,
      a1kind='spike', a1at=1290.0, a1dur=0.5, a1mag=-8.0),   # door-open event
]

# --- A few standalone process tags to reach ~30 and add variety --------------
tags += [
    T("p1-asm-la-s2-gearbox-temp", "Gearbox Temperature", "Temperature", "Drive gearbox oil temperature", "degC",
      P1, "Assembly", "Line A", "Station 2",
      base=65, amp1=5, p1=24, amp2=1.5, p2=8, ph2=0.5, trend=0.0006, noise=0.7,
      driftAmp=4, driftRate=1.2),
    T("p1-asm-lb-s3-belt-current", "Conveyor Current", "Current", "Line B conveyor motor current", "A",
      P1, "Assembly", "Line B", "Station 3",
      base=18, amp1=2, p1=24, amp2=0.8, p2=4, ph2=0.4, noise=0.5,
      regimeAmp=3, regimeFrac=0.6),
    T("p2-pkg-lc-s5-glue-level", "Adhesive Level", "Level", "Adhesive reservoir level", "%",
      P2, "Packaging", "Line C", "Station 5",
      base=80, amp1=6, p1=72, amp2=2, p2=24, ph2=0.2, trend=-0.0015, noise=0.6,
      driftAmp=-10, driftRate=1.8),
    T("p2-pkg-ld-s6-nip-pressure", "Nip Roller Pressure", "Pressure", "Label nip-roller pressure", "bar",
      P2, "Packaging", "Line D", "Station 6",
      base=3.4, amp1=0.25, p1=12, amp2=0.08, p2=4, ph2=1.1, noise=0.04),
    T("p1-utl-lu-s1-ambient-temp", "Ambient Temperature", "Temperature", "Site ambient temperature", "degC",
      P1, "Utilities", "Line U", "Station U1",
      base=18, amp1=7, p1=24, amp2=2, p2=168, ph2=0.0, noise=0.5,
      cAmp=3, cP1=24.0, cP2=168.0, cPh=0.0),
    T("p2-qa-lq-s7-vibration-ref", "Reference Vibration", "Vibration", "Calibration reference vibration", "mm/s",
      P2, "QA Lab", "Line Q", "Station 7",
      base=0.9, amp1=0.1, p1=24, amp2=0.03, p2=8, ph2=0.5, noise=0.03),
]

assert len(tags) >= 28, len(tags)


def kstr(s):
    return '"' + s.replace('"', '\\"') + '"'


def num(x):
    if isinstance(x, float) and x == int(x):
        return str(int(x)) + ".0"
    return repr(x)


def build():
    out = io.StringIO()
    w = out.write

    w("// ============================================================================\n")
    w("// Operations IQ app - synthetic sample data (Contoso), TIME-RELATIVE.\n")
    w("// ----------------------------------------------------------------------------\n")
    w("// GENERATED by scripts/generate-sample-data.py - do not hand-edit; regenerate.\n")
    w("//\n")
    w("// Deploy AFTER 00_tables.kql. The time window is RELATIVE to deploy time:\n")
    w("// now()-60d .. now()+60d at a 5-minute step, so ~2 months of history plus\n")
    w("// ~2 months of 'arriving' future data across ~%d tags in a multi-plant\n" % len(tags))
    w("// hierarchy. KQL now() is evaluated when these .set-or-replace commands run.\n")
    w("//\n")
    w("// Variability per tag combines: base level, one/two seasonal harmonics, a\n")
    w("// linear trend, an exponential drift, a step 'regime shift', a shared quasi-\n")
    w("// periodic driver (correlated tag groups co-move), Gaussian-ish noise, optional\n")
    w("// sensor dropouts (flatline), and injected spike/ramp anomalies. Several\n")
    w("// station groups share anomaly windows to create multivariate anomalies.\n")
    w("//\n")
    w("// Re-running REPLACES the data (.set-or-replace), so it is safe to redeploy.\n")
    w("// ============================================================================\n\n")

    # Hierarchy
    w("// ---------------------------------------------------------------------------\n")
    w("// Tag hierarchy (Plant > Factory > Line > Station)\n")
    w("// ---------------------------------------------------------------------------\n")
    w(".set-or-replace TagHierarchy <|\n")
    w("    datatable(TagId: string, Plant: string, Factory: string, Line: string, Station: string)\n")
    w("    [\n")
    for t in tags:
        w("        %s, %s, %s, %s, %s,\n" % (
            kstr(t["tagid"]), kstr(t["plant"]), kstr(t["factory"]), kstr(t["line"]), kstr(t["station"])))
    w("    ]\n\n")

    # Metadata
    w("// ---------------------------------------------------------------------------\n")
    w("// Tag metadata\n")
    w("// ---------------------------------------------------------------------------\n")
    w(".set-or-replace TagMetadata <|\n")
    w("    datatable(TagId: string, TagName: string, Metric: string, Description: string, EngUnits: string)\n")
    w("    [\n")
    for t in tags:
        w("        %s, %s, %s, %s, %s,\n" % (
            kstr(t["tagid"]), kstr(t["name"]), kstr(t["metric"]), kstr(t["desc"]), kstr(t["units"])))
    w("    ]\n\n")

    # Events (relative to now)
    w("// ---------------------------------------------------------------------------\n")
    w("// Time-marker events (maintenance / incidents / notes), relative to now().\n")
    w("// Aligned with injected anomalies so the overlays line up on the charts.\n")
    w("// ---------------------------------------------------------------------------\n")
    w(".set-or-replace Events <|\n")
    w("    let _now = now();\n")
    w("    datatable(EventId: string, ScopeType: string, ScopeId: string, OffsetStartH: real, OffsetEndH: real, EventType: string, Title: string, Detail: string)\n")
    w("    [\n")
    events = [
        ("EV-001", "TagId", "p1-asm-la-s2-motor-vibration", -260.0, -256.0, "Maintenance", "Bearing wear watch", "Rising drive-motor vibration flagged for inspection."),
        ("EV-002", "TagId", "p1-asm-la-s1-reactor-temp", -120.0, -117.0, "Incident", "Reactor temperature excursion", "Brief reactor temperature ramp during a control loop retune."),
        ("EV-003", "Level4", "Contoso Plant 2/Packaging/Line C/Station 5", -480.0, -475.0, "Incident", "Filler multivariate upset", "Torque up, conveyor slow, vacuum drift together on the filler."),
        ("EV-004", "Level4", "Contoso Plant 1/Assembly/Line A/Station 1", 120.0, 126.0, "Maintenance", "Planned coolant service", "Scheduled coolant loop service; expect correlated deviations."),
        ("EV-005", "Level1", "Contoso Plant 1", -720.0, 0.0, "Note", "Monthly review window", "Rolling 30-day operations review period."),
        ("EV-006", "TagId", "p2-qa-lq-s7-diff-pressure", -150.0, -149.5, "Note", "Cleanroom door event", "Momentary cleanroom differential-pressure dip."),
    ]
    for e in events:
        eid, st, sid, os_, oe, et, ti, de = e
        w("        %s, %s, %s, %s, %s, %s, %s, %s,\n" % (
            kstr(eid), kstr(st), kstr(sid), num(os_), (num(oe) if oe is not None else "real(null)"),
            kstr(et), kstr(ti), kstr(de)))
    w("    ]\n")
    w("    | extend Timestamp = _now + 1h * OffsetStartH\n")
    w("    | extend EndTimestamp = iff(isnull(OffsetEndH), datetime(null), _now + 1h * OffsetEndH)\n")
    w("    | project EventId, ScopeType, ScopeId, Timestamp, EndTimestamp, EventType, Title, Detail\n\n")

    # Timeseries
    w("// ---------------------------------------------------------------------------\n")
    w("// Synthetic signals. Window: now()-60d .. now()+60d, 5-minute step.\n")
    w("// ---------------------------------------------------------------------------\n")
    w(".set-or-replace Timeseries <|\n")
    w("    let _start = startofday(now()) - 60d;\n")
    w("    let _end = startofday(now()) + 60d;\n")
    w("    let _step = 5m;\n")
    w("    let _n = tolong((_end - _start) / _step);\n")
    w("    let _horizon = %s;\n" % num(HORIZON_H))
    w("    let tags = datatable(\n")
    w("        TagId: string, base: real, amp1: real, p1: real, amp2: real, p2: real, ph2: real,\n")
    w("        trend: real, driftAmp: real, driftRate: real, regimeAmp: real, regimeFrac: real,\n")
    w("        noise: real, cAmp: real, cP1: real, cP2: real, cPh: real, dropFrac: real, dropLenH: real,\n")
    w("        a1kind: string, a1at: real, a1dur: real, a1mag: real,\n")
    w("        a2kind: string, a2at: real, a2dur: real, a2mag: real)\n")
    w("    [\n")
    for t in tags:
        row = [
            kstr(t["tagid"]), num(t["base"]), num(t["amp1"]), num(t["p1"]), num(t["amp2"]),
            num(t["p2"]), num(t["ph2"]), num(t["trend"]), num(t["driftAmp"]), num(t["driftRate"]),
            num(t["regimeAmp"]), num(t["regimeFrac"]), num(t["noise"]), num(t["cAmp"]),
            num(t["cP1"]), num(t["cP2"]), num(t["cPh"]), num(t["dropFrac"]), num(t["dropLenH"]),
            kstr(t["a1kind"]), num(t["a1at"]), num(t["a1dur"]), num(t["a1mag"]),
            kstr(t["a2kind"]), num(t["a2at"]), num(t["a2dur"]), num(t["a2mag"]),
        ]
        w("        " + ", ".join(row) + ",\n")
    w("    ];\n")
    w("    tags\n")
    w("    | extend i = range(0, _n - 1, 1)\n")
    w("    | mv-expand i to typeof(long)\n")
    w("    | extend Timestamp = _start + _step * i\n")
    w("    | extend h = (_step * i) / 1h\n")
    w("    | extend seasonal = amp1 * sin(2 * pi() * h / p1) + amp2 * sin(2 * pi() * h / p2 + ph2)\n")
    w("    | extend trendc = trend * h\n")
    w("    | extend driftc = driftAmp * (exp(driftRate * h / _horizon) - 1.0)\n")
    w("    | extend regimec = regimeAmp * iff(h >= regimeFrac * _horizon, 1.0, 0.0)\n")
    w("    | extend driverc = cAmp * sin(2 * pi() * h / cP1) * cos(2 * pi() * h / cP2 + cPh)\n")
    w("    | extend noisec = noise * (rand() - 0.5) * 2.0\n")
    w("    | extend raw = base + seasonal + trendc + driftc + regimec + driverc + noisec\n")
    # anomaly slot 1
    w("    | extend _t1 = _start + 1h * a1at\n")
    w("    | extend anom1 = case(\n")
    w("        a1kind == 'spike', iff(Timestamp between (_t1 .. _t1 + 1h * a1dur), a1mag, 0.0),\n")
    w("        a1kind == 'ramp',  iff(Timestamp between (_t1 .. _t1 + 1h * a1dur), a1mag * exp(-abs((Timestamp - (_t1 + 1h * a1dur * 0.5)) / 1h)), 0.0),\n")
    w("        0.0)\n")
    # anomaly slot 2 (grouped -> multivariate)
    w("    | extend _t2 = _start + 1h * a2at\n")
    w("    | extend anom2 = case(\n")
    w("        a2kind == 'spike', iff(Timestamp between (_t2 .. _t2 + 1h * a2dur), a2mag, 0.0),\n")
    w("        a2kind == 'ramp',  iff(Timestamp between (_t2 .. _t2 + 1h * a2dur), a2mag * exp(-abs((Timestamp - (_t2 + 1h * a2dur * 0.5)) / 1h)), 0.0),\n")
    w("        0.0)\n")
    # dropout / flatline
    w("    | extend _dropStart = _start + 1h * dropFrac * _horizon\n")
    w("    | extend _inDrop = dropFrac >= 0.0 and Timestamp between (_dropStart .. _dropStart + 1h * dropLenH)\n")
    w("    | extend Value = iff(_inDrop, base, raw + anom1 + anom2)\n")
    w("    | project TagId, Timestamp, Value\n")

    return out.getvalue()


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(here)  # OperationsIQApp/
    dest = os.path.join(repo, "eventhouse", "sample-data", "contoso_sample.kql")
    content = build()
    with open(dest, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)
    print("Wrote %s (%d tags, %d bytes)" % (dest, len(tags), len(content)))


if __name__ == "__main__":
    main()
