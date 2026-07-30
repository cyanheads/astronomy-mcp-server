# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-07-30

astronomy_get_ephemeris dropped its truncation notice and let a lone observer coordinate, backwards time range, or malformed step reach Horizons; astronomy_get_satellite_passes reported a mid-pass start as a false acquisition time and returned an empty pass list for element sets that can't reach the requested window — all fixed.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-07-30

astronomy_find_events opposition/conjunction times were swapped, moon_phase age_days over-reported by ~29.5d after a new moon, and an unsupported event body leaked raw engine errors — all fixed; perigee_apogee now accepts earth, and conjunction reports inferior/superior for mercury and venus.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-28

content[] markdown across get_rise_set, find_events, list_visible, and get_satellite_passes now reads as a rounded human report instead of a raw struct dump; astronomy_stargazing_plan delimits user-supplied location and date as data.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-27

Bug-fix release: topocentric astronomy_get_ephemeris no longer fails with a NaN distance, both gated extension tools reject invalid start times, astronomy_list_visible defaults to naked-eye bodies only, and its sky-condition gate now appears in content[] text.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-25

Initial release of @cyanheads/astronomy-mcp-server — five keyless offline tools (sky position, rise/set, moon phase, events, what's-up list), a body reference resource, a stargazing-plan prompt, and two gated network extensions (JPL Horizons ephemerides, CelesTrak satellite passes).
