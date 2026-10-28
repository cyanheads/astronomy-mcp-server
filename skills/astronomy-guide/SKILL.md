---
name: astronomy-guide
description: Chain the astronomy_* tools for observing questions — what is up tonight from a place, whether and when a planet can be seen, the next eclipse from a location and how long totality lasts, satellite passes, comet or asteroid positions. Covers anchoring dates to the observer's local night, what each tool means by visible, the Moon's interference, the 1900–2100 span, and the opt-in Horizons and satellite tools.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

- In-process and keyless: the Sun, the Moon, Mercury through Neptune, Pluto, and a 32-star bright-star catalog, for 1900–2100.
- Not covered: deep-sky objects (galaxies, nebulae, clusters), meteor showers, cloud cover, light pollution, aurora. Pair with a weather server for cloud cover and a space-weather server for aurora.
- Two network tools exist only where the deployment enables them: `astronomy_get_ephemeris` (JPL Horizons: asteroids, comets, spacecraft, and major bodies by Horizons ID number) and `astronomy_get_satellite_passes` (CelesTrak element sets).

## Gates

- **Check the tool list before promising an extension answer.** When `astronomy_get_ephemeris` or `astronomy_get_satellite_passes` is not listed, it is switched off on this deployment and a call fails with "Tool … not found". Tell the user the question needs that tool; never approximate a comet position or a satellite pass from the core tools.
- **Anchor a date to the observer's local day.** A bare date (`2026-10-28`) or a UTC-midnight start resolves to 00:00 UTC, which west of Greenwich is the previous local afternoon, so `astronomy_get_rise_set` returns the previous evening's sunset. Pass local midday of the target date, converted to UTC, as `start`: the first Sun cycle then carries that evening's sunset and dusk and the next morning's dawn. Pass `timezone` and confirm the night from the `*_local` fields.
- **Dark starts at astronomical dusk, not sunset.** The dark-sky window runs from astronomical (−18°) dusk to astronomical dawn. In `astronomy_list_visible`, `civil_twilight`, `nautical_twilight`, and `astronomical_twilight` are all brighter than `dark`.
- **`astronomy_list_visible` lists what is above the horizon, not what can be seen.** It returns the Sun in daylight and a planet beside the Sun alike; judge each from `sky_condition` and its `visibility_note` ("daylight, not naked-eye visible", "lost in glare"), never from membership in the list. It never includes Uranus, Neptune, or Pluto, and includes stars only with `include_stars` — ask `astronomy_get_sky_position` for the outer planets.
- **Moon phase does not say whether the Moon is up.** The phase is geocentric. Before calling a night moon-washed or moon-free, get the Moon's rise and set with `astronomy_get_rise_set` over the same night and compare them with the dark window.
- **Outside 1900–2100 every core tool fails `time_out_of_range`.** Where `astronomy_get_ephemeris` is listed, it reaches other dates for a major body by its Horizons ID number — `301` for the Moon, `499` for Mars — returning position, distance, and magnitude (altitude and azimuth with an observer), but no phase name, rise/set, or event search. Without it, the date is out of reach.

Magnitude runs backwards: lower is brighter, negative is very bright, and about 6 is the naked-eye limit under a dark sky.

## Workflows

### Tonight's sky from a place

The `astronomy_stargazing_plan` prompt templates this chain for users.

1. Resolve coordinates and an IANA timezone upstream.
2. `astronomy_get_rise_set` for `sun`, `start` at local midday: sunset, astronomical dusk, and the next astronomical dawn.
3. `astronomy_get_moon_phase` for the illuminated fraction, and `astronomy_get_rise_set` for `moon` with `count` 2 — when the Moon is already up at the start, the first cycle holds only its set and the next rise is in the second — for the hours the Moon is up inside the dark window.
4. `astronomy_list_visible` at an instant after astronomical dusk, with `include_stars` set and a `min_altitude` of about 10 to drop horizon-grazers. It evaluates one instant; a second call before astronomical dawn finds the objects that rise late.
5. Cloud cover and transparency from a weather server.

### Can I see a planet this week?

- `astronomy_get_rise_set` for the planet with `count` 7, read against the Sun's dark window: it shows whether the planet is an evening object, a morning object rising after midnight, or up only in daylight.
- `astronomy_find_events` places it in its cycle: `conjunction` with `body` alone is when it sits beside the Sun, lost in its glare for weeks around that date; `opposition` (Mars through Pluto) is when it is up all night; `max_elongation` is the best showing for Mercury and Venus.
- Confirm a chosen time with `astronomy_list_visible` or `astronomy_get_sky_position`.

### Eclipses

- **From a place**, pass `latitude` and `longitude` to `astronomy_find_events`. `kind`, the times, and the contacts are then what that place sees: an eclipse that is total elsewhere can be partial here. To find the next total eclipse from a place, page through the results and keep those whose `kind` is `total`; a notice that the search reached the end of the supported span before one appears means none through 2100, not never.
- **Totality lasts** from `total_begin_utc` to `total_end_utc` in `contacts`; subtract them. For an annular eclipse the same pair bounds the ring phase; for a partial one both are null.
- **Where it is total**: the global search (no observer) returns at most the point of greatest eclipse. No tool returns the path of totality, so test a specific place with the local search instead of judging from that point.

### Satellites and small bodies

- Tell the user where to look from the visible stretch — `visible_start_utc` to `visible_end_utc` with their altitudes and azimuths — not from rise and set: the satellite can rise in Earth's shadow and only appear partway through the pass.
- `start` must fall within 30 days of the current element set's epoch, before or after it — in practice, roughly the past month or the next month from today. Passes from earlier or further ahead fail `time_out_of_range`.
- For "where will this comet be next month", request a `1d` step across the month with observer coordinates for altitude and azimuth, and confirm `target_name` is the object meant. Rows carry RA/Dec but no constellation.
