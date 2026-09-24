# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-09-23

astronomy_get_ephemeris: offset-bearing dates reach Horizons as UTC instants, an out-of-span reply is time_out_of_range with Horizons' bound, and the resolved target_name is echoed; astronomy_get_satellite_passes: a pass rising in the window is followed to its set, and well-known names (ISS, Hubble, Tiangong) resolve via a fixed alias table.

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-09-23 · ⚠️ Breaking

astronomy_find_events: solar_eclipse now searches globally without an observer, reporting the peak location of total/annular eclipses; both eclipse classes gain any-contact local_visible and per-contact altitudes; incomplete_observer replaces observer_required; searches stop at 2100.

## [0.2.10](changelog/0.2.x/0.2.10.md) — 2026-09-19

Adopts mcp-ts-core ^0.12.3 → ^0.13.6: a schema-rejected tool call now carries structuredContent.error, tool errors close with a reason/retryable suffix and a Recovery hint, and a client-injected metadata key is dropped before validation instead of rejecting the call. Skill tree moves to framework-skills/; releases now ship through a release PR.

## [0.2.9](changelog/0.2.x/0.2.9.md) — 2026-08-25 · ⚠️ Breaking

Adopts mcp-ts-core ^0.12.3: a tool call with an argument key the schema doesn't declare is now rejected by name instead of accepted, every tool's outputSchema declares the error envelope, and list operations plus the body resource advertise cache hints. Bun pinned to 1.4.0.

## [0.2.8](changelog/0.2.x/0.2.8.md) — 2026-08-18

astronomy_list_visible's content[] scan line now tails every number, not just distance, growing responses about 1.5x; astronomy_get_sky_position returns the body card inline for solar-system bodies.

## [0.2.7](changelog/0.2.x/0.2.7.md) — 2026-08-18

astronomy_get_rise_set no longer reports a set before its own rise, and fixes two related cursor/twilight bugs; astronomy_stargazing_plan anchors to the requested local night and includes stars; zoneless timestamps now resolve as UTC instead of the server's local zone.

## [0.2.6](changelog/0.2.x/0.2.6.md) — 2026-08-18

astronomy_get_ephemeris now advertises an exclusive resume instant and requests refracted elevation on topocentric queries; astronomy_get_satellite_passes enforces its epoch horizon independently of the SGP4 probe.

## [0.2.5](changelog/0.2.x/0.2.5.md) — 2026-08-18

astronomy_get_satellite_passes now fetches CelesTrak element sets as OMM JSON instead of legacy TLE — reaching six-digit catalog numbers — and resolves an optional `name` input to a catalog ID; a malformed GP record is now distinguished from a retryable CelesTrak outage.

## [0.2.4](changelog/0.2.x/0.2.4.md) — 2026-08-18

astronomy_get_ephemeris and the five core tools now reject calendar dates that don't exist instead of rolling them forward, invalid_time's recovery hint reaches every surface, and the errors[] contracts round out — plus mcp-ts-core ^0.11.5 and other dependency bumps.

## [0.2.3](changelog/0.2.x/0.2.3.md) — 2026-07-30

astronomy_get_ephemeris no longer fails an entire call over a single Horizons row missing a distance; unusable rows are dropped and disclosed instead.

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-07-30

content[] now carries every tool's exact numeric value alongside its rounded display (with one high-volume exception on astronomy_list_visible), and astronomy_stargazing_plan adds the observer-relative moonrise/moonset check its workflow was missing.

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
