# LEASELINE — Alberta lease navigation

Personal-use web app (installs to the home screen on Android and iPhone) for finding and driving to oilfield leases in Alberta.

## What it does
- **LSD / UWI / quarter / section / lat-long search**: `16-25-045-12 W5`, `100/16-25-045-12W5/00`, `NW 25-45-12 W5`, `53.21, -115.62`.
- **Whole Alberta LSD grid on the phone** (252,578 ATS sections, 2.3 MB). Lookups and "what LSD am I in" work with zero signal.
- **Exact official LSD outline** drawn when online (Government of Alberta ATS v4.1).
- **Province road layer + cutlines** (Alberta Base Features), cached on the phone for every area you view or route through.
- **On-phone routing** over those roads (and your own recorded tracks), voice prompts, off-route recalculation that works offline.
- **Road log** in odometer km, like written lease directions, plus a resettable TRIP odometer.
- **Last-leg guidance** when the lease is past the end of the mapped road (distance + bearing to the LSD centre).
- **Track recording** to capture new lease roads, GPX share/import for the crew.
- **Lease weather**: past 3 days of rain/snow + next 3 days, rough mud/frozen indicator.
- **Emergency card**: current LSD + coordinates (DD and DMS) ready to read to 911, plus the nearest hospitals with ROUTE.
- **Wells**: every AER well site that still physically exists (336k), searchable by licence, UWI (goes to the surface lease), company or well name; tap a dot for licensee, status, spud, boreholes, TD; horizontal laterals drawn; sour (H2S) wells ringed red with a warning on the target.
- **Road-reach check** on every target: road reaches the lease / stops short / ends blind.
- **Sites**: saved pins with gate code, radio channel and notes; SEND TO CREW makes a link that opens the site in the app.
- **Trip planner**: start from GPS or a town/LSD, multiple stops, one combined road log.
- **Rig activity**: AER daily drilling list (30 days), nearest first, follow a rig.
- **Town search** offline, **geo-stamped photos** (LSD + GPS + time burned in).
- Data refreshes daily by itself (scheduled task runs `dev/refresh.sh`).
- Satellite (Esri) or Tactical (offline vector + terrain shading) map, optional 3D terrain.

## Accuracy (tested)
Computed LSD centres vs the official LSD polygons on ~10,000 LSDs: median ≈ 4 m, 95th percentile ≈ 7 m, worst ≈ 32 m. Irregular / fractional sections use the official centres directly.

## Limits
- Roads are only as current as the province's layer. Record your own tracks to fill gaps.
- Satellite tiles are kept only for areas you've already viewed (no bulk download).
- Alberta (W4–W6) only. No pipelines or facility (battery/plant) names yet. Cancelled and reclaimed well licences are left out to keep the download small.
- Hospital list is from 2020 (Grande Prairie updated by hand); call 911 first.

## Data & licences
Contains information licensed under the Open Government Licence – Alberta (ATS v4.1, Base Features Access roads & cutlines, Geographic Names) and the Open Government Licence – Canada (ODHF). Well, licence and rig data: Alberta Energy Regulator. Imagery © Esri, Maxar, Earthstar Geographics. Terrain: AWS Terrain Tiles. Weather: Open-Meteo. Map engine: MapLibre GL JS (BSD-3). Fonts: B612 Mono, Chakra Petch (SIL OFL).

## Hosting
Any static HTTPS host. GitHub Pages: Settings → Pages → Deploy from branch → `main` / root.
