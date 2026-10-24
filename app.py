"""
app.py - Baghdad digital twin dashboard (Jadriyah vs Karrada)

Run:  streamlit run app.py
Needs: data/ folder (see note.md) and simulate.py in the same folder as this file.

Real data  : building height/area, land surface temperature (LST), NDVI, population
Simulated  : air temperature, traffic, electricity (see ASSUMPTIONS in simulate.py)
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
import plotly.express as px
import pydeck as pdk
import streamlit as st

import simulate as sim

DATA_DIR = Path(__file__).parent / "data"
DISTRICTS = {"jadriyah": "Al-Jadriyah", "karrada": "Al-Karrada"}
COLORS = {"jadriyah": "#2a9d8f", "karrada": "#e76f51"}   # one colour per district

# metric label -> (column in building file, colour stops low->high, unit)
METRICS = {
    "Land surface temperature (real)": ("temp_c", [(60, 90, 200), (250, 220, 90), (200, 40, 40)], "°C"),
    "Vegetation, NDVI (real)":         ("ndvi", [(190, 150, 90), (200, 220, 120), (30, 130, 60)], ""),
    "Population estimate (real)":      ("population_est", [(240, 240, 240), (240, 160, 90), (120, 20, 60)], "people"),
    "Building height (real)":          ("height_m", [(220, 230, 240), (110, 150, 200), (30, 50, 120)], "m"),
}


# ------------------------------------------------------------------ helpers
def ramp(t, stops):
    """Linear colour interpolation, t in 0..1 -> [r, g, b]."""
    t = float(np.clip(t, 0, 1)) * (len(stops) - 1)
    i = min(int(t), len(stops) - 2)
    f = t - i
    return [int(round(stops[i][k] + (stops[i + 1][k] - stops[i][k]) * f)) for k in range(3)]


def clean_height(h):
    """Same cleaning rules as simulate.py so the 3D view matches the simulation."""
    h = h if h and h > 0 else sim.HEIGHT_DEFAULT_M
    return min(h, sim.HEIGHT_CAP_M) if sim.HEIGHT_CAP_M else h


@st.cache_data
def load_geojson(district, kind):
    path = DATA_DIR / f"{district}_{kind}.geojson"
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@st.cache_data
def colour_buildings(metric_label):
    """Colour every building by the chosen metric. The colour scale is shared by
    both districts (5th-95th percentile) so the two maps are comparable."""
    col, stops, _ = METRICS[metric_label]
    gj = {d: load_geojson(d, "buildings_final") for d in DISTRICTS}
    vals = np.array([clean_height(f["properties"][col]) if col == "height_m" else f["properties"][col]
                     for d in gj for f in gj[d]["features"]], dtype=float)
    lo, hi = np.percentile(vals, [0, 99.5] if col == "height_m" else [5, 95])
    for d in gj:
        for f in gj[d]["features"]:
            p = f["properties"]
            v = clean_height(p[col]) if col == "height_m" else p[col]
            p["color"] = ramp((v - lo) / (hi - lo + 1e-9), stops)
            p["elev"] = clean_height(p["height_m"])
    return gj, float(lo), float(hi)


def view_for(gj):
    pts = np.array([c for f in gj["features"] for c in f["geometry"]["coordinates"][0][:1]
                    if f["geometry"]["type"] == "Polygon"])
    return pdk.ViewState(latitude=float(pts[:, 1].mean()), longitude=float(pts[:, 0].mean()),
                         zoom=14.6, pitch=55, bearing=20)


def district_map(district, buildings_gj):
    layers = [
        pdk.Layer("GeoJsonLayer", load_geojson(district, "green"), stroked=False, filled=True,
                  get_fill_color=[70, 160, 90, 90]),
        pdk.Layer("GeoJsonLayer", load_geojson(district, "streets"), get_line_color=[90, 90, 100, 160],
                  get_line_width=3, line_width_min_pixels=1),
        pdk.Layer("GeoJsonLayer", buildings_gj, extruded=True, wireframe=False, pickable=True,
                  get_elevation="properties.elev", get_fill_color="properties.color", opacity=0.95),
    ]
    tip = {"html": "<b>{building_id}</b><br/>height {height_m} m<br/>LST {temp_c} °C<br/>"
                   "NDVI {ndvi}<br/>people {population_est}",
           "style": {"fontSize": "12px"}}
    return pdk.Deck(layers=layers, initial_view_state=view_for(buildings_gj), tooltip=tip,
                    map_style="light")


@st.cache_data
def get_zones():
    return sim.build_zones(data_dir=str(DATA_DIR))


@st.cache_data
def run_sim(traffic_mult, heat_delta):
    return sim.simulate(get_zones(), traffic_mult=traffic_mult, heat_delta=heat_delta)


def hourly(ts, col, how="mean"):
    """Average day: one value per district and hour. Electricity is first summed over zones."""
    if how == "sum":
        ts = ts.groupby(["district", "timestamp"], as_index=False)[col].sum()
    out = ts.assign(hour=pd.to_datetime(ts["timestamp"]).dt.hour).groupby(["district", "hour"], as_index=False)[col].mean()
    out["district"] = out["district"].map(DISTRICTS)
    return out


def line(df, col, ylabel):
    fig = px.line(df, x="hour", y=col, color="district", labels={"hour": "Hour of day", col: ylabel, "district": ""},
                  color_discrete_map={DISTRICTS[d]: COLORS[d] for d in DISTRICTS})
    fig.update_layout(margin=dict(l=0, r=0, t=10, b=0), legend=dict(orientation="h", y=1.12))
    return fig


# ------------------------------------------------------------------ page
def main():
    st.set_page_config(page_title="Baghdad twin: Jadriyah vs Karrada", layout="wide")
    st.title("Baghdad digital twin: Al-Jadriyah vs Al-Karrada")
    st.caption("Real: buildings, land surface temperature, NDVI, population. "
               "Simulated: air temperature, traffic, electricity (July, 30 days).")

    with st.sidebar:
        st.header("Scenario")
        traffic_mult = st.slider("Traffic", 0.5, 2.0, 1.0, 0.1, help="1.2 means +20% traffic")
        heat_delta = st.slider("Heatwave (+°C)", 0.0, 8.0, 0.0, 0.5)
        st.header("3D map")
        metric = st.selectbox("Colour buildings by", list(METRICS))

    if not (DATA_DIR / "karrada_buildings_final.geojson").exists():
        st.error(f"Data not found in {DATA_DIR}. Copy the 10 data files into a folder named 'data' next to app.py.")
        st.stop()

    tab_map, tab_cmp, tab_about = st.tabs(["3D map", "Comparison", "Assumptions"])

    # ---- 3D map
    with tab_map:
        gj, lo, hi = colour_buildings(metric)
        col, stops, unit = METRICS[metric]
        grad = ", ".join(f"rgb{tuple(s)}" for s in stops)
        st.markdown(f"<div style='height:10px;border-radius:5px;background:linear-gradient(90deg,{grad});max-width:420px'></div>"
                    f"<div style='max-width:420px;display:flex;justify-content:space-between;font-size:12px'>"
                    f"<span>{lo:.2f} {unit}</span><span>{hi:.2f} {unit}</span></div>", unsafe_allow_html=True)
        st.caption("Same colour scale on both maps. Height of each building is real height (capped at "
                   f"{sim.HEIGHT_CAP_M:.0f} m). Drag to rotate, scroll to zoom.")
        c1, c2 = st.columns(2)
        for c, d in zip((c1, c2), DISTRICTS):
            with c:
                st.subheader(DISTRICTS[d])
                st.pydeck_chart(district_map(d, gj[d]), use_container_width=True)

    # ---- comparison
    with tab_cmp:
        zones = get_zones()
        base = run_sim(1.0, 0.0)
        ts = run_sim(traffic_mult, heat_delta)
        s_base, s = sim.district_summary(base), sim.district_summary(ts)

        st.subheader("Simulated results for the chosen scenario")
        cols = st.columns(2)
        for c, d in zip(cols, DISTRICTS):
            with c:
                st.markdown(f"**{DISTRICTS[d]}**")
                a, b, e = st.columns(3)
                a.metric("Mean traffic index", f"{s.loc[d, 'mean_traffic']:.2f}",
                         f"{s.loc[d, 'mean_traffic'] - s_base.loc[d, 'mean_traffic']:+.2f}")
                b.metric("Peak air temp (°C)", f"{s.loc[d, 'peak_temp_c']:.1f}",
                         f"{s.loc[d, 'peak_temp_c'] - s_base.loc[d, 'peak_temp_c']:+.1f}")
                e.metric("Electricity (GWh/month)", f"{s.loc[d, 'total_electricity_mwh'] / 1000:.1f}",
                         f"{(s.loc[d, 'total_electricity_mwh'] - s_base.loc[d, 'total_electricity_mwh']) / 1000:+.1f}")
        st.caption("Green/red numbers show the change compared with the baseline (traffic x1.0, no heatwave).")

        g1, g2, g3 = st.columns(3)
        g1.markdown("**Traffic by hour**")
        g1.plotly_chart(line(hourly(ts, "traffic_index"), "traffic_index", "Traffic index (0-1.5)"), use_container_width=True)
        g2.markdown("**Electricity by hour (whole district)**")
        g2.plotly_chart(line(hourly(ts, "electricity_kwh", "sum"), "electricity_kwh", "kWh per hour"), use_container_width=True)
        g3.markdown("**Air temperature by hour (simulated)**")
        g3.plotly_chart(line(hourly(ts, "temp_c"), "temp_c", "°C"), use_container_width=True)

        st.subheader("Real indicators (from satellite and OSM data)")
        real = zones.groupby("district").apply(lambda z: pd.Series({
            "Buildings": z["n_buildings"].sum(),
            "Population (est.)": z["population_est"].sum(),
            "Mean height (m)": np.average(z["mean_height_m"], weights=z["n_buildings"]),
            "Built-up share of area": z["footprint_m2"].sum() / (len(z) * sim.CELL_M ** 2),
            "Mean NDVI": np.average(z["ndvi"], weights=z["n_buildings"]),
            "Mean land surface temp (°C)": np.average(z["lst_c"], weights=z["n_buildings"]),
        })).rename(index=DISTRICTS)
        st.dataframe(real.round(2).T, use_container_width=True)
        st.caption(f"Totals cover grid zones with at least {sim.MIN_BUILDINGS} buildings, so they are slightly below the raw file totals.")

    # ---- assumptions
    with tab_about:
        st.markdown("**Simulated indicators.** Traffic and electricity are not measured; they are generated from "
                    "real building density, floor area and hour of day. All parameters:")
        st.dataframe(pd.DataFrame(sim.ASSUMPTIONS).rename(columns=DISTRICTS), use_container_width=True)
        st.markdown(
            f"- Zones are {sim.CELL_M} m grid cells; zones with fewer than {sim.MIN_BUILDINGS} buildings are dropped.\n"
            f"- Missing or zero building heights use {sim.HEIGHT_DEFAULT_M:.0f} m; heights above "
            f"{sim.HEIGHT_CAP_M:.0f} m are capped (the Jadriyah file contains many values near 170 m, likely a data error).\n"
            "- Land surface temperature (satellite) is shown separately from simulated air temperature; they are different quantities.\n"
            "- The two districts are adjacent, so weather is shared; differences come from urban form and land use.\n"
            f"- Simulated period: {sim.START}, {sim.DAYS} days, hourly. Random seed {sim.RNG_SEED}.")


if __name__ == "__main__":
    main()
