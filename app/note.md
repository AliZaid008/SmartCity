# Baghdad Digital Twin: Project Context Note

> **For Claude:** This note is the shared context for a 3-person university team project. Read it fully, then help the person who uploaded it with their role (see "Roles"). The team speaks Iraqi Arabic and English. Reply in the language the person writes in. Be concise and practical. Do not claim something works if it has not been tested, and say so when you are unsure.

---

## 1. Project summary

We are building a simplified **digital twin / smart city simulation** for two districts of Baghdad and **comparing them**:

- **Al-Jadriyah**: residential and university area, lower density, more greenery, near the river.
- **Al-Karrada**: commercial and dense, heavy traffic, tightly packed buildings.

The supervisor agreed that:
- A full Baghdad twin is unrealistic, so we use **two districts only**.
- The data does **not** have to be 100% real. A **hybrid** of real and simulated data is accepted.
- The deliverable includes a **comparison** between the two districts.
- Time available is about one month, but we want to finish in **about 7-9 days**.

## 2. Key decisions already made

| Topic | Decision |
|---|---|
| 3D approach | **PyDeck inside Streamlit** (extruded buildings in the browser). No Unity, Unreal or Cesium, because nobody on the team knows 3D engines. |
| Backup 3D tool | **Kepler.gl** (no code, drag and drop GeoJSON). Optional **Blender + Blosm** for a cinematic demo video only. |
| Language | Python for everything |
| Dashboard | Streamlit + Plotly (charts and comparison page) |
| Districts | Jadriyah vs Karrada. Fallback if OSM data is poor: **Mansour vs Adhamiya** |
| Collaboration | GitHub repo (large data via Git LFS or shared Drive) |

## 3. Real vs simulated data

**Real data (free):**

| Indicator | Source | Notes |
|---|---|---|
| Buildings, streets, green areas | OpenStreetMap via `osmnx` | Building heights are often missing; we use a default of 10 m (or `building:levels` x 3 when available) |
| Building footprints (supplement) | Microsoft Building Footprints / Google Open Buildings | Fills gaps in OSM |
| Land surface temperature | Landsat 8/9 via Google Earth Engine or USGS | Real thermal difference between districts |
| Vegetation (NDVI) | Sentinel-2 | |
| Population density | WorldPop (~100 m grid) | |
| Weather | Open-Meteo / NASA POWER / ERA5 | |
| NO2 (optional) | Sentinel-5P | Low resolution (~5 km), may not separate adjacent districts, so treat as an estimate |

**Simulated data** (state this clearly in the report):
- **Traffic** and **electricity consumption**. No real per-district data exists.
- Derive them from real inputs: building density, population, land use, hour of day, temperature.
- Scenario effects, for example "traffic +20%" or "heatwave".

## 4. Shared data schema

Keep the same columns for both districts so they are comparable.

**Per building (static, real):**
`building_id, district, height_m, area_m2, temp_c, ndvi, population_est`

**Time series (simulated, hourly, about 30+ days):**
`timestamp, district, building_id (or zone_id), traffic_index, electricity_kwh, temp_c`

**File naming:**
`data/<district>_buildings.geojson`, `data/<district>_streets.geojson`, `data/<district>_green.geojson`

Districts keys: `jadriyah`, `karrada`.

## 5. Roles

| Person | Role | Tasks |
|---|---|---|
| **Storage person** (large disk) | Data engineer | Run the OSM script. Download and process Landsat, Sentinel-2, WorldPop, ERA5. Clip to both districts. Compute temperature, NDVI and population per building. Export to the shared schema. Manage Git LFS and backups. |
| **GPU person** (strong graphics card) | 3D / visuals | Check the 3D previews. Improve PyDeck visuals (colors, lighting, camera, street and green layers). Keep Kepler.gl as a backup. Optionally record the demo video with Blender. |
| **Project lead** | Simulation, dashboard, report | Define indicators and schema. Write the simulation and scenarios. Build the Streamlit app and comparison page. Integrate everything. Write the report and presentation. |

## 6. Timeline (about 7-9 days)

- **Day 1:** Run the OSM check script, compare building counts, confirm districts. Install tools. Create the GitHub repo. Start Earth Engine account approval (can take a day).
- **Day 2:** Both districts' files ready and the 3D preview works.
- **Day 3-4:** Real data (temperature, NDVI, population) attached per building. Streamlit app shows both districts colored by real data. **Checkpoint: end of day 4 must have a working app, even if simple.**
- **Day 5-7:** Simulation (traffic, electricity), scenarios (sliders), comparison page.
- **Day 8-9:** Integration, bug fixes, report, presentation, demo.

**Fallback:** if Earth Engine access is delayed, use WorldPop and OSM-derived indicators first and add satellite data later.

## 7. Day 1 script

`day1_osm_check.py` (shared separately) does the following:
- Downloads buildings, drivable streets and green areas for both districts using center point + radius (1500 m).
- Prints counts (buildings, buildings with a levels tag, street segments, green polygons).
- Saves GeoJSON files to `data/`.
- Creates a 3D preview HTML per district at `data/<district>_preview.html`.

Install:
```
pip install osmnx geopandas pydeck streamlit plotly
```

**Known caveats:**
- The center coordinates for both districts are **approximate**. Check the preview and adjust `center` and `radius_m`.
- The script has **not been tested** by the author. If it errors, fix it or ask Claude to debug with the full error message.
- OSM completeness for these districts was **not verified**. Day 1 counts decide whether to keep Jadriyah or switch to Mansour/Adhamiya.

## 8. Report notes (important)

- Clearly state that traffic and electricity are **simulated** and list the assumptions.
- Explain the hybrid approach: real urban form and environment data, simulated dynamic data.
- Mention that the two districts are adjacent, so weather is nearly the same and differences come from urban form and land use.
- State limitations: default building heights, low resolution of some satellite products, simulated indicators.
- Full 3D engine integration (Unity, Unreal, Cesium) is **future work**.

## 9. Open items

- [ ] Day 1 building counts for Jadriyah and Karrada
- [ ] Decide whether to keep Jadriyah or switch to the fallback pair
- [ ] Create GitHub repo and share access
- [ ] Earth Engine account approved
- [ ] Final list of 3-4 indicators (suggested: land surface temperature, NDVI, traffic, electricity)
- [ ] Agree on the exact column names in section 4

## 10. How to use this note with Claude

Upload this file at the start of a new chat, then say which role you have and what you are working on, for example:

- "I am the storage person. Help me pull Landsat temperature for Jadriyah and Karrada and attach it per building."
- "I am the GPU person. Help me improve the PyDeck 3D visuals."
- "I am the lead. Help me write the simulation and the Streamlit comparison page."
