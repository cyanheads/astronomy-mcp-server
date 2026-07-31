# astronomy-mcp-server — Design

Observational astronomy computed in-process. Five keyless, offline, deterministic tools wrap
[`astronomy-engine`](https://github.com/cosinekitty/astronomy) (v2.1.19, MIT, zero deps,
sub-arcminute accuracy) to answer "what's in the sky from here, and when." Two optional
extensions add keyless HTTP data sources (JPL Horizons small bodies, CelesTrak satellite
TLEs) behind config flags so the offline core always runs.

This formalizes `docs/idea.md` into a build spec. Tool names are taken verbatim from the
idea sketch — not renamed, added, or dropped.

---

## MCP Surface

### Tools

| Tool | Summary | readOnlyHint | openWorldHint | Key inputs | Output shape |
|---|---|---|---|---|---|
| `astronomy_get_sky_position` | Apparent position of one body for an observer + time: equatorial (RA/Dec), horizontal (alt/az), ecliptic lon/lat, distance, magnitude, angular diameter, phase angle/fraction, constellation. The atomic "where is X right now." Topocentric by default. | `true` | `false` | `body`, `star?`, `latitude`, `longitude`, `elevation?`, `time?`, `timezone?` | single position record |
| `astronomy_get_rise_set` | Rise, set, and culmination (transit) times for a body at a location/date, plus max altitude at transit. For the Sun, also the three twilight pairs (civil/nautical/astronomical). Searches forward from `start`; returns the next `count` cycles (default 1). | `true` | `false` | `body`, `latitude`, `longitude`, `elevation?`, `start?`, `count?`, `timezone?` | array of rise/set/transit events |
| `astronomy_get_moon_phase` | Moon phase for a date: illuminated fraction, phase name, age (days since new), phase angle, and the next four quarter phases (new/first/full/last) with timestamps. | `true` | `false` | `time?`, `timezone?` | phase record + next 4 quarters |
| `astronomy_find_events` | Search upcoming sky events from a start time, consolidated by an `event` enum. For eclipses takes an observer location and reports local visibility + contact times; the rest are geocentric. Returns the next `count` occurrences (default 1). `body` is required for `opposition`, `conjunction`, `max_elongation`, and `perigee_apogee`. | `true` | `false` | `event`, `start?`, `count?`, `body?`, `latitude?`, `longitude?`, `elevation?`, `timezone?` | array of event records |
| `astronomy_list_visible` | Workflow flagship. For a location + instant, iterate every naked-eye body (sun, moon, planets; optional bundled bright stars), compute alt/az, filter to above-horizon, return a ranked "what's up" list with a visibility note. Sun-altitude gate flags daylight/twilight/dark. `time` is a single evaluation instant, not a window — for "tonight" pick a time after astronomical dusk. | `true` | `false` | `latitude`, `longitude`, `elevation?`, `time?`, `timezone?`, `min_altitude?`, `include_stars?` | ranked visible-body list + sky condition |
| `astronomy_get_ephemeris` | *(extension, gated)* Ephemeris for a small body (asteroid/comet) or spacecraft via JPL Horizons. The designation is passed to Horizons verbatim and must resolve to one record: numbered asteroid as `433;` (trailing semicolon), periodic comet as `DES=1P;CAP` (DES + closest-apparition), spacecraft as a negative SPK-ID — a bare name (`433 Eros`, `1P/Halley`) returns no match or an ambiguous record list. RA/Dec, distance, magnitude over a time span. Covers what the major-body set can't. `start`/`stop` are ISO 8601 UTC; `step` is a Horizons step string (e.g. `"1d"`, `"1h"`, `"10m"`). | `true` | `true` | `designation`, `latitude?`, `longitude?`, `elevation?`, `start?`, `stop?`, `step?` | time-series of positions |
| `astronomy_get_satellite_passes` | *(extension, gated)* Visible passes of a satellite (ISS, by NORAD ID) over an observer in the next `days` (default 7). Fetches the TLE from CelesTrak, propagates with SGP4 (offline), returns pass start/peak/end with alt/az; only sunlit-satellite + dark-ground passes are "visible." NORAD IDs are found at celestrak.org or heavens-above.com. | `true` | `true` | `norad_id`, `latitude`, `longitude`, `elevation?`, `days?`, `start?`, `timezone?` | array of visible passes |

Seven tools total. Five form the keyless offline core (always registered); two extensions
register only when their config flag is enabled.

### Resources

| URI Template | Description | Pagination |
|---|---|---|
| `astronomy://body/{body}` | Static reference card for a solar-system body: canonical name, type (star/planet/moon/dwarf), mean radius (km), and whether it's naked-eye visible. `{body}` must be one of the closed enum values (`sun`, `moon`, `mercury` … `pluto`). Injectable context for clients that support resources; mirrors the bundled body table. | none |

One resource. The body table is small and bounded (12 bodies); every datum it exposes is
also reachable through tool output (`astronomy_get_sky_position` returns the same body
metadata inline), so tool-only clients lose nothing. No per-event or per-position resource —
those are query-shaped, not URI-addressable.

### Prompts

| Name | Description | Args |
|---|---|---|
| `astronomy_stargazing_plan` | Structures a "plan tonight's stargazing from <place>" workflow: resolve coordinates, find the twilight window, check moon brightness and whether the moon is above the horizon during it, list visible bodies, and (cross-server) prompt for cloud-cover via a weather server. Emits a message template that chains the tools in order. | `location` (string), `date?` (ISO date) |

One prompt. It encodes the flagship cross-tool + cross-server workflow (see Workflow
Analysis #4) as a reusable template for clients that surface prompts.

---

## Overview

`astronomy-mcp-server` is the `calculator` / `reference-data` pattern applied to the sky: the
server **is** the source of truth for positional astronomy, so the core is keyless, offline,
and deterministic. Given `(body, time, observer)` every core tool returns byte-identical
output — no network, no rate limit, no API key. It computes geometry (where a body is, when
an event happens), not astrophysics.

The compute core wraps `astronomy-engine`, a pure-TypeScript ephemeris library with
sub-arcminute accuracy and zero runtime dependencies. The fleet already has terrestrial
weather (`open-meteo`, `nws`), space *weather* (`noaa-spaceweather`), and dark-sky locations
(`national-parks`), but nothing that answers "what's in the sky." This server fills the
observational-astronomy gap and composes naturally with the weather servers for the full
"is tonight good for stargazing, and what will I see" question.

The primary agent workflows: (1) "what planets and bright objects are visible tonight from
here" — `astronomy_list_visible`, the one-call flagship; (2) "when does the sun/moon rise,
set, and when is it dark" — `astronomy_get_rise_set`; (3) "when is the next full moon /
eclipse / opposition" — `astronomy_get_moon_phase` and `astronomy_find_events`; (4) "where
is Mars right now" — `astronomy_get_sky_position`. Two optional extensions reach beyond the
major-body set: small bodies (comets/asteroids) via JPL Horizons and satellite passes via
CelesTrak TLEs + SGP4.

Observer location (lat/lon + optional elevation) and an ISO 8601 UTC instant are the
universal inputs across every tool. Output carries both UTC and observer-local time; the
caller passes an IANA timezone, or derives one upstream by composing with `reference-data`
(tz lookup) or `openstreetmap` (geocode a place name → coordinates).

## Requirements

**Functional**

- Compute apparent topocentric position (equatorial, horizontal, ecliptic) + magnitude,
  angular diameter, phase, and constellation for Sun, Moon, Mercury–Neptune, Pluto.
- Compute rise/set/culmination and twilight (civil −6°, nautical −12°, astronomical −18°).
- Compute moon phase, illumination, age, and the next four lunar quarters.
- Search forward for nine event classes under one `event` enum: `solar_eclipse`,
  `lunar_eclipse`, `equinox`, `solstice`, `moon_quarter`, `opposition`, `conjunction`,
  `max_elongation`, `perigee_apogee`. Eclipses report observer-local circumstances.
- "What's visible now" workflow: enumerate naked-eye bodies, filter above-horizon, rank,
  annotate with a human-readable visibility note, and gate by sun altitude
  (daylight/twilight/dark).
- Bundle a bright-star subset so the catalog-backed star slots (`DefineStar`) answer for
  named stars in `astronomy_list_visible` and `astronomy_get_sky_position`.
- Extensions (config-gated): JPL Horizons small-body ephemerides; CelesTrak TLE + SGP4
  satellite pass prediction.

**Non-functional**

- Core tools: no network, no auth, no key, fully deterministic. Cloudflare Workers-portable
  (pure JS, no native deps, no DuckDB).
- Times are ISO 8601 UTC on the wire; default elevation 0 m. Output includes observer-local
  time when a timezone is supplied.
- `astronomy-engine` is MIT-licensed — attribute Don Cross in the README/NOTICE; no runtime
  attribution obligation on tool output.
- Extension HTTP sources are keyless but rate-limited and best-effort; they are
  `openWorldHint: true` and must degrade loudly (throw a recovery-bearing error), never
  silently fall back to the core.

**Out of scope (v1)**

- Astrophysics (stellar evolution, spectra, exoplanet physics). Exoplanet archive (NASA TAP)
  is a plausible sibling tool, deferred.
- Deep-sky catalog objects (Messier/NGC galaxies, nebulae) beyond the bright-star subset.
- Light-pollution / Bortle modeling, cloud cover, transparency — those compose from
  `national-parks` and the weather servers, not computed here.
- Historical-only or BCE-range queries beyond `astronomy-engine`'s supported span
  (≈1900–2100 high accuracy).

## Data Model

The wire contracts. `astronomy-engine` returns radians/sidereal-hours in places; the service
layer normalizes to the units below before they reach a schema.

**Observer / time inputs (shared across every tool)**

```ts
latitude:  number   // decimal degrees, [-90, 90].   z.number().min(-90).max(90)
longitude: number   // decimal degrees, [-180, 180]. z.number().min(-180).max(180)
elevation: number   // meters above sea level, default 0. z.number().default(0)
time:      string   // ISO 8601 UTC instant, default "now". z.string().datetime()
timezone:  string   // optional IANA tz, e.g. "America/Los_Angeles". Localizes output.
                    // z.string().optional() — validated at runtime against Intl.supportedValuesOf('timeZone');
                    // unknown tz throws ValidationError with a recovery hint.
```

`Observer` maps 1:1 to `astronomy-engine`'s `new Observer(latitude, longitude, height)`.

**Body identifier** — a closed enum, not a free string:

```ts
type Body =
  | 'sun' | 'moon'
  | 'mercury' | 'venus' | 'mars' | 'jupiter' | 'saturn' | 'uranus' | 'neptune'
  | 'pluto'
// lower-cased on the wire; mapped to astronomy-engine's `Body.Sun` … `Body.Pluto`.
// Named bright stars (e.g. "sirius") are addressed via a separate `star` field where
// supported, resolved through the bundled catalog into a DefineStar slot — NOT folded
// into this enum (the engine's Body enum has only 8 user-star slots).

// When `star` is provided, `body` should be omitted (or the handler treats `star` as
// taking precedence). `star` is a z.string().optional() accepting a common name or
// Bayer designation (e.g. "Sirius", "Alpha Centauri", "Polaris") — matched
// case-insensitively against the bundled catalog. Unknown names throw `body_not_found`.
// Valid only on `astronomy_get_sky_position`; `astronomy_list_visible` uses
// `include_stars` (boolean, default false) to include all catalog stars above the horizon.
```

**SkyPosition** (output of `astronomy_get_sky_position`; per-row in `astronomy_list_visible`):

```ts
{
  body: string;              // echoed identifier
  time_utc: string;          // ISO 8601 UTC
  time_local?: string;       // ISO 8601 with tz offset, present iff timezone supplied
  equatorial: {              // from Equator(body, t, obs, ofdate=true, aberration=true)
    ra_hours: number;        // right ascension, sidereal hours [0,24)
    dec_degrees: number;     // declination [-90,90]
    distance_au: number;     // .dist
  };
  horizontal: {              // from Horizon(t, obs, ra, dec, 'normal')  — refraction-corrected
    altitude_degrees: number;  // .altitude, negative = below horizon
    azimuth_degrees: number;   // .azimuth, 0=N 90=E 180=S 270=W
    above_horizon: boolean;    // altitude > 0
  };
  ecliptic: { longitude_degrees: number; latitude_degrees: number };
  magnitude: number | null;  // Illumination().mag — null for bodies it can't compute
  angular_diameter_arcsec: number | null;  // 2*atan(radius_km / (dist_au*AU_KM)), null for point sources
  phase_angle_degrees: number | null;      // Illumination().phase_angle
  illuminated_fraction: number | null;     // Illumination().phase_fraction, 0..1
  constellation: { abbreviation: string; name: string };  // Constellation(ra, dec)
}
```

**RiseSetEvent** (array element of `astronomy_get_rise_set`):

```ts
{
  rise_utc: string | null;          // SearchRiseSet(dir=+1) → null if no rise in window (circumpolar)
  set_utc: string | null;           // SearchRiseSet(dir=-1) → null if never sets
  transit_utc: string | null;       // SearchHourAngle(hourAngle=0)
  transit_altitude_degrees: number | null;  // max altitude at culmination
  rise_local?: string; set_local?: string; transit_local?: string;  // iff timezone supplied
  // Sun-only, present when body === 'sun':
  twilight?: {
    civil:        { dawn_utc: string | null; dusk_utc: string | null; dawn_local?: string | null; dusk_local?: string | null };  // SearchAltitude(-6)
    nautical:     { dawn_utc: string | null; dusk_utc: string | null; dawn_local?: string | null; dusk_local?: string | null };  // SearchAltitude(-12)
    astronomical: { dawn_utc: string | null; dusk_utc: string | null; dawn_local?: string | null; dusk_local?: string | null };  // SearchAltitude(-18)
    // *_local fields present iff timezone supplied, matching rise_local / set_local pattern
  };
  note?: string;  // e.g. "Circumpolar — never sets at this latitude/date."
}
```

**MoonPhase** (output of `astronomy_get_moon_phase`):

```ts
{
  time_utc: string;
  phase_angle_degrees: number;      // MoonPhase(t), 0=new 90=first 180=full 270=last
  illuminated_fraction: number;     // Illumination(Moon).phase_fraction, 0..1
  phase_name: string;               // derived: New, Waxing Crescent, First Quarter, … Waning Crescent
  age_days: number;                 // days since previous new moon (synodic age)
  next_quarters: Array<{            // SearchMoonQuarter + 3× NextMoonQuarter
    quarter: 'new' | 'first_quarter' | 'full' | 'last_quarter';  // from .quarter index 0..3
    time_utc: string;
    time_local?: string;
  }>;  // length 4
}
```

**EventRecord** (array element of `astronomy_find_events`; shape varies by `event`, discriminated):

```ts
// common: { event: string; time_utc: string; time_local?: string }
// Eclipse contact times are emitted under a `contacts` record (phase → ISO 8601 UTC | null),
// not as flat *_utc fields. Apsis classification is `apsis_kind` (not `kind`, which is the
// eclipse-classification field).
// + per-event detail:
//
//   solar_eclipse  → { kind: 'partial'|'annular'|'total'; obscuration: number|null;
//                    local_visible: boolean; contacts: { partial_begin_utc, peak_utc, partial_end_utc, … } }
//                    // REQUIRES an observer (latitude/longitude) — local circumstances; throws observer_required without it.
//   lunar_eclipse  → { kind: 'penumbral'|'partial'|'total'; obscuration: number|null;
//                      contacts: { penumbral_begin_utc, partial_begin_utc, total_begin_utc, peak_utc, … } }  // geocentric — no observer needed.
//   equinox        → { which: 'march'|'september' }
//   solstice       → { which: 'june'|'december' }
//   moon_quarter   → { quarter: 'new'|'first_quarter'|'full'|'last_quarter' }
//
// Events that REQUIRE input `body` (throws body_required without it):
//   opposition     → { body: string }                         // SearchRelativeLongitude(body, 180)
//   conjunction    → { body: string }                         // SearchRelativeLongitude(body, 0)
//   max_elongation → { body: string; elongation_degrees: number; visibility: 'morning'|'evening' }  // SearchMaxElongation (mercury/venus only; other bodies throw body_not_supported)
//   perigee_apogee → { body: 'moon'|<planet>; apsis_kind: 'perigee'|'apogee'|'perihelion'|'aphelion'; distance_km: number; distance_au: number }
//                    // moon → SearchLunarApsis; planet → SearchPlanetApsis
```

**`astronomy_list_visible` additional inputs (beyond the shared observer/time block):**

```ts
min_altitude: number   // minimum altitude filter in degrees, default 0. z.number().min(-90).max(90).default(0)
                       // Use >0 to skip objects just grazing the horizon (e.g. 5 = require 5° clearance).
include_stars: boolean // include catalog bright stars in the output, default false. z.boolean().default(false)
                       // When true, iterates the bundled Yale BSC / Hipparcos subset and includes
                       // above-horizon entries alongside planets. Allocates DefineStar slots per call.
```

**VisibleBody** (array element of `astronomy_list_visible`) — a `SkyPosition` (above) plus:

```ts
{
  …SkyPosition,
  rank: number;               // 1-based, brightest-and-highest first
  visibility_note: string;    // "Venus, mag -4.1, 12° above the WSW horizon — very bright"
}
// envelope adds:
{
  sky_condition: 'daylight' | 'civil_twilight' | 'nautical_twilight' | 'astronomical_twilight' | 'dark';
  sun_altitude_degrees: number;   // the gate value
}
```

**EphemerisPoint** (element of `astronomy_get_ephemeris` output array):

```ts
{
  time_utc: string;           // ISO 8601 UTC step instant
  ra_hours: number;           // right ascension [0,24)
  dec_degrees: number;        // declination [-90,90]
  distance_au: number;        // observer-to-body distance in AU
  magnitude: number | null;   // apparent magnitude, null when Horizons omits it
  // iff observer supplied:
  altitude_degrees?: number;  // horizontal altitude (refraction-corrected)
  azimuth_degrees?: number;   // azimuth 0=N 90=E 180=S 270=W
}
// envelope:
{
  designation: string;        // echoed input designation
  points: EphemerisPoint[];
}
// Truncation is reported out-of-band via the enrichment block, not in the output object:
//   enrichment: { truncated: boolean; shown: number; cap: number }   // inline row cap = 200
//   When truncated, an enrichment notice advises widening `step` or shortening the span.
```

**SatellitePass** (element of `astronomy_get_satellite_passes` output array):

```ts
{
  rise_utc: string;            // pass AOS (acquisition of signal) — when satellite rises above horizon
  peak_utc: string;            // maximum elevation during pass
  set_utc: string;             // pass LOS (loss of signal)
  rise_local?: string; peak_local?: string; set_local?: string;  // iff timezone supplied
  peak_altitude_degrees: number;  // maximum elevation angle
  rise_azimuth_degrees: number;   // azimuth at AOS
  set_azimuth_degrees: number;    // azimuth at LOS
  peak_azimuth_degrees: number;
  duration_seconds: number;
  sunlit: boolean;             // satellite is in sunlight at peak (naked-eye visible only when true + sky dark)
}
// envelope:
{
  norad_id: number;
  satellite_name?: string;    // from TLE header if available
  passes: SatellitePass[];
}
```

There is no opaque server-minted identifier anywhere. Every input an agent supplies — a body
name, a NORAD ID, a Horizons designation, a lat/lon — is either a closed enum or a
human-known value, so no "how do I obtain this ID" gap exists for the core. The two
extensions take external IDs whose *format* is constrained and whose *source* is named in the
description (NORAD ID from CelesTrak/Heavens-Above; Horizons designation from JPL's
small-body database).

## Services

| Service | Wraps / owns | Key methods | Used by |
|---|---|---|---|
| `EphemerisService` | `astronomy-engine` (in-process, no network) + the bundled bright-star catalog | `position(body, observer, time)`, `riseSet(body, observer, start, count)`, `twilight(observer, date)`, `moonPhase(time)`, `findEvents(event, opts)`, `listVisible(observer, time, opts)`, `defineStar(name)` | all five core tools |
| `HorizonsService` *(gated)* | JPL Horizons HTTP API (`ssd.jpl.nasa.gov/api/horizons.api`, keyless) | `ephemeris(designation, observer, start, stop, step)` | `astronomy_get_ephemeris` |
| `SatelliteService` *(gated)* | CelesTrak TLE fetch (`celestrak.org`, keyless) + SGP4 propagation via `satellite.js` (in-process) | `fetchTle(noradId)`, `predictPasses(tle, observer, days)` | `astronomy_get_satellite_passes` |

- **`EphemerisService`** is the heart and a *server-as-service* — there is no upstream to
  retry; it's pure computation over `astronomy-engine` plus a static catalog. Owns unit
  normalization (radians/sidereal-hours → degrees/hours), the angular-diameter computation
  (from `dist` + a body-radius table), the `phase_name` / `visibility_note` derivations, and
  the `DefineStar` slot management (≤8 stars resolvable at once — `listVisible` and
  `get_sky_position` allocate slots from the catalog as needed). No `ctx.state`, no TTLs,
  nothing crosses requests; the catalog loads once at module init. Init in `setup()`,
  accessed via `getEphemerisService()`.
- **`HorizonsService`** and **`SatelliteService`** are the only network-touching code. Each
  gets its own `fetchWithTimeout` + `withRetry` boundary (base delay ~1–2 s; Horizons can be
  slow). TLEs are cached briefly in-process (CelesTrak asks clients not to refetch the same
  object more than ~once/2h) — a small `Map` keyed by NORAD ID with a TTL, not `ctx.state`,
  since it's global and tenant-independent. Both throw `serviceUnavailable(...)` on
  upstream failure; they never substitute core output.

**No DataCanvas.** Every tool returns a small, bounded, *categorical/positional* result
(one body, ≤~12 visible bodies, the next `count` events, a handful of satellite passes). None
of it is an analytical row set an agent would run SQL over, and result sizes never threaten
the context budget — so no `dataframe_query` tool and no `CANVAS_PROVIDER_TYPE` dependency
(which would also break Workers portability). The extension ephemeris time-series is the
largest payload; it's capped by `step`/span and truncates inline with a disclosed count
rather than spilling.

## Config

`src/config/server-config.ts` — a lazy-parsed Zod schema (`parseEnvConfig`), separate from
framework config. The core needs no configuration at all; every var below is optional.

| Env Var | Required | Default | Purpose |
|---|---|---|---|
| `ASTRONOMY_ENABLE_HORIZONS` | no | `false` | Gate the `astronomy_get_ephemeris` tool. `z.stringbool()`. When false, the tool is not registered. |
| `ASTRONOMY_ENABLE_SATELLITES` | no | `false` | Gate the `astronomy_get_satellite_passes` tool. `z.stringbool()`. |
| `ASTRONOMY_HORIZONS_BASE_URL` | no | `https://ssd.jpl.nasa.gov/api/horizons.api` | Override the JPL Horizons endpoint (testing / mirror). |
| `ASTRONOMY_CELESTRAK_BASE_URL` | no | `https://celestrak.org/NORAD/elements/gp.php` | Override the CelesTrak GP/TLE endpoint. |
| `ASTRONOMY_DEFAULT_TIMEZONE` | no | *(unset)* | Optional fallback IANA tz when a tool call omits `timezone`. Unset = UTC-only output. |
| `ASTRONOMY_REQUEST_TIMEOUT_MS` | no | `15000` | HTTP timeout (ms) for Horizons and CelesTrak requests. `z.coerce.number().default(15000)`. |
| `ASTRONOMY_TLE_CACHE_TTL_MS` | no | `7200000` | In-process TLE cache TTL (ms). Default 2 hours — respects CelesTrak's guidance not to refetch the same object more than ~once/2h. `z.coerce.number().default(7200000)`. |

Use `z.stringbool()` for the boolean gates, never `z.coerce.boolean()` (`Boolean("false")`
is `true`). The two extension tools are conditionally pushed into the `createApp({ tools })`
array based on the gate values, so a default deployment exposes exactly the five keyless core
tools. No API-key var exists — both extension sources are keyless by design.

## Implementation Order

Each step is independently buildable and testable.

1. **Config + server identity.** `server-config.ts` with the gate schema. Set
   `createApp({ name: 'astronomy-mcp-server', title: 'astronomy-mcp-server', websiteUrl,
   description, instructions })`. Remove the echo definitions. Add `astronomy-engine` as a
   dependency.
2. **`EphemerisService`** — the core compute layer: body-name mapping, unit normalization,
   the body-radius table, angular-diameter + `phase_name` + `visibility_note` helpers, and
   `DefineStar` slot management + bright-star catalog loader. Golden-file tests against known
   events (2024-04-08 total solar eclipse, a known full-moon timestamp) anchor this — it's
   the determinism payoff. Build and test this before any tool.
3. **`astronomy_get_sky_position`** — exercises position + magnitude + constellation end to
   end; the simplest tool over the service.
4. **`astronomy_get_moon_phase`** — phase + quarters; small and self-contained.
5. **`astronomy_get_rise_set`** — rise/set/transit + Sun twilight; handles the
   circumpolar/never-sets `null` cases.
6. **`astronomy_find_events`** — the `event`-enum dispatcher; one branch at a time
   (seasons → quarters → eclipses → opposition/conjunction/elongation → apsis).
7. **`astronomy_list_visible`** — composes the service over every body; the flagship.
   Depends on steps 2–3.
8. **`astronomy://body/{body}` resource** + **`astronomy_stargazing_plan` prompt.**
9. **Extensions (gated):** `HorizonsService` → `astronomy_get_ephemeris`, then
   `SatelliteService` (+ `satellite.js` dep) → `astronomy_get_satellite_passes`. Last
   because they add the only network surface and a runtime dependency; the core ships
   without them.
10. **Polish:** `devcheck`, field-test, `tool-defs-analysis`, security-pass, docs/meta.

## Workflow Analysis

The core tools are mostly single-call; the cross-tool dependencies surface in the flagship
workflows and the satellite extension.

**1. "What's visible tonight from Seattle?"** (the flagship, one server call after geocoding)

| # | Call | Purpose | Notes |
|---|---|---|---|
| 0 | `openstreetmap_geocode("Seattle")` *(other server)* | place name → lat/lon | the server does NOT geocode |
| 1 | `astronomy_list_visible(lat, lon, time)` | iterate bodies → filter above-horizon → rank → annotate | internally calls `EphemerisService.position()` per body + the sun-altitude gate; no further hops |

`astronomy_list_visible` is deliberately a one-call workflow tool: the agent supplies
coordinates and gets a ranked, annotated, condition-gated answer without chaining.

**2. "Is the April 2024 eclipse visible from my house, and when?"**

| # | Call | Purpose |
|---|---|---|
| 1 | `astronomy_find_events(event="solar_eclipse", start="2024-01-01", latitude, longitude)` | searches forward; because an observer is supplied, returns local circumstances (visible? partial/total? contact times) |

The `event` enum routes eclipses through the observer-aware path (`SearchLocalSolarEclipse`)
and the geocentric events through the location-free path — one tool, mode-gated by `event`.

**3. "When does the sun set tonight and when is it astronomically dark?"**

| # | Call | Purpose |
|---|---|---|
| 1 | `astronomy_get_rise_set(body="sun", lat, lon, start=today)` | rise/set/transit + the three twilight pairs in one record |

Single call — twilight is bundled into the Sun branch rather than a separate tool, matching
the idea's "when does the sun set and when is it truly dark" framing.

**4. "Plan stargazing from a dark-sky park this weekend"** (cross-server, the prompt's chain)

| # | Call | Purpose |
|---|---|---|
| 1 | `national-parks` *(other server)* | dark-sky park → coordinates |
| 2 | `astronomy_get_rise_set(body="sun", …)` | astronomical-dark window |
| 3 | `astronomy_get_moon_phase(date)` | how bright is the moon? (washes out faint objects) |
| 4 | `astronomy_get_rise_set(body="moon", …)` | is the moon above the horizon during that window? (phase is geocentric and cannot say) |
| 5 | `astronomy_list_visible(lat, lon, time=after dusk)` | what's up once it's dark |
| 6 | `open-meteo` / `nws` *(other server)* | cloud cover + transparency for "good seeing?" |

`astronomy_stargazing_plan` ships this chain as a prompt template.

**5. "When is the ISS visible overhead?"** (satellite extension — the one multi-hop internal flow)

| # | Call | Purpose |
|---|---|---|
| 1 | `SatelliteService.fetchTle(25544)` | CelesTrak GP query → current TLE (cached ≤2h) |
| 2 | SGP4 propagation over `days` | step the orbit, find above-horizon intervals |
| 3 | sun-position check per pass *(in-process, `EphemerisService`)* | keep only sunlit-satellite + dark-ground passes ("visible") |

NORAD ID is the join key the agent supplies; the description names where to get it. The
visibility filter reuses the core sun-altitude logic, so the extension depends on the core
service.

## Design Decisions

- **Keyless offline core is the product; extensions are gated add-ons.** Tools 1–5 require
  no network — host anywhere including Cloudflare Workers. The two extensions add an upstream
  and (for satellites) a runtime dep; config flags keep them off by default so the core
  always runs. Drives the no-DataCanvas, no-API-key, Workers-portable posture.
- **`astronomy_find_events` consolidates nine event classes under one `event` enum** rather
  than nine event-specific tools — mode consolidation per the design skill. Eclipses are the
  one class needing an observer location (local circumstances); the enum routes them through
  the observer-aware path and the rest through the geocentric path within one handler.
- **Closed `body` enum, not a free string.** Maps to `astronomy-engine`'s `Body` enum;
  invalid bodies fail at schema validation (JSON-Schema `enum`), not at runtime. Named bright
  stars ride a separate `star`/`include_stars` path backed by the bundled catalog +
  `DefineStar`, because the engine exposes only 8 user-star slots — folding thousands of
  stars into the body enum would be wrong.
- **Magnitude + a one-line visibility note make the output agent-useful.** Raw RA/Dec is
  correct but inert; attaching apparent magnitude, above/below-horizon, and a human note
  ("Venus, mag −4.1, 12° above the WSW horizon") is what lets an agent answer the real
  question. The service computes these, not the agent.
- **Bundle a bright-star subset (Yale BSC / Hipparcos, a few hundred KB) as a static asset.**
  No upstream, fits the offline ethos, and lets `list_visible` / `get_sky_position` answer
  for named stars via `DefineStar`. Loaded once at init.
- **Both UTC and observer-local time in output; the server does not geocode and does not
  guess the timezone.** Caller supplies `timezone` (IANA), or derives it upstream via
  `reference-data` / `openstreetmap`. Keeps the server a pure compute surface and avoids
  bundling a tz-geometry database. `ASTRONOMY_DEFAULT_TIMEZONE` is an optional deployment
  convenience, not a substitute.
- **`EphemerisService` is server-as-service** — no retry/backoff layer (nothing to retry),
  no `ctx.state` (nothing crosses requests). The resilience table applies only to the two
  extension services, which each carry their own `withRetry` + timeout boundary and degrade
  loudly.
- **Default elevation 0 m; topocentric (parallax-corrected) positions by default.** Matches
  the amateur-astronomer expectation ("where will I actually see it") over geocentric. Uses
  `Equator(..., ofdate=true, aberration=true)` + refraction-corrected `Horizon(...)`.
- **Angular diameter is computed, not primitive.** `astronomy-engine` has no direct
  angular-diameter call, so the service derives it from the returned `distance_au` and a
  small body-radius table; `null` for point-source bodies where it's meaningless.
- **One resource, one prompt, kept minimal.** The body reference card is the only genuinely
  URI-addressable, read-only, injectable datum; the stargazing prompt is the only recurring
  multi-step pattern worth templating. Everything else is query-shaped and belongs in tools.

## Error Contract

Most core tools are simple reads where the framework's auto-classification suffices, but
several have real domain failure modes worth a typed contract (`errors: [{ reason, code,
when, recovery }]`, thrown via `ctx.fail`):

| Tool | reason | code | when |
|---|---|---|---|
| `astronomy_get_sky_position` | `time_out_of_range` | `InvalidParams` | Requested instant is outside `astronomy-engine`'s supported span (high accuracy ≈1900–2100). Recovery: use a date between 1900 and 2100. |
| `astronomy_get_sky_position` | `star_not_found` | `NotFound` | `star` field supplied but the name is not in the bundled catalog. Recovery: check spelling or use a common name / Bayer designation (e.g. "Sirius", "Polaris"). |
| `astronomy_get_rise_set` | `no_event_in_window` | *(not an error — `null` field + `note`)* | Circumpolar / never-rises: surfaced as `null` rise/set with an explanatory `note`, NOT thrown. The agent needs the fact, not a failure. |
| `astronomy_find_events` | `observer_required` | `InvalidParams` | `event` is `solar_eclipse` but `latitude`/`longitude` are not supplied (lunar eclipses are geocentric and need no observer). Recovery: add observer coordinates and retry. |
| `astronomy_find_events` | `body_required` | `InvalidParams` | `event` is one of `opposition`, `conjunction`, `max_elongation`, or `perigee_apogee` but `body` is not supplied. Recovery: add the target body (e.g. `"mars"`) and retry. |
| `astronomy_find_events` | `body_not_supported` | `InvalidParams` | `event` is `max_elongation` but `body` is not mercury or venus. Recovery: use `"mercury"` or `"venus"` — outer planets have no greatest elongation. |
| `astronomy_get_ephemeris` | `body_not_found` | `NotFound` | Horizons has no match for the designation, or a bare comet name is ambiguous. Recovery: use a record-resolving form — `"433;"` (numbered asteroid), `"DES=1P;CAP"` (periodic comet), or a negative SPK-ID; verify at ssd.jpl.nasa.gov. |
| `astronomy_get_ephemeris` | `horizons_unavailable` | `ServiceUnavailable` | Horizons API failed after retries. Retryable. |
| `astronomy_get_satellite_passes` | `tle_not_found` | `NotFound` | CelesTrak has no current element set for the NORAD ID. Recovery: verify the catalog number at celestrak.org; the object may have decayed. |
| `astronomy_get_satellite_passes` | `celestrak_unavailable` | `ServiceUnavailable` | TLE fetch failed after retries. Retryable. |

Two cross-cutting validation gates: (1) `astronomy_find_events` `observer_required` — a
`solar_eclipse` needs observer coordinates for its local circumstances and fails fast rather
than returning data the agent can't use (lunar eclipses are geocentric and skip this gate);
(2) `astronomy_find_events` `body_required` — body-specific events (`opposition`,
`conjunction`, `max_elongation`, `perigee_apogee`) require a `body` and fail fast with a clear
recovery hint naming the valid values. Baseline errors (timeout, generic validation) bubble.

## Output Design Notes

- **Capped lists disclose their counts.** `astronomy_get_rise_set` (`count`) and
  `astronomy_find_events` (`count`) return arrays and emit a `totalCount` enrichment via
  `ctx.enrich.total(n)`. `astronomy_get_ephemeris` (span/`step`) discloses when the inline row
  cap was hit via `ctx.enrich({ truncated, shown, cap })`. `astronomy_list_visible` returns the
  full above-horizon set (bounded at ~12 bodies + optional stars), so no cap, but it carries
  `sky_condition` + `sun_altitude_degrees` (plus `totalCount`) as `enrichment` so both client
  surfaces see the gate.
- **Preserve uncertainty; never fabricate.** `magnitude`, `angular_diameter_arcsec`,
  `phase_angle_degrees`, and `illuminated_fraction` are `null` (not 0, not omitted) for
  bodies where `astronomy-engine` can't compute them. `format()` renders "magnitude:
  unavailable" rather than inventing a value.
- **`format()` is content-complete on every tool.** The markdown twin renders RA/Dec, alt/az,
  magnitude, and the visibility note — not just the body name — so `content[]`-only clients
  (Claude Desktop) see the same picture as `structuredContent` clients (Claude Code). The
  visibility note is the agent's headline; it always appears in both surfaces. Numbers
  carry the same way: a value renders as a rounded display figure with its exact
  counterpart in brackets (`RA 4.4116 h [4.411597993526305]`), dropped when the rounded
  string already round-trips. `astronomy_list_visible` is the exception: tailing all
  eleven coordinates per body grew that surface by ~1.7x on every call, so its scan line
  keeps only the distance's tail — the one value whose display cannot stand in for it,
  spanning 0.0026 AU at the Moon to 1e8 at a catalog star. Any body it lists is
  addressable by name through `astronomy_get_sky_position`, which returns the same field
  set with every exact value.
- **`visibility_note` is server-computed prose, not a fabricated metric.** It's a
  deterministic rendering of real values (magnitude, altitude, compass octant from azimuth) —
  no synthetic "confidence score." The brightness adjective maps from actual magnitude
  thresholds.

## Known Limitations

- **Accuracy span.** `astronomy-engine` is sub-arcminute for ≈1900–2100; queries far outside
  degrade and very-far ones throw `time_out_of_range`. Fine for the audience (planning, not
  historical ephemerides back to antiquity).
- **Major bodies only in the core.** Sun, Moon, Mercury–Neptune, Pluto. Comets, asteroids,
  and spacecraft require the Horizons extension; the core can't see them.
- **Bright stars, not deep sky.** The bundled catalog covers naked-eye stars; no Messier/NGC
  galaxies or nebulae. `DefineStar` caps simultaneous custom stars at 8, so `list_visible`
  allocates slots per call rather than holding the whole catalog resident.
- **No cloud cover / transparency / light pollution.** "Good seeing tonight?" needs the
  weather and dark-sky servers; this server answers only the geometry half.
- **Extension rate limits.** JPL Horizons is slow and unmetered-but-throttled; CelesTrak asks
  clients not to refetch the same object more than ~once/2h (honored via the in-process TLE
  cache). Both extensions are best-effort and `openWorldHint: true`.
- **Timezone is caller-supplied.** Without `timezone` (and no `ASTRONOMY_DEFAULT_TIMEZONE`),
  output is UTC-only; the server won't infer a zone from coordinates.

## v1 Scope vs. Deferred

**v1 (ships):**

- Five keyless offline core tools: `astronomy_get_sky_position`, `astronomy_get_rise_set`,
  `astronomy_get_moon_phase`, `astronomy_find_events`, `astronomy_list_visible`.
- Two config-gated extension tools (off by default): `astronomy_get_ephemeris`,
  `astronomy_get_satellite_passes`.
- One resource (`astronomy://body/{body}`), one prompt (`astronomy_stargazing_plan`).
- Bundled bright-star catalog; both-UTC-and-local output; golden-file determinism tests.

**Deferred:**

- `astronomy_get_exoplanets` over the NASA Exoplanet Archive (keyless TAP) — plausible
  sibling if audience overlap proves out.
- Deep-sky (Messier/NGC) catalog support beyond bright stars.
- Jupiter-moon / Saturn-ring detail (`JupiterMoons`, ring tilt) — `astronomy-engine` supports
  it; not a v1 user goal.
- Light-pollution / Bortle estimation (would need an external dataset).
- Lunar/solar libration, moon-node, and transit-of-Mercury/Venus events — available in the
  engine, deferred until a user goal demands them.