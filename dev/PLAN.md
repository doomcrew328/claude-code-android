# LEASELINE — project status and plan

Last updated: 2026-11-19

## Status
- **v1 live:** https://doomcrew328.github.io/claude-code-android/ (this `gh-pages` branch; GitHub Pages serves the repo root).
- Tested in headless Chrome with real Alberta data (Swan Hills area): LSD/UWI search, official LSD outline, routing, turn-by-turn, offline reroute, offline reload via service worker, track record/save, tap-to-identify, weather sheet, offline area save. **Not yet field-tested on a real drive.**
- v1 was built before a full competitor teardown. The teardown below was done afterwards; v2 should follow it.

## What the app is for
"The work order says 11-04-068-10W5 — get me there," including on lease roads and with no signal.

## v1 features
- Search: LSD, UWI (`100/11-04-068-10W5/00`), quarter (`NW 4-68-10 W5`), section, lat/long, DMS, saved pins.
- Whole Alberta ATS grid on the phone (`data/lsd.bin.gz`, 252,578 sections, 2.3 MB). Reverse lookup (current LSD) works offline.
- Accuracy vs official LSD polygons: median ~4 m, p95 ~7 m, worst found ~32 m. 3,094 irregular/fractional sections store official LSD centres (34,504).
- Official LSD outline drawn when online.
- Roads: Alberta Base Features "Access and Facility Roads" (FEATURE_TYPE classes), cutlines (utility/access layer 30). Cached in IndexedDB per 0.1° cell.
- On-phone A* routing (route.js) over gov roads + user tracks; voice prompts; off-route reroute works offline; road log in odometer km; last-leg distance/bearing when the road stops short.
- Track recording, GPX export/share/import, pins, history, trip odometer.
- Lease weather (Open-Meteo): past 3 days + next 3, mud/frozen indicator.
- Emergency card (LSD, DD, DMS, accuracy).
- Satellite (Esri World Imagery, z18) or Tactical (vector + hillshade) map, optional 3D terrain (AWS terrarium).
- Glass-cockpit design: amber data, magenta route, cyan ownship, B612 Mono + Chakra Petch fonts.

## Competitor teardown (Nov 2026, from store listings and vendor pages)
| App | Notable capabilities | Notes |
|---|---|---|
| OilTrails (Ash Point) | Offline LSD (AB/BC/SK/MB) + NTS; well info (operator, depth, drill date, status, fluid); downhole LSD → surface prompt; directions from custom origin; collections as multi-stop waypoints; past/future weather; GeoPics camera with stamps/QR, albums; history with dates; DLS/NTS grid; web app, business accounts | 4.7★ (327). Standard ~$5.99/mo or $59.99/yr. Nav hands off to Apple/Google roads |
| Lease Locator (Wolf Mask) | LSD/NTS/UTM/UWI/lat-long; offline 18.7M LSDs (Pro); BACK40 (road reaches / stops short / ends blind + distance to nearest road); folders with notes, gate codes, radio channels shared with crew; daily rig activity; colour pins; dark maps | Most installed on Android (~85k). Pricing tiers inconsistent in listing |
| PatchMap (Skybase) | Wellsites/facilities search (UWI, operator, licence); own road-network routing; active rigs; highway cameras; municipal/WMU/trapline boundaries; civic addresses; nearest accommodation + hospital; waypoints with symbols; trip logs; GPX | Last updated 2020 (iOS) / 2021 (Android); 2.2★ |
| BRMB Maps | 900k km industry/oil & gas roads; turn-by-turn on own network; offline areas incl. satellite; Crown land; wildfires; restricted areas; LSD grid, cutlines, pipelines, facilities; CarPlay/Android Auto; error reporting | $59.99/yr PRO. Recreation-focused, not a lease locator |
| StackDX Maps (ex-Petro Ninja) | Wells, pipelines, facilities, mineral rights, pools, units, surface dispositions; well documents; field data capture/forms shared with team | Free core; data-heavy, not a navigator |
| Rig Finder (GeoActivity) | Rig locations; favourite rigs + notify when drilling starts | Reviews report wrong locations since 2023 |
| Wellsite Navigator | Proprietary lease-road network; weekly satellite updates; user-submitted wells; enterprise dispatch | Mostly US |

## Where v1 is ahead
Offline routing/rerouting on the province's lease-road network, odometer road log, recorded tracks feeding the router, free. (Offline LSD itself is not unique — OilTrails and Lease Locator Pro have it.)

## Web-app limits (would need a native app)
CarPlay/Android Auto; bulk satellite downloads (imagery licence); reliable GPS with the screen off on iPhone.

## Free data sources verified for v2
- AER Well Licence List for all of Alberta — CSV, daily, free (licence, company, lat/long, surface location, status).
- AER ST37 List of Wells — monthly, free (geodatabase 1.23 GB, Excel 170 MB).
- AER ST102 Facility List — free.
- AER ST49 Daily Drilling (spud) Activity — free text (well ID, contractor, rig number, activity date).
- AER spatial data page lists pipeline and abandoned-well shapefiles.
- geospatial.alberta.ca: PSAP (911) boundaries, parks/protected areas, municipalities, Crown land reservations (CORS OK).

## v2 candidate list (Mike to choose)
1. Wells & facilities layer; search by licence/UWI/company; tap for details; downhole → surface. (OilTrails + PatchMap)
2. Road-reach check before you drive: reaches / stops short / ends blind. (Lease Locator BACK40)
3. Site notes: gate codes, radio channels, notes; shareable with crew. (Lease Locator)
4. Daily rig activity + follow a rig. (Rig Finder)
5. Directions from a chosen start (town/camp) + multi-stop trips. (OilTrails)
6. Nearest hospital in the emergency screen. (PatchMap)
7. Geo-stamped photos. (OilTrails)
8. Pipelines + abandoned wells hazard layers. (StackDX)
9. Nightly GitHub Action to refresh all data automatically.

## Rebuilding the LSD database
```
python3 dev/scripts/fetch_sections.py      # ~1 min, writes data/sections.jsonl (all ATS sections, RA=' ')
python3 dev/scripts/validate.py            # accuracy check vs official LSD polygons
python3 dev/scripts/flag_sections.py      # writes data/flagged.json
PYTHONPATH=dev/scripts python3 dev/scripts/fetch_flagged.py   # exact centres for irregular sections
python3 dev/scripts/pack.py                # writes data/lsd.bin(.gz)
```

## Data licences
Open Government Licence – Alberta (ATS v4.1, Base Features roads & cutlines). Imagery © Esri, Maxar, Earthstar Geographics. Terrain: AWS Terrain Tiles. Weather: Open-Meteo. MapLibre GL JS (BSD-3). Fonts SIL OFL.
