# Baghdad Digital Twin: Al-Jadriyah vs Al-Karrada

A Streamlit dashboard with an interactive 3D twin of both districts and the city between them.
Real city form (buildings, satellite surface temperature, vegetation, population, land cover)
drives a simulated July day of traffic, air temperature, electricity and NO₂.

## Start

- **Windows:** double-click `run_app.bat`
- **macOS / Linux:** `sh run_app.sh`
- **By hand:** `pip install -r requirements.txt`, then `streamlit run app.py`

The first start creates a local Python environment and installs the requirements (needs Python 3.10+
and internet once). The app opens at http://localhost:8501.

## What is on the page

| Part | What it does |
| --- | --- |
| Sidebar | Traffic and heatwave sliders, plus presets (Rush-hour surge, Heatwave + gridlock, Car-free day...) |
| Cards | Each indicator for both districts, with the change vs the baseline (red = worse) |
| 🌐 3D digital twin | The interactive map (below). It updates instantly when a slider moves |
| 📈 Scenario analysis | Baseline (dotted) vs scenario (solid) per hour on fixed axes, what changed in %, 3D heat landscape |
| 🏙️ District comparison | Radar fingerprint of both districts, real and simulated indicator tables |
| 📋 Assumptions | Every simulation parameter and data source |

### The 3D twin

- **Ground:** *Land cover* (default) fills every open space from ESA WorldCover: green plants, sand for
  bare ground, a building color for built-up land, blue water. *Satellite* shows real imagery, *Dark* a night map.
- **Buildings:** *Realistic* colors every roof with its real color, sampled from satellite imagery.
  Other modes color buildings by simulated air temperature, traffic, electricity, NO₂, or by real
  surface temperature, vegetation and footprint size. *Show change vs baseline* colors what the scenario changed.
- **Click a building:** the camera flies to it and circles it; a card shows it as a rotating 3D object
  with floors, its real data and its simulated values with a 24-hour chart. *Isolate* fades the rest.
- **Time of day:** drag the clock or press ▶ to play the day: sun position, shadows of light, street lights and traffic change.
- **Traffic:** moving cars on every road; more traffic means more and slower cars and redder roads.
- **Quality:** *Auto* keeps full quality on capable computers and only steps down (fewer cars, simpler trees,
  lower resolution) if the frame rate stays low. *High / Med / Low* can also be picked by hand.

The map works offline except the satellite imagery, roof colors and the web font.

## Files

| File | Purpose |
| --- | --- |
| `app.py` | The dashboard |
| `simulate.py` | Zones and the hourly simulation (all assumptions in `ASSUMPTIONS`) |
| `build_twin_data.py` | Packs `data/` into `twin_map/data/` for the 3D map. Run again when `data/` changes |
| `twin_map/` | The 3D map (HTML/JS; deck.gl and MapLibre are bundled in `vendor/`) |
| `data/` | Buildings, roads, green, water, trees, land cover, and the simulation CSVs |
| `day1_osm_check.py`, `note (1).md` | Original team script and project note |

The map layers in `data/` come from the maps project (`../maps`): OSM buildings plus Microsoft
satellite footprints via Overture, OSM roads, green areas, water and trees, and ESA WorldCover land cover.

## Sources

OpenStreetMap contributors (ODbL) · Microsoft Building Footprints via Overture Maps (ODbL) ·
ESA WorldCover 2021 (CC BY 4.0) · Esri World Imagery (loaded live, © Esri, Maxar, Earthstar Geographics) ·
deck.gl and MapLibre GL JS (bundled, licenses in `twin_map/vendor/`).
