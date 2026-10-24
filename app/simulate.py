"""
simulate.py  (project lead)

1) build_zones(): turns data/<district>_buildings_final.geojson into ~250 m grid zones
   with real urban-form stats (building count, floor area, height).
2) simulate(): generates hourly temperature, traffic, electricity and NO2 per zone.
   Traffic, electricity and NO2 are SIMULATED. Every assumption lives in the
   ASSUMPTIONS block below so it can be listed in the report.
3) Scenarios: traffic_mult (e.g. 1.2 = +20% traffic) and heat_delta (+C degrees).
   The indicators are linked, so a scenario shows up everywhere it should:
   more traffic -> more vehicle heat (warmer air) and more NO2;
   hotter air   -> more cooling electricity and more NO2 (heat speeds up smog chemistry).

Run:  python simulate.py        -> writes data/zones.csv and data/timeseries.csv
Use from Streamlit:  from simulate import simulate, load_zones
"""
import numpy as np
import pandas as pd

# ------------------------------------------------------------------ ASSUMPTIONS
# All values are placeholders to be tuned and then documented in the report.
ASSUMPTIONS = {
    "jadriyah": {
        "commercial_share": 0.15,   # share of floor area that is commercial
        "traffic_base": 0.45,       # baseline traffic intensity 0..1
        "kwh_per_m2_day": 0.60,     # electricity per m2 floor area per day
        "persons_per_m2": 0.022,    # used only if no WorldPop value is attached
        "traffic_heat_c": 0.8,      # air warming (C) from vehicles at traffic index 1.0
        "no2_base_ugm3": 12.0,      # background NO2 with no local traffic
        "no2_per_traffic": 55.0,    # extra NO2 (ug/m3) at traffic index 1.0
        "no2_heat_per_c": 0.015,    # +1.5% NO2 per C above 35 C
    },
    "karrada": {
        "commercial_share": 0.55,
        "traffic_base": 0.80,
        "kwh_per_m2_day": 0.80,
        "persons_per_m2": 0.030,
        "traffic_heat_c": 0.8,
        "no2_base_ugm3": 12.0,
        "no2_per_traffic": 55.0,
        "no2_heat_per_c": 0.015,
    },
}
START = "2026-07-01"          # summer month: Baghdad is hot, cooling load matters
DAYS = 30
CELL_M = 250                  # zone size in meters
WEEKEND = (4, 5)              # Friday=4, Saturday=5 (Mon=0)
RNG_SEED = 42

# Hourly profiles (24 values each, hour 0..23), normalized so max = 1
_TRAFFIC_PROFILE = np.array([
    .10, .07, .05, .05, .08, .20, .45, .85, 1.0, .80, .65, .65,
    .70, .70, .65, .70, .85, 1.0, .90, .75, .55, .40, .28, .18])
_ELEC_PROFILE = np.array([
    .70, .65, .60, .58, .58, .60, .65, .72, .78, .82, .86, .90,
    .95, 1.0, 1.0, .98, .96, .96, .98, 1.0, .95, .88, .80, .74])
_ELEC_PROFILE = _ELEC_PROFILE / _ELEC_PROFILE.max()


# ------------------------------------------------------------------ ZONES
# Data cleaning choices (state these in the report)
HEIGHT_DEFAULT_M = 10.0   # used when height_m is 0/missing
HEIGHT_CAP_M = 60.0       # Jadriyah file has 88 buildings at ~170 m: treated as a
                          # data error and capped. Set to None to disable.
MIN_BUILDINGS = 5         # drop edge zones with fewer buildings (partial cells)


def _centroid_m(geom):
    """Approx centroid in meters (equirectangular around Baghdad). No GIS libs."""
    ring = geom["coordinates"][0] if geom["type"] == "Polygon" else geom["coordinates"][0][0]
    lon = np.mean([p[0] for p in ring])
    lat = np.mean([p[1] for p in ring])
    return lon * 111320.0 * np.cos(np.radians(33.3)), lat * 110574.0


def load_buildings(d, data_dir="data"):
    """Read data/<d>_buildings_final.geojson (schema from the note, section 4)."""
    import json
    with open(f"{data_dir}/{d}_buildings_final.geojson", encoding="utf-8") as f:
        feats = json.load(f)["features"]
    b = pd.DataFrame([f["properties"] for f in feats])
    xy = np.array([_centroid_m(f["geometry"]) for f in feats])
    b["x"], b["y"] = xy[:, 0], xy[:, 1]
    return b


def build_zones(districts=("jadriyah", "karrada"), data_dir="data"):
    """Aggregate buildings into ~250 m grid zones using REAL height, area, NDVI,
    land surface temperature and population from the data engineer."""
    rows = []
    for d in districts:
        b = load_buildings(d, data_dir)
        h = b["height_m"].where(b["height_m"] > 0, HEIGHT_DEFAULT_M)
        n_capped = 0
        if HEIGHT_CAP_M is not None:
            n_capped = int((h > HEIGHT_CAP_M).sum())
            h = h.clip(upper=HEIGHT_CAP_M)
        b["h"] = h
        b["floor_area"] = b["area_m2"] * (b["h"] / 3.0).clip(lower=1)
        b["gx"] = (b["x"] // CELL_M).astype(int)
        b["gy"] = (b["y"] // CELL_M).astype(int)
        g = b.groupby(["gx", "gy"]).agg(
            n_buildings=("building_id", "count"),
            footprint_m2=("area_m2", "sum"),
            floor_area_m2=("floor_area", "sum"),
            mean_height_m=("h", "mean"),
            population_est=("population_est", "sum"),
            ndvi=("ndvi", "mean"),
            lst_c=("temp_c", "mean"),
        ).reset_index()
        g = g[g["n_buildings"] >= MIN_BUILDINGS].copy()
        g["district"] = d
        g["zone_id"] = d[:3] + "_" + g["gx"].astype(str) + "_" + g["gy"].astype(str)
        g["density"] = (g["footprint_m2"] / (CELL_M * CELL_M)).clip(upper=1.0)
        print(f"[{d}] buildings={len(b)} zones={len(g)} heights_capped={n_capped}")
        rows.append(g)
    return pd.concat(rows, ignore_index=True)


def load_zones(path="data/zones.csv"):
    return pd.read_csv(path)


# ------------------------------------------------------------------ SIMULATION
def _weather(index, rng, heat_delta=0.0):
    """Shared weather for both districts (they are adjacent)."""
    hour = index.hour.values
    day_noise = rng.normal(0, 1.5, size=DAYS)[(index - index[0]).days.values]
    base = 37.0 + 8.0 * np.sin((hour - 9) / 24 * 2 * np.pi)   # peak ~15:00
    return base + day_noise + rng.normal(0, 0.6, size=len(index)) + heat_delta


def simulate(zones, traffic_mult=1.0, heat_delta=0.0, seed=RNG_SEED):
    """Return a long dataframe: timestamp, zone_id, district, temp_c,
    traffic_index, electricity_kwh, no2_ugm3. Fully reproducible for a given seed."""
    rng = np.random.default_rng(seed)
    index = pd.date_range(START, periods=DAYS * 24, freq="h")
    hour = index.hour.values
    weekend = np.isin(index.dayofweek.values, WEEKEND)
    weather = _weather(index, rng, heat_delta)

    out = []
    for _, z in zones.iterrows():
        a = ASSUMPTIONS[z["district"]]

        # Traffic: profile x base x density x weekend factor x noise x scenario
        wk = np.where(weekend, 0.7, 1.0)
        density_f = 0.5 + z["density"]
        traffic = (_TRAFFIC_PROFILE[hour] * a["traffic_base"] * density_f * wk
                   * rng.normal(1, 0.08, size=len(index)) * traffic_mult)
        traffic = np.clip(traffic, 0, 1.5)

        # Urban heat island: denser zones are warmer, vegetation cools, vehicles add heat
        ndvi = 0.1 if pd.isna(z.get("ndvi")) else z["ndvi"]
        uhi = 2.5 * z["density"] - 3.0 * ndvi
        temp = weather + uhi + a["traffic_heat_c"] * traffic + rng.normal(0, 0.3, size=len(index))

        # Electricity: base load profile + cooling load above 26 C
        cooling = 1 + 0.06 * np.clip(temp - 26, 0, None)
        kwh_hour = (z["floor_area_m2"] * a["kwh_per_m2_day"] / 24.0
                    * _ELEC_PROFILE[hour] * cooling
                    * rng.normal(1, 0.05, size=len(index)))

        # NO2: background + traffic emissions, higher in the heat
        no2 = ((a["no2_base_ugm3"] + a["no2_per_traffic"] * traffic)
               * (1 + a["no2_heat_per_c"] * np.clip(temp - 35, 0, None)))

        out.append(pd.DataFrame({
            "timestamp": index,
            "zone_id": z["zone_id"],
            "district": z["district"],
            "temp_c": temp.round(2),
            "traffic_index": traffic.round(3),
            "electricity_kwh": kwh_hour.round(1),
            "no2_ugm3": no2.round(1),
        }))
    return pd.concat(out, ignore_index=True)


def zone_day_profiles(ts, zones):
    """Average day per zone: {zone_id: {"temp": [24], "traffic": [24], "elec_m2": [24], "no2": [24]}}.
    elec_m2 is kWh per m2 of floor area per hour, so it can be spread over any building."""
    day = (ts.assign(hour=pd.to_datetime(ts["timestamp"]).dt.hour)
             .groupby(["zone_id", "hour"])[["temp_c", "traffic_index", "electricity_kwh", "no2_ugm3"]].mean())
    floor = zones.set_index("zone_id")["floor_area_m2"]
    out = {}
    for zone_id, g in day.groupby(level=0):
        g = g.droplevel(0).reindex(range(24))
        out[zone_id] = {
            "temp": g["temp_c"].round(2).tolist(),
            "traffic": g["traffic_index"].round(3).tolist(),
            "elec_m2": (g["electricity_kwh"] / floor[zone_id]).round(5).tolist(),
            "no2": g["no2_ugm3"].round(1).tolist(),
        }
    return out


def district_summary(ts):
    """Quick comparison table used by the dashboard."""
    return ts.groupby("district").agg(
        mean_temp_c=("temp_c", "mean"),
        peak_temp_c=("temp_c", "max"),
        mean_traffic=("traffic_index", "mean"),
        peak_traffic=("traffic_index", "max"),
        total_electricity_mwh=("electricity_kwh", lambda s: s.sum() / 1000),
        mean_no2=("no2_ugm3", "mean"),
        peak_no2=("no2_ugm3", "max"),
    ).round(2)


if __name__ == "__main__":
    zones = build_zones()
    zones.to_csv("data/zones.csv", index=False)
    ts = simulate(zones)
    ts.to_csv("data/timeseries.csv", index=False)
    print(zones.groupby("district")[["n_buildings", "floor_area_m2"]].sum())
    print(district_summary(ts))
