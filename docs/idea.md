# astronomy-mcp-server — Idea & Design

Observational astronomy computed **in-process** — no API, no key, deterministic. The core wraps [`astronomy-engine`](https://github.com/cosinekitty/astronomy) (Don Cross, MIT, pure TS, zero deps, sub-arcminute accuracy): apparent positions of the Sun, Moon, and planets; rise/set/culmination; moon phase and illumination; solar and lunar eclipses; equinoxes/solstices; elongations, oppositions, conjunctions, and apsides — all for an arbitrary observer location and time.

This is the `calculator` / `reference-data` pattern applied to the sky: the server **is** the source of truth, so it's keyless, offline, and trivially hostable. The fleet has weather (`open-meteo`, `nws`), space *weather* (`noaa-spaceweather`), and dark-sky locations (`national-parks`) but **nothing that answers "what's in the sky."** This fills the observational-astronomy gap and pairs naturally with the weather servers for "is tonight good for stargazing, and what will I see."

**Audience:** Amateur astronomers, astrophotographers, eclipse chasers, educators, trip planners, and agents answering "what's up tonight from here" — plus anyone needing precise solar/lunar timing (golden-hour, prayer/fasting times, tides context, solar-panel modeling).

## User Goals

- "What planets and bright objects are visible tonight from my location?" (observer-local alt/az + magnitude, above-horizon filter)
- "When does the sun/moon rise and set here? When is astronomical twilight?"
- "When is the next full moon / new moon?" and "what's the moon phase on date X?"
- "When is the next solar or lunar eclipse, and is it visible from my location?"
- "Where is Mars right now?" (topocentric RA/Dec + alt/az for any solar-system body)
- "When are the equinoxes and solstices this year?"
- "When is the next opposition of Jupiter / greatest elongation of Venus?"
- (Extension) "Where is comet/asteroid X?" — JPL Horizons small-body ephemerides
- (Extension) "When is the ISS visible overhead?" — TLE + SGP4 pass prediction

## Compute Core (no upstream)

Everything below is a local function call against `astronomy-engine` — no network, no rate limit, fully deterministic given (body, time, observer). Bodies: Sun, Moon, Mercury–Neptune, Pluto. Observer is lat/lon (+ optional elevation). Times are ISO 8601 UTC; the server localizes output via an observer timezone (compose with `reference-data` for tz lookup).

| Capability | astronomy-engine primitive |
|:-----------|:---------------------------|
| Apparent position (equatorial / ecliptic / horizontal) | `Equator`, `Horizon`, `EclipticGeoMoon` |
| Rise / set / culmination | `SearchRiseSet`, `SearchHourAngle` |
| Twilight (civil/nautical/astronomical) | `SearchAltitude` at −6/−12/−18° |
| Moon phase / illumination / magnitude | `MoonPhase`, `SearchMoonQuarter`, `Illumination` |
| Solar / lunar eclipses (global + local) | `SearchGlobalSolarEclipse`, `SearchLocalSolarEclipse`, `SearchLunarEclipse` |
| Seasons (equinoxes / solstices) | `Seasons` |
| Elongation / opposition / conjunction | `SearchMaxElongation`, `SearchRelativeLongitude` |
| Apsides (perigee/apogee, perihelion/aphelion) | `SearchLunarApsis`, `SearchPlanetApsis` |
| Constellation a body is in | `Constellation` |

## Tool Surface (sketch)

```
astronomy_get_sky_position  — apparent position of one body (sun/moon/planet) for an
                             observer + time. Returns equatorial (RA/Dec), horizontal
                             (altitude/azimuth), ecliptic lon/lat, distance (AU),
                             apparent magnitude, angular diameter, phase angle, and the
                             constellation it's in. The atomic "where is X right now"
                             call. Topocentric (parallax-corrected) by default.

astronomy_get_rise_set      — rise, set, and culmination (transit) times for a body at a
                             location/date, plus max altitude at transit. For the Sun,
                             also returns the three twilight pairs (civil/nautical/
                             astronomical). "When does the sun set and when is it truly
                             dark." Searches forward from a start time; returns next N.

astronomy_get_moon_phase    — moon phase for a date: illuminated fraction, phase name,
                             age (days since new), phase angle, and the next four
                             quarter phases (new/first/full/last) with timestamps.
                             "When is the next full moon" answered without iteration.

astronomy_find_events       — search upcoming sky events from a start time. event enum:
                             solar_eclipse | lunar_eclipse | equinox | solstice |
                             moon_quarter | opposition | conjunction | max_elongation |
                             perigee_apogee. For eclipses, takes an observer location and
                             reports local visibility, magnitude, and contact times.
                             Returns the next N occurrences with timestamps + details.

astronomy_list_visible      — workflow flagship. For a location + time window, iterate
                             every naked-eye body (sun, moon, planets; optionally bundled
                             bright stars), compute alt/az, filter to above-horizon, and
                             return a ranked "what's up" list with altitude, azimuth,
                             magnitude, and a visibility note (e.g. "low in the WSW, mag
                             −4.1, very bright"). Sun-altitude gate flags daylight/
                             twilight/dark. The "what can I see tonight" answer in one call.

—— extensions (optional keyless data sources) ——

astronomy_get_ephemeris     — ephemeris for a small body (asteroid/comet) or spacecraft
                             via JPL Horizons. Designations like "433 Eros", "1P/Halley",
                             or SPK-ID. Returns RA/Dec, distance, magnitude over a time
                             span. Covers what astronomy-engine's major-body set can't.

astronomy_get_satellite_passes — visible passes of a satellite (ISS, by NORAD ID) over an
                             observer in the next N days. Fetches the TLE from CelesTrak,
                             propagates with SGP4 (satellite.js, offline), and returns
                             pass start/peak/end with alt/az and illumination (only
                             sunlit-satellite + dark-ground passes are "visible").
```

## Design Notes

- **The core is the product.** Tools 1–5 require no network at all — host it anywhere, including Cloudflare Workers (pure JS, no native deps). The extensions add an upstream and a key-free HTTP dependency; gate them behind config so the keyless offline core always runs.
- **Observer + time are the universal inputs.** Standardize on lat/lon/elevation + ISO 8601 UTC across every tool; default elevation 0 m. Output both UTC and observer-local time (take an IANA tz, or compose with `reference-data` / `openstreetmap` to derive it from coordinates).
- **Magnitude and "visibility" make the output agent-useful.** Raw RA/Dec is correct but inert; attaching apparent magnitude, above/below horizon, and a one-line human note ("Venus, mag −4.1, 12° above the WSW horizon") is what lets an agent answer the actual question.
- **`find_events` consolidates by an `event` enum** rather than shipping nine event-specific tools — mode consolidation per the design skill. Eclipses are the one event that needs an observer location (local circumstances); the rest are geocentric.
- **Bundle a bright-star catalog** (Yale BSC / Hipparcos subset, ~9k stars, a few hundred KB) so `list_visible` and `get_sky_position` can answer for named stars/constellations via `astronomy-engine`'s `DefineStar`. Static asset, no upstream — fits the offline ethos.
- **Determinism is a feature for tests.** Same inputs → byte-identical output; golden-file tests against known events (e.g. the 2024-04-08 total solar eclipse path, known full-moon timestamps) are cheap and strong.
- **Framing:** observational/positional astronomy, not astrophysics. It computes geometry (where/when), not stellar physics. Keep `arxiv` (astro papers) and a future exoplanet surface as separate concerns — though `astronomy_get_exoplanets` over the NASA Exoplanet Archive (keyless TAP) is a plausible sibling tool if the audience overlaps.
- **Composes with** `open-meteo` / `nws` (cloud cover + transparency for "good seeing tonight?"), `national-parks` (dark-sky park coordinates), `openstreetmap` (geocode a place name → lat/lon), `reference-data` (timezone, unit conversion).
- README one-liner: "What's in the sky, computed offline — planet and moon positions, rise/set, phases, and eclipses for any place and time."
