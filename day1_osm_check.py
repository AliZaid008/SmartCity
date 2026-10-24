"""
Day 1: pull Jadriyah and Karrada from OpenStreetMap, check data quality,
save GeoJSON files, and build a quick 3D preview.

Install:  pip install osmnx geopandas pydeck
Run:      python day1_osm_check.py

NOTE: the center points below are approximate. Open the preview and adjust
CENTER / RADIUS_M if the area is off.
"""
import os
import osmnx as ox
import pydeck as pdk

AREAS = {
    "jadriyah": {"center": (33.2760, 44.3830), "radius_m": 1500},
    "karrada":  {"center": (33.3020, 44.4300), "radius_m": 1500},
}

os.makedirs("data", exist_ok=True)

for name, cfg in AREAS.items():
    print(f"\n=== {name} ===")
    lat, lon = cfg["center"]
    r = cfg["radius_m"]

    # Buildings
    b = ox.features_from_point((lat, lon), tags={"building": True}, dist=r)
    b = b[b.geometry.type.isin(["Polygon", "MultiPolygon"])].copy()
    b = b.reset_index(drop=True)
    b["id"] = b.index

    # Height: use real tags when available, otherwise a default of 10 m
    levels = b["building:levels"] if "building:levels" in b else None
    height = b["height"] if "height" in b else None
    b["h"] = 10.0
    if levels is not None:
        lv = levels.astype(str).str.extract(r"(\d+\.?\d*)")[0].astype(float)
        b.loc[lv.notna(), "h"] = lv[lv.notna()] * 3.0
    if height is not None:
        hh = height.astype(str).str.extract(r"(\d+\.?\d*)")[0].astype(float)
        b.loc[hh.notna(), "h"] = hh[hh.notna()]

    real_h = int(((levels is not None) and levels.notna().sum()) or 0)
    print(f"Buildings: {len(b)}  | with levels tag: {real_h}")

    # Streets
    g = ox.graph_from_point((lat, lon), dist=r, network_type="drive")
    edges = ox.graph_to_gdfs(g, nodes=False)
    print(f"Street segments: {len(edges)}")

    # Green areas
    green = ox.features_from_point(
        (lat, lon),
        tags={"leisure": ["park", "garden"], "landuse": ["grass", "forest"], "natural": "wood"},
        dist=r,
    )
    print(f"Green polygons: {len(green)}")

    # Save
    b[["id", "h", "geometry"]].to_file(f"data/{name}_buildings.geojson", driver="GeoJSON")
    edges[["geometry"]].to_file(f"data/{name}_streets.geojson", driver="GeoJSON")
    if len(green):
        green[["geometry"]].to_file(f"data/{name}_green.geojson", driver="GeoJSON")

    # 3D preview
    layer = pdk.Layer(
        "GeoJsonLayer",
        data=b[["h", "geometry"]].to_json(),
        extruded=True,
        get_elevation="properties.h",
        get_fill_color="[200, 200, 220]",
        pickable=True,
    )
    view = pdk.ViewState(latitude=lat, longitude=lon, zoom=15, pitch=55, bearing=20)
    pdk.Deck(layers=[layer], initial_view_state=view).to_html(
        f"data/{name}_preview.html"
    )
    print(f"Saved preview: data/{name}_preview.html")

print("\nDone. Compare the building counts of both areas, then decide.")
