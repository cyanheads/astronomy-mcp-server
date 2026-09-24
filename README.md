<div align="center">
  <h1>@cyanheads/astronomy-mcp-server</h1>
  <p><b>What's in the sky, computed offline — planet and moon positions, rise/set, phases, eclipses, and seasons for any place and time via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 1 Resource • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/astronomy-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/astronomy-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/astronomy-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/astronomy-mcp-server/releases/latest/download/astronomy-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=astronomy-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvYXN0cm9ub215LW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22astronomy-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fastronomy-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://astronomy.caseyjhand.com/mcp](https://astronomy.caseyjhand.com/mcp)

</div>

---

## Overview

Observational astronomy computed in-process from [`astronomy-engine`](https://github.com/cosinekitty/astronomy) — sky positions, rise/set and twilight times, moon phases, and eclipse/conjunction/opposition events for any place and time, plus two optional network-backed extensions for small-body ephemerides and satellite passes. List what's visible right now, plan a dark-sky window, or search forward for the next sky event — deterministic and keyless for the five core tools, given the same body, time, and observer. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `astronomy_get_sky_position` | Apparent position of one body or named star for an observer and instant — equatorial (RA/Dec), horizontal (alt/az), ecliptic, plus distance, magnitude, angular diameter, phase, angular distance from the Sun, and constellation. |
| `astronomy_get_rise_set` | Rise, set, and culmination times for a body at a location, with maximum altitude at transit. For the Sun, also the three twilight pairs (civil/nautical/astronomical). |
| `astronomy_get_moon_phase` | Moon phase for an instant: illuminated fraction, phase name, synodic age, phase longitude, and the next four quarter phases with timestamps. |
| `astronomy_find_events` | Forward search for the next occurrences of one sky-event class: eclipses, equinoxes, solstices, moon quarters, oppositions, conjunctions, greatest elongations, and apsides. |
| `astronomy_list_visible` | The one-call "what's up right now" answer: every naked-eye body (and optional bright stars) above the horizon, ranked, annotated, and gated by the Sun's altitude into daylight/twilight/dark. |
| `astronomy_get_ephemeris` | *(gated extension)* Time-series ephemeris for a small body (asteroid/comet) or spacecraft via JPL Horizons — covers what the in-process major-body set cannot. Off by default. |
| `astronomy_get_satellite_passes` | *(gated extension)* Visible passes of a satellite (by NORAD catalog number, or by a name resolved against the catalog) over an observer, from a CelesTrak GP element set propagated with SGP4 in-process. Off by default. |

### Resources

| Resource | Description |
|:---|:---|
| `astronomy://body/{body}` | Static reference card for a solar-system body — canonical name, type, mean radius (km), and naked-eye visibility. `{body}` is one of `sun`, `moon`, `mercury` … `pluto`. |

Also reachable via tools — `astronomy_get_sky_position` returns the same body metadata inline — so tool-only clients lose nothing.

### Prompts

| Prompt | Description |
|:---|:---|
| `astronomy_stargazing_plan` | Structures a "plan tonight's stargazing from \<place\>" workflow, chaining the tools in order and naming the cross-server geocoding and weather steps. |

Design reference: [`docs/design.md`](./docs/design.md).

## Capability reference

### `astronomy_get_sky_position` <sub>tool</sub>

- Target one solar-system body (`body`) or a named bright star (`star`, takes precedence over `body`) — one of the two is required
- `star` draws on a bundled 32-star catalog (about 30 of the brightest stars plus Polaris) by common name or Bayer designation, with the Greek letter spelled out or as a symbol and the constellation as genitive or IAU abbreviation — `Alpha Canis Majoris`, `Alpha CMa`, and `α CMa` all resolve to Sirius; a miss lists every catalog star
- Returns equatorial (RA/Dec), refraction-corrected horizontal (alt/az), and ecliptic coordinates plus distance, magnitude, angular diameter, phase angle, illuminated fraction, `sun_elongation_degrees` (angular distance from the Sun), and constellation in one call
- For a solar-system body, also inlines its `astronomy://body/{body}` reference card (type, mean radius, naked-eye visibility) — absent for a star, which has no card
- `magnitude`, `angular_diameter_arcsec`, `phase_angle_degrees`, and `illuminated_fraction` are `null`, never fabricated, where the engine can't compute them
- Default elevation 0 m, default time now; pass `timezone` for observer-local output alongside UTC

---

### `astronomy_get_rise_set` <sub>tool</sub>

- Searches forward from `start` (default now) and returns the next `count` cycles — default 1, max 31
- For `body: "sun"`, each cycle also carries the three twilight pairs (civil −6°, nautical −12°, astronomical −18°), each covering the night after that cycle's set: `dusk` that evening, `dawn` the following morning — so the dawn listed beside a sunrise is the next day's, and the dawn before it is in the previous cycle
- Circumpolar or never-rises situations return `null` rise/set fields with an explanatory `note`, not an error
- When the body is already up at `start`, that cycle's `rise` is `null` (it precedes the search) so a `set` is never reported earlier than its paired `rise`
- Default elevation 0 m; pass `timezone` for observer-local times alongside UTC

---

### `astronomy_get_moon_phase` <sub>tool</sub>

- Geocentric — no observer location needed
- Returns illuminated fraction, phase name, synodic age in days, and the next four quarter phases (new/first/full/last) in one call
- `phase_longitude_degrees` is the Moon–Sun ecliptic-longitude difference (0 new, 90 first quarter, 180 full, 270 last quarter) — not the Sun–body–observer `phase_angle_degrees` of `astronomy_get_sky_position`, which reads 0 at full moon
- `time` defaults to now; pass `timezone` for observer-local timestamps alongside UTC

---

### `astronomy_find_events` <sub>tool</sub>

- One `event` enum covers nine classes: `solar_eclipse`, `lunar_eclipse`, `equinox`, `solstice`, `moon_quarter`, `opposition`, `conjunction`, `max_elongation`, `perigee_apogee`
- Both eclipse classes take an optional observer (`latitude` and `longitude` together — one alone is rejected):
  - `solar_eclipse` without one returns global eclipses, with the peak's `peak_latitude_degrees`/`peak_longitude_degrees` for total and annular eclipses; with one it returns only eclipses visible from that point, with local contact times
  - `lunar_eclipse` contact times are geocentric either way; an observer adds local circumstances
  - Local circumstances are `local_visible` (the eclipsed body above the horizon at any contact) and `contact_altitudes_degrees` (its altitude at each contact), so a sunrise or sunset eclipse reads differently from a midday one
- Every other class is geocentric and ignores a location
- Body-relative events require `body`, gated to which bodies each applies to: `opposition` to mars through pluto, `conjunction` to any planet, `max_elongation` to mercury or venus, `perigee_apogee` to the moon, earth, or a planet
- Returns the next `count` occurrences, default 1, max 20; searches stop at the end of 2100, and a notice says so when that returns fewer than `count`
- `perigee_apogee` on earth returns perihelion/aphelion; `conjunction` on mercury or venus returns both the inferior and superior pass, labelled by `conjunction_kind`

---

### `astronomy_list_visible` <sub>tool</sub>

- One call for every naked-eye solar-system body (plus, with `include_stars`, the bundled bright stars) above the horizon, ranked brightest-and-highest first
- Each body carries a deterministic `visibility_note` computed from real magnitude and altitude, plus its `sun_elongation_degrees`
- The note states when conditions hide or dim a body — daylight, civil twilight, or within 15° of the Sun (lost in glare); the Sun, the Moon, and a negative-magnitude Venus take no daylight or twilight caveat
- Returns the whole-sky `sky_condition` (`daylight` / `civil_twilight` / `nautical_twilight` / `astronomical_twilight` / `dark`) and the Sun's altitude alongside the list
- `time` is a single evaluation instant, not a window; `min_altitude` (default 0) filters out bodies grazing the horizon
- Default elevation 0 m; pass `timezone` for observer-local times per body

---

### `astronomy_get_ephemeris` <sub>tool</sub>

- Registered only when `ASTRONOMY_ENABLE_HORIZONS` is set; off by default
- Time-series ephemeris for a small body or spacecraft via JPL Horizons — RA/Dec, distance, magnitude, and optional alt/az when observer `latitude`/`longitude` are both supplied (one alone is rejected)
- `designation` should resolve to a single Horizons record: numbered asteroid as `"433;"`, periodic comet as `"DES=1P;CAP"`, spacecraft as a negative SPK-ID — a bare name matching nothing or several records is rejected, and one matching a single object can land on the wrong one (`"Eros"` resolves to Kerberos), so the result carries `target_name`, the object Horizons resolved
- `start`/`stop` accept a `Z` or numeric UTC offset (a value with neither is read as UTC); Horizons receives the resolved UTC instant
- No 1900–2100 limit applies, but a span outside the target's own Horizons data is rejected as `time_out_of_range`, and the message gives the bound Horizons reports (e.g. Mars ends after A.D. 2599-DEC-31); an unknown designation is `body_not_found`
- `step` is a count plus unit (`m`/`h`/`d`/`mo`/`y`, e.g. `"1h"`); `stop` must be after `start` (defaults to a 24h span from now)
- Truncates inline at 200 rows; the truncation notice names the exact `start` to resume from, one step past the last row returned

---

### `astronomy_get_satellite_passes` <sub>tool</sub>

- Registered only when `ASTRONOMY_ENABLE_SATELLITES` is set; off by default
- Identify the satellite by exactly one of `norad_id` or `name` — both or neither is rejected
- `name` resolves the common names ISS / International Space Station (25544), Hubble / Hubble Space Telescope / HST (20580), and Tiangong / CSS / Chinese Space Station (48274) directly; any other name is a case-insensitive substring match against CelesTrak's catalog
- Fetches the current GP element set from CelesTrak and propagates it with SGP4 in-process; only naked-eye-plausible passes (sunlit at peak, observer sky dark) are returned
- A pass must rise inside the window: one already up at `start` is omitted, one still up when the window ends is reported through its set
- `start` must be within about a month of the element set's epoch — older elements no longer describe the orbit, and an element set that won't propagate inside that window is rejected as a reentry
- Searches the next `days` ahead, default 7, max 10; pass `timezone` for observer-local pass times

---

### `astronomy://body/{body}` <sub>resource</sub>

- Static reference card as `application/json`: canonical name, type (`star`/`planet`/`moon`/`dwarf`), mean radius in km, naked-eye visibility
- `{body}` is one of `sun`, `moon`, `mercury` … `pluto`; supports name completion
- Also returned inline by `astronomy_get_sky_position` for solar-system bodies, so tool-only clients lose nothing

---

### `astronomy_stargazing_plan` <sub>prompt</sub>

- Arguments: `location` required; `date` optional (`YYYY-MM-DD`), defaults to tonight
- Returns one user message chaining the five core tools in order — sunset/dusk, moon phase and moon rise/set, then the ranked visible list with `include_stars` on
- Names the cross-server geocoding and weather steps this server doesn't cover, and anchors every step to the observer's local night rather than UTC midnight

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Astronomy-specific:

- Keyless, offline, deterministic core — `astronomy-engine` is the source of truth for positional astronomy; no network, no rate limit, no API key for the five core tools, and the keyless core is pure JS with no native deps
- Positions are accurate to sub-arcminute precision within the engine's ≈1900–2100 span; a `time`/`start` outside that range is rejected as `time_out_of_range`
- Both UTC and observer-local time on every output when a `timezone` is supplied; the server never guesses a timezone from coordinates
- Bundled bright-star catalog so `astronomy_list_visible` and `astronomy_get_sky_position` answer for named stars
- Two gated extensions (off by default) reach beyond the major-body set — JPL Horizons small bodies and CelesTrak satellite passes — each with its own timeout/retry boundary; they degrade loudly and never silently fall back to the core
- Does not geocode — resolve a place name to coordinates upstream (e.g. via an OpenStreetMap server) and pass an IANA `timezone` for observer-local output

Agent-friendly output:

- Preserves uncertainty — magnitude, angular diameter, phase, and illuminated fraction are `null` (never fabricated or zeroed) where the engine can't compute them, and `format()` renders "unavailable" rather than inventing a value
- Deterministic visibility notes — `astronomy_list_visible`'s plain-language headline is computed from real magnitude, altitude, sky condition, and distance from the Sun, never a synthetic confidence score
- Typed error contracts with recovery hints — out-of-range time, missing observer/body, unresolved designation — so callers can correct and retry
- Rounded-plus-exact dual values — `format()` pairs a rounded display figure with its exact counterpart in brackets (e.g. `RA 4.4116 h [4.411597993526305]`), dropped only when the rounding already round-trips, so a `content[]`-only client never needs a second call to recover full precision

## Getting started

### Public Hosted Instance

A public instance is available at `https://astronomy.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "astronomy-mcp-server": {
      "type": "streamable-http",
      "url": "https://astronomy.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file. The five core tools need no configuration; set `ASTRONOMY_ENABLE_HORIZONS` and/or `ASTRONOMY_ENABLE_SATELLITES` to `true` to register the gated extensions.

```json
{
  "mcpServers": {
    "astronomy-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/astronomy-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "astronomy-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/astronomy-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "astronomy-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/astronomy-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key required — both the offline core and the two keyless extensions (JPL Horizons, CelesTrak) need no credentials.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/astronomy-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd astronomy-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment (optional):**

```sh
cp .env.example .env
# edit .env only to enable the gated extensions or override a default
```

## Configuration

All configuration is optional and validated at startup via Zod schemas in `src/config/server-config.ts`. The core runs with no configuration at all.

| Variable | Description | Default |
|:---|:---|:---|
| `ASTRONOMY_ENABLE_HORIZONS` | Register the `astronomy_get_ephemeris` tool (JPL Horizons). | `false` |
| `ASTRONOMY_ENABLE_SATELLITES` | Register the `astronomy_get_satellite_passes` tool (CelesTrak + SGP4). | `false` |
| `ASTRONOMY_HORIZONS_BASE_URL` | Override the JPL Horizons API endpoint. | `https://ssd.jpl.nasa.gov/api/horizons.api` |
| `ASTRONOMY_CELESTRAK_BASE_URL` | Override the CelesTrak GP endpoint. | `https://celestrak.org/NORAD/elements/gp.php` |
| `ASTRONOMY_DEFAULT_TIMEZONE` | Fallback IANA timezone when a tool call omits `timezone`. Unset = UTC-only output. | none |
| `ASTRONOMY_REQUEST_TIMEOUT_MS` | HTTP timeout (ms) for Horizons and CelesTrak requests. | `15000` |
| `ASTRONOMY_TLE_CACHE_TTL_MS` | In-process element-set cache TTL (ms) — respects CelesTrak's refetch guidance (~once/2h). | `7200000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t astronomy-mcp-server .
docker run --rm -e MCP_TRANSPORT_TYPE=stdio astronomy-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/astronomy-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools/resources/prompts and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Five core tools plus two gated extensions. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). Body reference card. |
| `src/mcp-server/prompts` | Prompt definitions (`*.prompt.ts`). Stargazing plan. |
| `src/services/ephemeris` | The offline compute core — `astronomy-engine` wrapper, body-radius table, and bundled bright-star catalog. |
| `src/services/horizons` | JPL Horizons HTTP client (gated extension). |
| `src/services/satellite` | CelesTrak GP/OMM fetch + SGP4 propagation (gated extension). |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources in the `createApp()` arrays in `src/index.ts`
- Normalize raw engine/API values to the domain type; preserve uncertainty as `null` and never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
