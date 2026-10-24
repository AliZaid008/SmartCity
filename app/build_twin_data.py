"""Pack data/ into the compact files the 3D twin map (twin_map/) loads in the browser.

Run:  python build_twin_data.py      (only needed when something in data/ changes)
Writes twin_map/data/*.json and copies the land cover image. Needs only numpy + simulate.py,
so the app itself keeps working without any GIS libraries.

Every building gets the simulation zone it belongs to (same 250 m grid as simulate.py);
buildings outside every zone (satellite footprints at the edges, the area between the
districts) borrow the values of the nearest zone, and are flagged as such.
"""
import json
import shutil
from pathlib import Path

import numpy as np

import simulate as sim

HERE = Path(__file__).parent
DATA = HERE / "data"
OUT = HERE / "twin_map" / "data"
DISTRICTS = {"jadriyah": "Al-Jadriyah", "karrada": "Al-Karrada"}
CENTERS = {"jadriyah": (33.2760, 44.3830), "karrada": (33.3020, 44.4300)}  # (lat, lon), as in previews.py
RADIUS_M = 1500
MIN_AREA_M2 = 5.0   # drops the CBI Tower facade fins (81 slivers of ~0.1 m2 tagged 170 m)
KX = 111320.0 * np.cos(np.radians(33.3))  # meters per degree, same approximation as simulate.py
KY = 110574.0
ROUND = 6           # ~0.1 m


def load(name):
    path = DATA / f"{name}.geojson"
    if not path.exists():
        print(f"  (missing {path.name}, skipped)")
        return []
    return json.loads(path.read_text(encoding="utf-8"))["features"]


def polygons(geom):
    """GeoJSON Polygon/MultiPolygon -> list of polygons (each a list of rings)."""
    if geom is None:
        return []
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    if geom["type"] == "MultiPolygon":
        return geom["coordinates"]
    return []


def lines(geom):
    if geom is None:
        return []
    if geom["type"] == "LineString":
        return [geom["coordinates"]]
    if geom["type"] == "MultiLineString":
        return geom["coordinates"]
    return []


def rnd(rings):
    return [[[round(x, ROUND), round(y, ROUND)] for x, y, *_ in ring] for ring in rings]


def ring_area_centroid(ring):
    """Planar area (m2) and centroid (lon, lat) of a ring."""
    pts = np.asarray(ring, dtype=float)[:, :2]
    x, y = pts[:, 0] * KX, pts[:, 1] * KY
    cross = x[:-1] * y[1:] - x[1:] * y[:-1]
    a = cross.sum() / 2
    if abs(a) < 1e-9:
        return 0.0, (pts[:, 0].mean(), pts[:, 1].mean())
    cx = ((x[:-1] + x[1:]) * cross).sum() / (6 * a)
    cy = ((y[:-1] + y[1:]) * cross).sum() / (6 * a)
    return abs(a), (cx / KX, cy / KY)


def zone_table():
    zones = sim.build_zones(data_dir=str(DATA))
    cx = (zones["gx"] + 0.5) * sim.CELL_M
    cy = (zones["gy"] + 0.5) * sim.CELL_M
    return zones, np.c_[cx, cy]


def nearest_zone(x, y, zone_xy):
    d = (zone_xy[:, 0] - x) ** 2 + (zone_xy[:, 1] - y) ** 2
    return int(np.argmin(d))


def build_buildings(zones, zone_xy):
    zone_index = {zid: i for i, zid in enumerate(zones["zone_id"])}
    rows = {k: [] for k in ("id", "d", "z", "near", "h", "a", "lst", "ndvi", "pop", "src", "c", "poly")}
    sources = [(f"{d}_buildings_final", d, "osm") for d in DISTRICTS]
    sources += [(f"{d}_buildings_fill", d, "satellite") for d in DISTRICTS]
    sources += [("context_buildings", "between", "satellite")]
    for name, district, src in sources:
        n = 0
        for f in load(name):
            p = f["properties"]
            for poly in polygons(f["geometry"]):
                area, (lon, lat) = ring_area_centroid(poly[0])
                if area < MIN_AREA_M2:
                    continue
                h = p.get("height_m") or 0
                h = h if h > 0 else sim.HEIGHT_DEFAULT_M
                x, y = lon * KX, lat * KY
                zid = f"{district[:3]}_{int(x // sim.CELL_M)}_{int(y // sim.CELL_M)}"
                inside = zid in zone_index
                rows["id"].append(str(p.get("building_id", f"{district}_{n}")))
                rows["d"].append(district)
                rows["z"].append(zone_index[zid] if inside else nearest_zone(x, y, zone_xy))
                rows["near"].append(0 if inside else 1)
                rows["h"].append(round(float(h), 1))
                rows["a"].append(round(float(p.get("area_m2") or area), 1))
                for key, col in (("lst", "temp_c"), ("ndvi", "ndvi"), ("pop", "population_est")):
                    v = p.get(col)
                    rows[key].append(None if v is None or (isinstance(v, float) and np.isnan(v)) else round(float(v), 3))
                rows["src"].append(src)
                rows["c"].append([round(lon, ROUND), round(lat, ROUND)])
                rows["poly"].append(rnd(poly))
                n += 1
        print(f"  buildings {name}: {n}")
    return rows


def build_roads():
    out = {"path": [], "cls": [], "name": []}
    for name in ("jadriyah_streets_full", "karrada_streets_full", "context_streets"):
        for f in load(name):
            p = f["properties"]
            cls = str(p.get("highway") or "unclassified").split(",")[0].strip()
            for line in lines(f["geometry"]):
                if len(line) < 2:
                    continue
                out["path"].append([[round(x, ROUND), round(y, ROUND)] for x, y, *_ in line])
                out["cls"].append(cls)
                out["name"].append(p.get("name_en"))
    print(f"  roads: {len(out['path'])}")
    return out


def build_polys(names, keep=()):
    out = {"poly": []}
    for k in keep:
        out[k] = []
    for name in names:
        for f in load(name):
            for poly in polygons(f["geometry"]):
                out["poly"].append(rnd(poly))
                for k in keep:
                    out[k].append(f["properties"].get(k))
    return out


def build_trees():
    out = []
    for name in ("jadriyah_trees", "karrada_trees", "context_trees"):
        for f in load(name):
            x, y = f["geometry"]["coordinates"][:2]
            out.append([round(x, ROUND), round(y, ROUND), round(float(f["properties"].get("height_m") or 8), 1)])
    print(f"  trees: {len(out)}")
    return out


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    zones, zone_xy = zone_table()
    cell = sim.CELL_M
    zone_out = {
        "id": zones["zone_id"].tolist(),
        "district": zones["district"].tolist(),
        "floor_m2": zones["floor_area_m2"].round(0).tolist(),
        # 250 m cell outline in lon/lat, for the ground heat/traffic overlay
        "cell": [[[round(gx * cell / KX, ROUND), round(gy * cell / KY, ROUND)],
                  [round((gx + 1) * cell / KX, ROUND), round(gy * cell / KY, ROUND)],
                  [round((gx + 1) * cell / KX, ROUND), round((gy + 1) * cell / KY, ROUND)],
                  [round(gx * cell / KX, ROUND), round((gy + 1) * cell / KY, ROUND)]]
                 for gx, gy in zip(zones["gx"], zones["gy"])],
    }
    files = {
        "zones.json": zone_out,
        "buildings.json": build_buildings(zones, zone_xy),
        "roads.json": build_roads(),
        "green.json": build_polys(["jadriyah_green_full", "karrada_green_full", "context_green"], keep=("green_type",)),
        "water.json": build_polys(["jadriyah_water", "karrada_water", "context_water"]),
        "trees.json": build_trees(),
    }
    # Baseline average day per zone, so the map also works when opened on its own
    files["baseline_profiles.json"] = sim.zone_day_profiles(sim.simulate(zones), zones)

    lc = json.loads((DATA / "landcover.json").read_text(encoding="utf-8"))
    shutil.copy(DATA / "landcover.png", OUT / "landcover.png")
    # Half-size copy for GPUs whose max texture size is below the full image width
    from PIL import Image
    with Image.open(DATA / "landcover.png") as im:
        im.resize((im.width // 2, im.height // 2), Image.Resampling.NEAREST).save(OUT / "landcover_small.png", optimize=True)
    files["scene.json"] = {
        "districts": {k: {"name": v, "center": [CENTERS[k][1], CENTERS[k][0]], "radius_m": RADIUS_M}
                      for k, v in DISTRICTS.items()},
        "landcover": lc,
    }
    for name, payload in files.items():
        (OUT / name).write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        print(f"  -> twin_map/data/{name}: {(OUT / name).stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
