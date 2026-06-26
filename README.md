<div align="center">
  <h1>@cyanheads/astronomy-mcp-server</h1>
  <p><b>What's in the sky, computed offline — planet and moon positions, rise/set, phases, eclipses, and seasons for any place and time via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 1 Resource • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/astronomy-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/astronomy-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/astronomy-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/astronomy-mcp-server/releases/latest/download/astronomy-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=astronomy-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvYXN0cm9ub215LW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22astronomy-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fastronomy-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Seven tools — five form the keyless, offline, deterministic core (always registered); two are network-backed extensions that register only when their config gate is enabled.

| Tool | Description |
|:---|:---|
| `astronomy_get_sky_position` | Apparent position of one body or named star for an observer and instant — equatorial (RA/Dec), horizontal (alt/az), ecliptic, plus distance, magnitude, angular diameter, phase, and constellation. |
| `astronomy_get_rise_set` | Rise, set, and culmination times for a body at a location, with maximum altitude at transit. For the Sun, also the three twilight pairs (civil/nautical/astronomical). |
| `astronomy_get_moon_phase` | Moon phase for an instant: illuminated fraction, phase name, synodic age, phase angle, and the next four quarter phases with timestamps. |
| `astronomy_find_events` | Forward search for the next occurrences of one sky-event class: eclipses, equinoxes, solstices, moon quarters, oppositions, conjunctions, greatest elongations, and apsides. |
| `astronomy_list_visible` | The one-call "what's up right now" answer: every naked-eye body (and optional bright stars) above the horizon, ranked, annotated, and gated by the Sun's altitude into daylight/twilight/dark. |
| `astronomy_get_ephemeris` | *(gated extension)* Time-series ephemeris for a small body (asteroid/comet) or spacecraft via JPL Horizons — covers what the in-process major-body set cannot. Off by default. |
| `astronomy_get_satellite_passes` | *(gated extension)* Visible passes of a satellite (by NORAD ID) over an observer, from a CelesTrak TLE propagated with SGP4 in-process. Off by default. |

This server computes geometry — where a body is, when an event happens — not astrophysics. The core wraps [`astronomy-engine`](https://github.com/cosinekitty/astronomy) (sub-arcminute accuracy, ≈1900–2100), so given the same `(body, time, observer)` every core tool returns identical output with no network, no rate limit, and no API key. It does not geocode: resolve a place name to latitude/longitude upstream (e.g. via an OpenStreetMap server) and pass an IANA `timezone` to receive observer-local times alongside UTC.

### `astronomy_get_sky_position`

Apparent topocentric position of one solar-system body or a named bright star.

- Equatorial (RA/Dec), refraction-corrected horizontal (altitude/azimuth), and ecliptic coordinates in one call
- Distance, apparent magnitude, angular diameter, phase angle, illuminated fraction, and the constellation the body falls in
- Parallax- and aberration-corrected for the observer; default elevation 0 m, default time now
- Supply `star` (e.g. `"Sirius"`, `"Polaris"`) instead of `body` to target a catalog star; `star` takes precedence over `body`
- `null` magnitude / angular diameter / phase fields where the engine cannot compute them — never fabricated

---

### `astronomy_get_rise_set`

Rise, set, and culmination times, with twilight for the Sun.

- Searches forward from `start` and returns the next `count` cycles (default 1, max 31)
- For `body: "sun"`, bundles the three twilight pairs (civil −6°, nautical −12°, astronomical −18°) so a single call answers "when does the sun set and when is it truly dark"
- Circumpolar / never-rises situations are reported as `null` rise/set fields with an explanatory `note` rather than an error — the fact is the answer
- Optional observer-local times when an IANA `timezone` is supplied

---

### `astronomy_find_events`

Forward search across nine event classes under one `event` enum.

- `solar_eclipse`, `lunar_eclipse`, `equinox`, `solstice`, `moon_quarter`, `opposition`, `conjunction`, `max_elongation`, `perigee_apogee`
- Solar eclipses require an observer (`latitude`/`longitude`) and report local visibility and contact times; lunar eclipses are geocentric and need no location
- The body-relative events (`opposition`, `conjunction`, `max_elongation`, `perigee_apogee`) require a `body`; `max_elongation` is defined only for mercury and venus
- Returns the next `count` occurrences (default 1, max 20)

---

### `astronomy_list_visible`

The workflow flagship — one call returns a ranked, condition-gated "what's up" list.

- Iterates every naked-eye solar-system body (and, with `include_stars`, the bundled bright stars), keeps those above the horizon, and ranks them brightest-and-highest first
- Attaches a plain-language `visibility_note` to each body, computed from real magnitude and altitude — no synthetic score
- Returns the whole-sky condition (`daylight` / `civil_twilight` / `nautical_twilight` / `astronomical_twilight` / `dark`) and the Sun's altitude alongside the list
- `time` is a single evaluation instant, not a window — for "tonight" pass a time after astronomical dusk (use `astronomy_get_rise_set` on the Sun to find it)
- Use `min_altitude` to skip objects grazing the horizon

---

### `astronomy_get_ephemeris` *(gated extension)*

Time-series ephemeris for a small body or spacecraft via the keyless JPL Horizons API. Registered only when `ASTRONOMY_ENABLE_HORIZONS` is set.

- Covers asteroids, comets, and spacecraft the in-process major-body engine cannot see
- The designation is passed to Horizons verbatim and must resolve to a single record:
  - **Numbered asteroid** — trailing-semicolon record lookup: `"433;"` (Eros), `"1;"` (Ceres)
  - **Periodic comet** — DES + closest-apparition flag: `"DES=1P;CAP"` (Halley), `"DES=2P;CAP"` (Encke)
  - **Spacecraft** — negative SPK-ID: `"-48"` (Hubble)
  - A bare name like `"433 Eros"` or `"1P/Halley"` returns no match or an ambiguous record list and is rejected. Look up designations at [ssd.jpl.nasa.gov/tools/sbdb_lookup.html](https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html).
- `start`/`stop` are ISO 8601 UTC; `step` is a Horizons step string (`"1d"`, `"1h"`, `"10m"`)
- Supplying observer `latitude`/`longitude` yields topocentric coordinates and adds alt/az
- Large spans truncate inline at 200 rows with a disclosure — widen the step to reduce rows

---

### `astronomy_get_satellite_passes` *(gated extension)*

Visible passes of a satellite over an observer. Registered only when `ASTRONOMY_ENABLE_SATELLITES` is set.

- Fetches the current TLE from CelesTrak by NORAD catalog number (e.g. `25544` for the ISS) and propagates it with SGP4 in-process
- Returns each pass's rise, peak, and set times with azimuths and the peak elevation
- Only naked-eye-plausible passes are returned — the satellite must be sunlit at peak while the observer's sky is dark
- NORAD catalog numbers are found at [celestrak.org](https://celestrak.org) or [heavens-above.com](https://heavens-above.com)
- Searches the next `days` (default 7, max 10); optional observer-local pass times

## Resources and prompts

| Type | Name | Description |
|:---|:---|:---|
| Resource | `astronomy://body/{body}` | Static reference card for a solar-system body — canonical name, type, mean radius (km), and naked-eye visibility. `{body}` is one of `sun`, `moon`, `mercury` … `pluto`. |
| Prompt | `astronomy_stargazing_plan` | Structures a "plan tonight's stargazing from \<place\>" workflow, chaining the tools in order and naming the cross-server geocoding and weather steps. |

All resource data is also reachable via tools — `astronomy_get_sky_position` returns the same body metadata inline — so tool-only clients lose nothing. Design reference: [`docs/design.md`](./docs/design.md).

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool, resource, and prompt definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports; the keyless core is Cloudflare Workers-portable (pure JS, no native deps)

Astronomy-specific:

- Keyless, offline, deterministic core — `astronomy-engine` is the source of truth for positional astronomy; no network, no rate limit, no API key for the five core tools
- Both UTC and observer-local time on every output when a `timezone` is supplied; the server never guesses a timezone from coordinates
- Bundled bright-star catalog so `astronomy_list_visible` and `astronomy_get_sky_position` answer for named stars
- Two gated extensions (off by default) reach beyond the major-body set — JPL Horizons small bodies and CelesTrak satellite passes — each with its own timeout/retry boundary; they degrade loudly and never silently fall back to the core

Agent-friendly output:

- Preserves uncertainty — magnitude, angular diameter, phase, and illumination are `null` (not 0, not omitted) when unavailable, and `format()` renders "unavailable" rather than inventing a value
- Server-computed visibility notes are deterministic prose from real magnitude and altitude — no synthetic confidence scores
- Typed error contracts with recovery hints (out-of-range time, missing observer/body, unresolved designation) so callers can correct and retry
- `format()` is content-complete on every tool — `content[]`-only clients see the same data as `structuredContent` clients

## Getting started

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

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
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

## Configuration

All configuration is optional and validated at startup via Zod schemas in `src/config/server-config.ts`. The core runs with no configuration at all.

| Variable | Description | Default |
|:---|:---|:---|
| `ASTRONOMY_ENABLE_HORIZONS` | Register the `astronomy_get_ephemeris` tool (JPL Horizons). | `false` |
| `ASTRONOMY_ENABLE_SATELLITES` | Register the `astronomy_get_satellite_passes` tool (CelesTrak + SGP4). | `false` |
| `ASTRONOMY_HORIZONS_BASE_URL` | Override the JPL Horizons API endpoint. | `https://ssd.jpl.nasa.gov/api/horizons.api` |
| `ASTRONOMY_CELESTRAK_BASE_URL` | Override the CelesTrak GP/TLE endpoint. | `https://celestrak.org/NORAD/elements/gp.php` |
| `ASTRONOMY_DEFAULT_TIMEZONE` | Fallback IANA timezone when a tool call omits `timezone`. Unset = UTC-only output. | none |
| `ASTRONOMY_REQUEST_TIMEOUT_MS` | HTTP timeout (ms) for Horizons and CelesTrak requests. | `15000` |
| `ASTRONOMY_TLE_CACHE_TTL_MS` | In-process TLE cache TTL (ms) — respects CelesTrak's refetch guidance (~once/2h). | `7200000` |
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
| `src/services/satellite` | CelesTrak TLE fetch + SGP4 propagation (gated extension). |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources in the `createApp()` arrays in `src/index.ts`
- Normalize raw engine/API values to the domain type; preserve uncertainty as `null` and never fabricate missing fields

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
