"""
app.py - Baghdad digital twin dashboard (Jadriyah vs Karrada)

Run:  streamlit run app.py        (Windows: double-click run_app.bat)
Needs: data/ and twin_map/ next to this file (twin_map/data is built by build_twin_data.py).

Real data  : buildings, land surface temperature (LST), NDVI, population, land cover, imagery
Simulated  : air temperature, traffic, electricity, NO2 (see ASSUMPTIONS in simulate.py)

The 3D twin (twin_map/) is a custom Streamlit component: it loads its map data once, then
only the scenario (an average day per zone) is sent on every slider change, so the map
updates instantly without reloading.
"""
from pathlib import Path

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st
import streamlit.components.v1 as components

import simulate as sim

HERE = Path(__file__).parent
DATA_DIR = HERE / "data"
TWIN_DIR = HERE / "twin_map"
DISTRICTS = {"jadriyah": "Al-Jadriyah", "karrada": "Al-Karrada"}
COLORS = {"jadriyah": "#2ad4a5", "karrada": "#ff7a59"}   # one colour per district
PRESETS = {                                               # name -> (traffic x, heatwave +C)
    "Normal day": (1.0, 0.0),
    "Rush-hour surge": (1.6, 0.0),
    "Heatwave": (1.0, 5.0),
    "Heatwave + gridlock": (1.8, 6.0),
    "Car-free day": (0.5, 0.0),
}
# label, column in district_summary, unit, format, scale
KPIS = [
    ("Peak air temperature", "peak_temp_c", "°C", "{:.1f}", 1),
    ("Mean traffic index", "mean_traffic", "", "{:.2f}", 1),
    ("Electricity per month", "total_electricity_mwh", "GWh", "{:.1f}", 1 / 1000),
    ("Mean NO₂ (air quality)", "mean_no2", "µg/m³", "{:.1f}", 1),
]
# chart: column in the time series, title, unit, how to combine zones
SERIES = [
    ("traffic_index", "Traffic", "index (0-1.5)", "mean"),
    ("temp_c", "Air temperature", "°C", "mean"),
    ("electricity_kwh", "Electricity (whole district)", "kWh per hour", "sum"),
    ("no2_ugm3", "NO₂ air pollution", "µg/m³", "mean"),
]

twin_map = components.declare_component("twin_map", path=str(TWIN_DIR))

CSS = """
<style>
  .block-container { padding-top: 1.4rem; max-width: 1500px; }
  [data-testid="stSidebar"] { background: linear-gradient(180deg, #0b1424 0%, #070b14 100%); }
  .hero { padding: 18px 22px; border-radius: 18px; margin-bottom: 14px;
    background: radial-gradient(circle at 12% 20%, rgba(61,214,255,.18), transparent 45%),
                radial-gradient(circle at 88% 0%, rgba(124,92,255,.22), transparent 50%), #0c1424;
    border: 1px solid rgba(120,200,255,.16); }
  .hero h1 { font-size: 30px; margin: 0; line-height: 1.15;
    background: linear-gradient(90deg, #e6f1ff, #7fe8ff 55%, #b6a4ff); -webkit-background-clip: text; color: transparent; }
  .hero p { color: #8ca3bf; margin: 6px 0 10px; font-size: 14px; }
  .pill { display: inline-block; padding: 4px 11px; border-radius: 20px; font-size: 12px; margin-right: 6px;
    background: rgba(255,255,255,.06); border: 1px solid rgba(120,200,255,.18); color: #cfe6ff; }
  .pill.hot { border-color: rgba(255,120,80,.55); color: #ffd0bd; background: rgba(255,90,60,.1); }
  .pill.real { border-color: rgba(42,212,165,.45); }
  .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 6px 0 16px; }
  @media (max-width: 1100px) { .kpi-grid { grid-template-columns: repeat(2, 1fr); } }
  .kpi { background: linear-gradient(160deg, rgba(255,255,255,.05), rgba(255,255,255,.015));
    border: 1px solid rgba(120,200,255,.14); border-radius: 14px; padding: 12px 14px; }
  .kpi-label { color: #8ca3bf; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .kpi-row { display: flex; align-items: baseline; gap: 8px; margin: 3px 0; }
  .kpi-row .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; transform: translateY(-1px); }
  .kpi-name { color: #cfe6ff; font-size: 12.5px; flex: 1; }
  .kpi-val { font-size: 20px; font-weight: 700; color: #fff; font-variant-numeric: tabular-nums; }
  .kpi-val small { font-size: 11px; color: #8ca3bf; font-weight: 400; }
  .kpi-delta { font-size: 11.5px; min-width: 64px; text-align: right; font-variant-numeric: tabular-nums; }
  .kpi-delta.up { color: #ff7a6b; } .kpi-delta.down { color: #3ee0a5; } .kpi-delta.flat { color: #6b7f99; }
  .section-note { color: #8ca3bf; font-size: 13px; margin: -4px 0 10px; }
  .tbl { width: 100%; border-collapse: collapse; font-size: 13px; margin: 4px 0 8px; }
  .tbl th { text-align: right; color: #8ca3bf; font-weight: 500; font-size: 11.5px; padding: 7px 10px;
    border-bottom: 1px solid rgba(120,200,255,.2); }
  .tbl td { text-align: right; padding: 7px 10px; border-bottom: 1px solid rgba(255,255,255,.05);
    font-variant-numeric: tabular-nums; color: #e6f1ff; }
  .tbl td.rowh { text-align: left; color: #cfe6ff; }
  .tbl tr:hover td { background: rgba(61,214,255,.05); }
  div[data-baseweb="tab-list"] { gap: 6px; }
  button[data-baseweb="tab"] { background: rgba(255,255,255,.03); border-radius: 10px 10px 0 0; padding: 8px 16px; }
</style>
"""


# ------------------------------------------------------------------ data and simulation
@st.cache_data
def get_zones():
    return sim.build_zones(data_dir=str(DATA_DIR))


@st.cache_data
def run_sim(traffic_mult, heat_delta):
    return sim.simulate(get_zones(), traffic_mult=traffic_mult, heat_delta=heat_delta)


@st.cache_data
def day_profiles(traffic_mult, heat_delta):
    """Average day per zone: this is all the 3D map needs to show a scenario."""
    return sim.zone_day_profiles(run_sim(traffic_mult, heat_delta), get_zones())


def hourly(ts, col, how="mean"):
    """Average day: one value per district and hour. Electricity is first summed over zones."""
    if how == "sum":
        ts = ts.groupby(["district", "timestamp"], as_index=False)[col].sum()
    return (ts.assign(hour=pd.to_datetime(ts["timestamp"]).dt.hour)
              .groupby(["district", "hour"], as_index=False)[col].mean())


# ------------------------------------------------------------------ charts
def style(fig, height=300, **kw):
    fig.update_layout(template="plotly_dark", height=height, margin=dict(l=8, r=8, t=36, b=8),
                      paper_bgcolor="rgba(0,0,0,0)", plot_bgcolor="rgba(255,255,255,0.02)",
                      font=dict(family="Inter, system-ui, sans-serif", size=12, color="#cfe6ff"),
                      legend=dict(orientation="h", y=-0.22, x=0, font=dict(size=11)), **kw)
    fig.update_xaxes(gridcolor="rgba(255,255,255,0.06)", zeroline=False)
    fig.update_yaxes(gridcolor="rgba(255,255,255,0.06)", zeroline=False)
    return fig


def scenario_chart(base, ts, col, title, unit, how):
    """Baseline (dashed) and scenario (solid) for both districts on a fixed axis, so a
    scenario change shows up as a visible gap instead of being hidden by auto-rescaling."""
    b, s = hourly(base, col, how), hourly(ts, col, how)
    fig = go.Figure()
    for d, name in DISTRICTS.items():
        bd, sd = b[b["district"] == d], s[s["district"] == d]
        fig.add_scatter(x=bd["hour"], y=bd[col], name=f"{name} baseline", mode="lines",
                        line=dict(color=COLORS[d], width=1.5, dash="dot"), opacity=0.55)
        fig.add_scatter(x=sd["hour"], y=sd[col], name=f"{name} scenario", mode="lines",
                        line=dict(color=COLORS[d], width=3), fill="tonexty",
                        fillcolor=f"rgba({int(COLORS[d][1:3], 16)},{int(COLORS[d][3:5], 16)},{int(COLORS[d][5:7], 16)},0.12)")
    lo = min(b[col].min(), s[col].min())
    hi = max(b[col].max(), s[col].max())
    pad = (hi - lo) * 0.08 or 1
    style(fig, title=dict(text=f"<b>{title}</b> <span style='color:#8ca3bf;font-size:12px'>{unit}</span>", x=0, font=dict(size=14)))
    fig.update_xaxes(title=None, tickvals=[0, 3, 6, 9, 12, 15, 18, 21], ticktext=["00", "03", "06", "09", "12", "15", "18", "21"])
    fig.update_yaxes(range=[lo - pad, hi + pad])
    return fig


def change_chart(s_base, s):
    """Percent change of every indicator versus the baseline (red = worse)."""
    rows = []
    for label, col, _, _, _ in KPIS:
        for d, name in DISTRICTS.items():
            b = s_base.loc[d, col]
            rows.append((label, name, (s.loc[d, col] - b) / b * 100 if b else 0.0))
    df = pd.DataFrame(rows, columns=["metric", "district", "pct"])
    fig = go.Figure()
    for d, name in DISTRICTS.items():
        dd = df[df["district"] == name]
        fig.add_bar(y=dd["metric"], x=dd["pct"], orientation="h", name=name, marker_color=COLORS[d],
                    text=[f"{v:+.1f}%" for v in dd["pct"]], textposition="outside")
    lim = max(5.0, df["pct"].abs().max() * 1.55)   # room for the labels outside the bars
    style(fig, height=300, barmode="group", title=dict(text="<b>What changed vs the baseline</b>", x=0, font=dict(size=14)))
    fig.update_xaxes(range=[-lim, lim], ticksuffix="%", zeroline=True, zerolinecolor="rgba(255,255,255,0.3)")
    fig.update_yaxes(autorange="reversed")
    return fig


def heat_surface(ts, zones, district):
    """3D landscape of the average day: hour x zone (densest zone first) x air temperature."""
    z = zones[zones["district"] == district].sort_values("density", ascending=False)
    day = (ts[ts["district"] == district].assign(hour=pd.to_datetime(ts["timestamp"]).dt.hour)
             .groupby(["zone_id", "hour"])["temp_c"].mean().unstack())
    mat = day.reindex(z["zone_id"]).values
    fig = go.Figure(go.Surface(z=mat, x=list(range(24)), y=list(range(len(z))), colorscale=[
        [0, "#313695"], [0.25, "#74add1"], [0.5, "#fee090"], [0.75, "#f46d43"], [1, "#a50026"]],
        cmin=28, cmax=56, colorbar=dict(title="°C", thickness=12, len=0.7),
        contours=dict(z=dict(show=True, usecolormap=True, project=dict(z=True), width=1))))
    style(fig, height=430, title=dict(text=f"<b>Heat landscape, {DISTRICTS[district]}</b> "
                                           "<span style='color:#8ca3bf;font-size:12px'>average day, every 250 m zone</span>",
                                      x=0, font=dict(size=14)))
    fig.update_layout(scene=dict(
        xaxis=dict(title="hour", backgroundcolor="rgba(0,0,0,0)", gridcolor="rgba(255,255,255,0.1)"),
        yaxis=dict(title="zone (densest first)", backgroundcolor="rgba(0,0,0,0)", gridcolor="rgba(255,255,255,0.1)"),
        zaxis=dict(title="°C", range=[26, 58], backgroundcolor="rgba(0,0,0,0)", gridcolor="rgba(255,255,255,0.1)"),
        camera=dict(eye=dict(x=1.6, y=-1.5, z=0.9)), aspectratio=dict(x=1.4, y=1, z=0.6)))
    return fig


def real_indicators(zones):
    return zones.groupby("district").apply(lambda z: pd.Series({
        "Buildings": z["n_buildings"].sum(),
        "Population (est.)": z["population_est"].sum(),
        "Mean height (m)": np.average(z["mean_height_m"], weights=z["n_buildings"]),
        "Built-up share of area": z["footprint_m2"].sum() / (len(z) * sim.CELL_M ** 2),
        "Mean NDVI": np.average(z["ndvi"], weights=z["n_buildings"]),
        "Mean land surface temp (°C)": np.average(z["lst_c"], weights=z["n_buildings"]),
    })).rename(index=DISTRICTS)


def radar(real, s):
    """Both districts on one radar, every axis scaled to the larger district = 1."""
    axes = {
        "Built-up share": real["Built-up share of area"],
        "Population": real["Population (est.)"],
        "Surface temp": real["Mean land surface temp (°C)"] - 40,
        "Greenery (NDVI)": real["Mean NDVI"],
        "Traffic": s["mean_traffic"].rename(index=DISTRICTS),
        "NO₂": s["mean_no2"].rename(index=DISTRICTS),
        "Electricity": s["total_electricity_mwh"].rename(index=DISTRICTS),
    }
    fig = go.Figure()
    for d, name in DISTRICTS.items():
        vals = [float(v[name] / v.max()) if v.max() else 0 for v in axes.values()]
        fig.add_scatterpolar(r=vals + vals[:1], theta=list(axes) + list(axes)[:1], name=name, fill="toself",
                             line=dict(color=COLORS[d], width=2), opacity=0.85)
    style(fig, height=380, title=dict(text="<b>District fingerprint</b> <span style='color:#8ca3bf;font-size:12px'>"
                                            "each axis relative to the higher district</span>", x=0, font=dict(size=14)))
    fig.update_layout(polar=dict(bgcolor="rgba(255,255,255,0.02)", radialaxis=dict(range=[0, 1.05], showticklabels=False,
                                 gridcolor="rgba(255,255,255,0.1)"), angularaxis=dict(gridcolor="rgba(255,255,255,0.1)")))
    return fig


# ------------------------------------------------------------------ page pieces
def html_table(df, digits=2):
    """Plain HTML table: always renders (Streamlit's canvas grid can stay blank on some GPUs)
    and matches the dark design."""
    def cell(v):
        if isinstance(v, (int, np.integer)) or (isinstance(v, (float, np.floating)) and abs(v) >= 1000):
            return f"{v:,.0f}"
        if isinstance(v, (float, np.floating)):
            return f"{v:,.{digits}f}"
        return str(v)
    head = "".join(f"<th>{c}</th>" for c in df.columns)
    body = "".join(f"<tr><td class='rowh'>{i}</td>{''.join(f'<td>{cell(v)}</td>' for v in row)}</tr>"
                   for i, row in zip(df.index, df.values))
    st.markdown(f"<table class='tbl'><thead><tr><th></th>{head}</tr></thead><tbody>{body}</tbody></table>",
                unsafe_allow_html=True)


def kpi_cards(s_base, s):
    cards = []
    for label, col, unit, fmt, k in KPIS:
        rows = ""
        for d, name in DISTRICTS.items():
            name = name.removeprefix("Al-")   # short names keep each card row on one line
            v, b = s.loc[d, col] * k, s_base.loc[d, col] * k
            pct = (v - b) / b * 100 if b else 0.0
            cls = "up" if pct > 0.05 else "down" if pct < -0.05 else "flat"
            arrow = {"up": "▲", "down": "▼", "flat": "●"}[cls]
            rows += (f"<div class='kpi-row'><span class='dot' style='background:{COLORS[d]}'></span>"
                     f"<span class='kpi-name'>{name}</span><span class='kpi-val'>{fmt.format(v)}<small> {unit}</small></span>"
                     f"<span class='kpi-delta {cls}'>{arrow} {pct:+.1f}%</span></div>")
        cards.append(f"<div class='kpi'><div class='kpi-label'>{label}</div>{rows}</div>")
    st.markdown(f"<div class='kpi-grid'>{''.join(cards)}</div>", unsafe_allow_html=True)


def apply_preset():
    name = st.session_state.get("preset")
    if name in PRESETS:
        st.session_state["traffic"], st.session_state["heat"] = PRESETS[name]


def main():
    st.set_page_config(page_title="Baghdad Digital Twin", page_icon="🏙️", layout="wide", initial_sidebar_state="expanded")
    st.markdown(CSS, unsafe_allow_html=True)
    st.session_state.setdefault("traffic", 1.0)
    st.session_state.setdefault("heat", 0.0)

    with st.sidebar:
        st.markdown("### 🎛️ Scenario")
        st.pills("Presets", list(PRESETS), key="preset", on_change=apply_preset, label_visibility="collapsed")
        traffic_mult = st.slider("🚗 Traffic", 0.5, 2.0, step=0.1, key="traffic",
                                 help="1.2 means +20% traffic. Also adds vehicle heat and NO₂.")
        heat_delta = st.slider("🌡️ Heatwave (+°C)", 0.0, 8.0, step=0.5, key="heat",
                               help="Added to the air temperature every hour. Raises cooling electricity and NO₂.")
        st.caption("Every change updates the 3D twin, the cards and the charts. Baseline = traffic ×1.0, no heatwave.")
        st.divider()
        st.markdown("**In the 3D twin**")
        st.caption("Click a building to fly to it · drag to rotate · ▶ plays the day · switch Satellite / Land cover / Dark "
                   "at the top right. Quality is set automatically for your computer.")

    if not (TWIN_DIR / "data" / "buildings.json").exists():
        st.error("3D map data not found. Run `python build_twin_data.py` once (it reads data/ and writes twin_map/data).")
        st.stop()

    zones = get_zones()
    base, ts = run_sim(1.0, 0.0), run_sim(traffic_mult, heat_delta)
    s_base, s = sim.district_summary(base), sim.district_summary(ts)

    hot_t = "hot" if traffic_mult != 1.0 else ""
    hot_h = "hot" if heat_delta > 0 else ""
    st.markdown(
        "<div class='hero'><h1>Baghdad Digital Twin · Al-Jadriyah vs Al-Karrada</h1>"
        "<p>Real city form (buildings, satellite land surface temperature, vegetation, population, land cover) "
        "driving a simulated July day of traffic, heat, electricity and air quality.</p>"
        f"<span class='pill {hot_t}'>🚗 Traffic ×{traffic_mult:.1f}</span>"
        f"<span class='pill {hot_h}'>🌡️ Heatwave +{heat_delta:.1f} °C</span>"
        f"<span class='pill real'>🛰️ {int(zones['n_buildings'].sum()):,} analysed buildings · {len(zones)} zones</span></div>",
        unsafe_allow_html=True)
    kpi_cards(s_base, s)

    tab_twin, tab_scen, tab_cmp, tab_about = st.tabs(["🌐 3D digital twin", "📈 Scenario analysis", "🏙️ District comparison", "📋 Assumptions"])

    with tab_twin:
        twin_map(profiles=day_profiles(traffic_mult, heat_delta), baseline=day_profiles(1.0, 0.0),
                 scenario={"traffic_mult": traffic_mult, "heat_delta": heat_delta}, height=760, key="twin", default=None)

    with tab_scen:
        st.markdown("<div class='section-note'>Dotted lines are the baseline, solid lines your scenario; "
                    "the shaded gap is the change. Axes stay fixed so the change is visible.</div>", unsafe_allow_html=True)
        c1, c2 = st.columns(2)
        for i, (col, title, unit, how) in enumerate(SERIES):
            (c1 if i % 2 == 0 else c2).plotly_chart(scenario_chart(base, ts, col, title, unit, how), width="stretch")
        c3, c4 = st.columns([1, 1.25])
        c3.plotly_chart(change_chart(s_base, s), width="stretch")
        with c4:
            district = st.radio("Heat landscape for", list(DISTRICTS), format_func=DISTRICTS.get, horizontal=True,
                                label_visibility="collapsed")
            st.plotly_chart(heat_surface(ts, zones, district), width="stretch")

    with tab_cmp:
        real = real_indicators(zones)
        c1, c2 = st.columns([1.1, 1])
        c1.plotly_chart(radar(real, s), width="stretch")
        with c2:
            st.markdown("**Real indicators** (satellite and OSM data)")
            html_table(real.T)
            st.caption(f"Totals cover grid zones with at least {sim.MIN_BUILDINGS} buildings, "
                       "so they are slightly below the raw file totals.")
            st.markdown("**Simulated results** (this scenario)")
            show = s.rename(index=DISTRICTS).T
            show.index = ["Mean air temp (°C)", "Peak air temp (°C)", "Mean traffic index", "Peak traffic index",
                          "Electricity (MWh/month)", "Mean NO₂ (µg/m³)", "Peak NO₂ (µg/m³)"]
            html_table(show)

    with tab_about:
        st.markdown("**Simulated indicators.** Traffic, electricity and NO₂ are not measured; they are generated from "
                    "real building density, floor area, vegetation and hour of day. All parameters:")
        html_table(pd.DataFrame(sim.ASSUMPTIONS).rename(columns=DISTRICTS), digits=3)
        st.markdown(
            "- **Linked effects:** more traffic adds vehicle heat (`traffic_heat_c` °C at traffic index 1.0) and NO₂; "
            "hotter air raises cooling electricity (+6% per °C above 26 °C) and NO₂ (`no2_heat_per_c`).\n"
            f"- Zones are {sim.CELL_M} m grid cells; zones with fewer than {sim.MIN_BUILDINGS} buildings are dropped.\n"
            f"- Missing or zero building heights use {sim.HEIGHT_DEFAULT_M:.0f} m; heights above "
            f"{sim.HEIGHT_CAP_M:.0f} m are capped in the simulation. The ~170 m values in the Jadriyah file are 81 tiny "
            "facade-fin shapes of the CBI Tower (under 5 m²); the 3D map leaves them out and keeps the tower itself.\n"
            "- Land surface temperature (satellite) is shown separately from simulated air temperature; they are different quantities.\n"
            "- The two districts are adjacent, so weather is shared; differences come from urban form and land use.\n"
            f"- Simulated period: {sim.START}, {sim.DAYS} days, hourly. Random seed {sim.RNG_SEED}.")
        st.markdown(
            "**3D twin data.** Buildings: OpenStreetMap plus Microsoft satellite footprints (via Overture Maps) where "
            "OSM has none; those, and the area between the districts, have no LST/NDVI/population and take simulated "
            "values from the nearest zone. Roads, green areas, water and trees: OpenStreetMap (trees inside mapped "
            "woods and orchards are placed at typical spacing). Ground colours: ESA WorldCover 2021 (10 m). "
            "Satellite imagery and roof colours: Esri World Imagery, loaded live (needs internet).")


if __name__ == "__main__":
    main()
