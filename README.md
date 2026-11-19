# LEASELINE — Alberta lease navigation

Personal-use web app (installs to the home screen on Android and iPhone) for finding and driving to oilfield leases in Alberta.

## What it does
- **LSD / UWI / quarter / section / lat-long search**: `11-04-068-10 W5`, `100/11-04-068-10W5/00`, `NW 4-68-10 W5`, `54.86, -115.47`.
- **Whole Alberta LSD grid on the phone** (252,578 ATS sections, 2.3 MB). Lookups and "what LSD am I in" work with zero signal.
- **Exact official LSD outline** drawn when online (Government of Alberta ATS v4.1).
- **Province road layer + cutlines** (Alberta Base Features), cached on the phone for every area you view or route through.
- **On-phone routing** over those roads (and your own recorded tracks), voice prompts, off-route recalculation that works offline.
- **Road log** in odometer km, like written lease directions, plus a resettable TRIP odometer.
- **Last-leg guidance** when the lease is past the end of the mapped road (distance + bearing to the LSD centre).
- **Track recording** to capture new lease roads, GPX share/import for the crew.
- **Lease weather**: past 3 days of rain/snow + next 3 days, rough mud/frozen indicator.
- **Emergency card**: current LSD + coordinates (DD and DMS) ready to read to 911.
- Satellite (Esri) or Tactical (offline vector + terrain shading) map, optional 3D terrain.

## Accuracy (tested)
Computed LSD centres vs the official LSD polygons on ~10,000 LSDs: median ≈ 4 m, 95th percentile ≈ 7 m, worst ≈ 32 m. Irregular / fractional sections use the official centres directly.

## Limits
- Roads are only as current as the province's layer. Record your own tracks to fill gaps.
- Satellite tiles are kept only for areas you've already viewed (no bulk download).
- Alberta (W4–W6) only. No well-licence or facility-name search.

## Data & licences
Contains information licensed under the Open Government Licence – Alberta (ATS v4.1, Base Features Access roads & cutlines). Imagery © Esri, Maxar, Earthstar Geographics. Terrain: AWS Terrain Tiles. Weather: Open-Meteo. Map engine: MapLibre GL JS (BSD-3). Fonts: B612 Mono, Chakra Petch (SIL OFL).

## Hosting
Any static HTTPS host. GitHub Pages: Settings → Pages → Deploy from branch → `main` / root.
