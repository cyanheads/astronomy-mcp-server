<div align="center">
  <h1>@cyanheads/astronomy-mcp-server</h1>
  <p><b>What's in the sky, computed offline — planet and moon positions, rise/set, phases, eclipses, and seasons for any place and time via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 1 Resource • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/astronomy-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/astronomy-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/astronomy-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Observational astronomy computed in-process by [`astronomy-engine`](https://github.com/cosinekitty/astronomy) and a bundled bright-star catalog. Get sky positions, rise/set and twilight times, moon phases, and the next eclipse, equinox, opposition, or conjunction for any place and time, or ask what is visible right now. Two opt-in, network-backed tools add JPL Horizons small-body ephemerides and CelesTrak satellite passes. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `astronomy_get_sky_position` | Apparent position of one body or named star: RA/Dec, alt/az, ecliptic, magnitude, phase, Sun elongation, constellation |
| `astronomy_get_rise_set` | Rise, set, and transit times for a body, plus civil, nautical, and astronomical twilight for the Sun |
| `astronomy_get_moon_phase` | Illuminated fraction, phase name, synodic age, and the next four quarter phases |
| `astronomy_find_events` | Next eclipses, equinoxes, solstices, moon quarters, oppositions, conjunctions, greatest elongations, or apsides |
| `astronomy_list_visible` | What's up now: naked-eye bodies (and optional bright stars) above the horizon, ranked, with a sky-condition gate |
| `astronomy_get_ephemeris` | Small-body or spacecraft ephemeris from JPL Horizons (opt-in) |
| `astronomy_get_satellite_passes` | Visible satellite passes from a CelesTrak element set propagated with SGP4 (opt-in) |

### Resources

| Resource | Description |
|:---|:---|
| `astronomy://body/{body}` | Reference card for a solar-system body: name, type, mean radius, naked-eye visibility |

Tool-only clients get the same type, radius, and naked-eye fields inline from `astronomy_get_sky_position`.

### Prompts

| Prompt | Description |
|:---|:---|
| `astronomy_stargazing_plan` | Plan a night of stargazing from a place, chaining the astronomy tools with geocoding and weather steps |

Design reference: [`docs/design.md`](./docs/design.md).

## Capability reference

### `astronomy_get_sky_position` <sub>tool</sub>

- `body` (`sun`, `moon`, `mercury` … `pluto`) or `star` is required, with `star` winning when both are set; `star` resolves against a bundled 32-star catalog by common name or Bayer designation (`Sirius`, `α CMa`), and a miss fails as `star_not_found` listing the catalog
- Returns `equatorial`, refraction-corrected `horizontal`, and `ecliptic` coordinates plus `magnitude`, `angular_diameter_arcsec`, `phase_angle_degrees`, `illuminated_fraction`, `sun_elongation_degrees`, and `constellation`
- Solar-system bodies also carry `body_metadata`, the resource card's `type`, `mean_radius_km`, and `naked_eye`; a star has none

---

### `astronomy_get_rise_set` <sub>tool</sub>

- One `body` searched forward from `start` (default now) for the next `count` cycles, default 1, max 31
- Each cycle carries `rise_utc`, `set_utc`, `transit_utc`, and `transit_altitude_degrees`; a circumpolar or never-rising body gets `null` rise/set and a `note` instead of an error, and one already up at `start` gets a `null` `rise_utc`
- For `body: "sun"`, a `twilight` block holds `civil`, `nautical`, and `astronomical` pairs covering the night after that cycle's set, so each `dawn_utc` falls the day after the cycle's rise

---

### `astronomy_get_moon_phase` <sub>tool</sub>

- Geocentric: takes only `time` (default now) and an optional `timezone`
- Returns `illuminated_fraction`, `phase_name`, `age_days`, `next_quarters`, and `phase_longitude_degrees` (0 new, 180 full), which is not the `phase_angle_degrees` of `astronomy_get_sky_position`

---

### `astronomy_find_events` <sub>tool</sub>

- One `event` (`solar_eclipse`, `lunar_eclipse`, `equinox`, `solstice`, `moon_quarter`, `opposition`, `conjunction`, `max_elongation`, `perigee_apogee`) and the next `count` occurrences, default 1, max 20; searches stop at the end of 2100, with a notice when that returns fewer
- Body-relative events require `body` (`body_required`), and a body the event doesn't apply to fails as `body_not_supported`: `opposition` takes mars through pluto, `conjunction` any planet, `max_elongation` mercury or venus, and `perigee_apogee` the moon, `earth`, or a planet; `apsis_kind` and `conjunction_kind` label which kind came back
- Eclipses take an optional observer (`latitude` and `longitude` together, else `incomplete_observer`) that adds `local_visible` and `contact_altitudes_degrees` and limits `solar_eclipse` to locally visible events; a global solar search reports `peak_latitude_degrees`/`peak_longitude_degrees` for total and annular eclipses

---

### `astronomy_list_visible` <sub>tool</sub>

- Observer coordinates and one evaluation instant, `time` (default now, not a window); `min_altitude` (default 0) and `include_stars` (default false) shape the list
- Returns `sky_condition` (`daylight`, `civil_twilight`, `nautical_twilight`, `astronomical_twilight`, `dark`), `sun_altitude_degrees`, and `bodies` ranked brightest-and-highest first, each with a `visibility_note` that says when daylight, civil twilight, or Sun glare within 15° hides or dims it

---

### `astronomy_get_ephemeris` <sub>tool</sub>

- `designation` is passed to Horizons verbatim (`"433;"` for a numbered asteroid, `"DES=1P;CAP"` for a periodic comet, a negative SPK-ID for a spacecraft); `start` defaults to now, `stop` to 24 h later, and `step` to `"1h"` (a count plus `m`, `h`, `d`, `mo`, or `y`); `latitude` and `longitude` together add alt/az
- Up to 200 rows inline, and when `truncated` is true the notice names the `start` to resume from; `target_name` is the object Horizons resolved, since a bare name can land on the wrong one; misses fail as `body_not_found`, and spans outside the target's Horizons data as `time_out_of_range`
- Registered only when `ASTRONOMY_ENABLE_HORIZONS=true`

---

### `astronomy_get_satellite_passes` <sub>tool</sub>

- Exactly one of `norad_id` or `name` (ISS, Hubble/HST, and Tiangong/CSS resolve directly; other names are substring-matched against CelesTrak, and an ambiguous one fails as `ambiguous_satellite_name` listing candidates); `start` must be within about a month of today, and `days` defaults to 7, max 10
- Returns `norad_id`, `satellite_name`, and naked-eye-plausible `passes` (sunlit at peak, observer sky dark), each with rise/peak/set times and azimuths, `peak_altitude_degrees`, and `duration_seconds`
- Registered only when `ASTRONOMY_ENABLE_SATELLITES=true`

---

### `astronomy://body/{body}` <sub>resource</sub>

- `{body}` is one of `sun`, `moon`, `mercury` … `pluto`, with name completion; anything else fails as `unknown_body`
- `application/json` card with `body`, `name`, `type` (`star`/`planet`/`moon`/`dwarf`), `mean_radius_km`, and `naked_eye`

---

### `astronomy_stargazing_plan` <sub>prompt</sub>

- Arguments: `location` required; `date` (`YYYY-MM-DD`) optional, defaults to tonight
- Returns one user message that chains `astronomy_get_rise_set` (sun, then moon), `astronomy_get_moon_phase`, and `astronomy_list_visible` with `include_stars`, anchored to the observer's local night, plus the geocoding and weather steps this server doesn't cover

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Astronomy-specific:

- Keyless, offline, deterministic core: the five core tools need no network, API key, or rate limit, and return the same answer for the same body, time, and observer
- Times outside the engine's high-accuracy span (≈1900–2100) fail as `time_out_of_range`; the Horizons tool is bounded by each target's own data span instead
- Times are ISO 8601 UTC, and a value with no zone is read as UTC; pass an IANA `timezone` (or set `ASTRONOMY_DEFAULT_TIMEZONE`) to get `*_local` fields alongside UTC. The server never infers a timezone from coordinates
- No geocoding: resolve a place name to latitude/longitude and a timezone upstream, then pass the coordinates (`elevation` defaults to 0 m)
- The two opt-in extensions each carry their own timeout and retry; an upstream failure surfaces as `horizons_unavailable` or `celestrak_unavailable` and never falls back to core output

Agent-friendly output:

- Uncertainty preserved: `magnitude`, `angular_diameter_arcsec`, `phase_angle_degrees`, and `illuminated_fraction` are `null` where the engine can't compute them, rendered as "unavailable", never zeroed
- Deterministic visibility notes: `visibility_note` comes from real magnitude, altitude, sky condition, and Sun elongation, not a synthetic score
- Typed error contracts: each declared failure carries a typed `reason` and a recovery hint, so callers can correct and retry
- Exact values behind rounded text: `format()` pairs each rounded figure with its exact value in brackets (`RA 4.4116 h [4.411597993526305]`), so a `content[]`-only client loses no precision

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

Add the following to your MCP client configuration file. The core tools need no configuration; set `ASTRONOMY_ENABLE_HORIZONS` and/or `ASTRONOMY_ENABLE_SATELLITES` to `true` to register the extensions.

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
- No API key. The core is offline, and both extensions (JPL Horizons, CelesTrak) are keyless.

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
# edit .env only to enable the extensions or override a default
```

## Configuration

Every variable is optional; the core runs with none set.

| Variable | Description | Default |
|:---|:---|:---|
| `ASTRONOMY_ENABLE_HORIZONS` | Register `astronomy_get_ephemeris` (JPL Horizons). | `false` |
| `ASTRONOMY_ENABLE_SATELLITES` | Register `astronomy_get_satellite_passes` (CelesTrak + SGP4). | `false` |
| `ASTRONOMY_DEFAULT_TIMEZONE` | Fallback IANA timezone when a call omits `timezone`. Unset means UTC-only output. | none |
| `ASTRONOMY_REQUEST_TIMEOUT_MS` | HTTP timeout for Horizons and CelesTrak requests, in ms. | `15000` |
| `ASTRONOMY_TLE_CACHE_TTL_MS` | In-process element-set cache TTL, in ms. The 2 h default follows CelesTrak's refetch guidance. | `7200000` |
| `ASTRONOMY_HORIZONS_BASE_URL` | JPL Horizons API endpoint. | `https://ssd.jpl.nasa.gov/api/horizons.api` |
| `ASTRONOMY_CELESTRAK_BASE_URL` | CelesTrak GP endpoint. | `https://celestrak.org/NORAD/elements/gp.php` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

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
docker run --rm -p 3010:3010 astronomy-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/astronomy-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools/resources/prompts and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Five core tools plus two opt-in extensions. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). Body reference card. |
| `src/mcp-server/prompts` | Prompt definitions (`*.prompt.ts`). Stargazing plan. |
| `src/services/ephemeris` | Offline compute core — `astronomy-engine` wrapper, body table, bright-star catalog. |
| `src/services/horizons` | JPL Horizons HTTP client (extension). |
| `src/services/satellite` | CelesTrak element-set fetch and SGP4 propagation (extension). |
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
