# Plan

Public version of the project plan. Trip details are kept out of this repo.

## Goal

A private, phone-first web app showing a trip's journeys on an interactive map of Europe: a flat map with soft relief shading, place and station names, and each journey drawn as a straight line between its start and end. All data is edited in Baserow.

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Hosting | GitHub Pages, public repo | Free; the repo holds code and public map data only |
| Privacy model | Read-only Baserow token entered on the device | No server needed; the public page is an empty shell without the token |
| Data store | Baserow Cloud | Data hosted in Germany (European Union, EU); tokens can be limited per table and per operation |
| Data structure | Two tables: Journey, and Places (one row per station, with its place) | Enough for the map; a table for days at each place may follow |
| Map library | MapLibre GL JS, stored in the repo | Open source, no account, key or tracking |
| Map background | Flat map from Natural Earth with its relief shading, self-hosted | Shows mountains without elevation data; nothing goes to a map provider |
| Route lines | Straight lines between start and end, styled by type | Simplest; approximate railway routes kept as a later option |
| Outside data | Downloaded, processed and checked only in GitHub Actions; only a fixed-format manifest is read | Keeps data that could carry prompt injection away from Claude |
| Workflow | `dev` is the default branch and is published by Pages | Changes are tested on the live page before anything else |

## Requirements

- No live lookups of place names; coordinates are stored in Baserow.
- The app never sends locations to an outside server when used, and never uses the phone's location.
- All text from Baserow is shown as plain text.
- Libraries and map data are stored in the repo at fixed versions, with integrity checks.

## Stages

| Stage | What | Status |
|---|---|---|
| 1 | Access check page | Done |
| 2 | Places and Journey tables in Baserow | Done |
| 3 | The app: journeys as straight lines on a plain background, place and station names, tap cards, journey list, token setup with automatic table lookup | Done |
| 4 | Base map: GitHub Action, output checking script, flat Natural Earth map with relief shading | In progress |
| 5 | "Next up" and checks panel | |
| 6 | Caching and offline use | |
| 7 | Replay, stats and polish | Optional |

## Later options

- **Approximate railway routes:** a small railway network file built once from OpenStreetMap in a GitHub Action; the app traces train journeys along it on the phone.
- **Elevation data:** relief from real heights, colour by height and 3D terrain.
- **Days at each place:** shown on the map from another table.
- **City detail:** a detailed, zoomable street map for each city.
