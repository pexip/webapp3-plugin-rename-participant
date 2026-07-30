# Design: Robust shared rename state + persistent self-name

**Date:** 2026-07-29
**Status:** Approved (pending spec review)

## Background

The plugin makes a chair-assigned participant name "sticky" across rooms by
remembering it in an in-memory `Map<identity, name>` (keyed by a stable
identity — `uri`, falling back to display name, then uuid) and re-applying the
overlay text when the participant reappears in any room. Setting the overlay on
a breakout participant uses the undocumented `plugin.conference.sendRequest`
against the breakout-scoped `overlaytext` endpoint (`setTextOverlay` targets the
main room only). See the earlier design and the breakout debugging for details.

Two gaps remain:

1. The map lives only in the **renaming chair's** browser. If a different chair
   performs a breakout move, or the renaming chair reloads/joins late, the name
   is not re-applied.
2. When a user renames **themselves**, the name is not remembered for their next
   session — they rejoin under whatever the join screen supplies.

## Goals

- **Feature 1 — Robust shared state:** any chair present can re-apply an assigned
  name, and a reloaded or late-joining chair picks up names already assigned,
  without a cross-client message protocol.
- **Feature 2 — Persistent self-name (chairs only):** when a chair renames
  themselves, remember it so their next join uses that name.

## Feature 1 — Learn from observed overlay

**Key insight:** Infinity persists an assigned name server-side as the
participant's `overlay_text` and pushes it to **every** connected client. So the
shared state already exists on the server; each plugin instance can reconstruct
its map by observing it. The participant's *real* name is available separately as
`participant.rawData.display_name` (the mapped `participant.displayName` mirrors
the overlay once set and cannot be used for this comparison).

### Learn rule

In the `participantsActivities` handler, for each `Join`/`Update` activity in any
room, before the re-apply step, run:

```ts
if (
  participant.overlayText !== '' &&
  participant.overlayText !== participant.rawData.display_name
) {
  renamedNames.set(getIdentity(participant), participant.overlayText)
}
```

Effects:

- **Multi-chair:** every chair observes the overlay while it is set in the main
  room and learns `identity → name`, so any chair can later restore it.
- **Reload / late join:** the initial participant snapshot (Join activities on
  connect) carries the current `overlay_text`, seeding the map automatically.

### Re-apply rule

Unchanged from the current implementation (`reapplyName`): if the map has a name
for the participant's identity and it differs from the current `overlayText`,
re-apply — via `setTextOverlay` in the main room, or `sendRequest` to
`breakouts/{roomId}/participants/{uuid}/overlaytext` in a breakout.

Ordering is naturally correct within a single activity:

- Overlay currently **set** (custom): learn it; the re-apply guard then sees
  `overlayText === desired` → no-op.
- Overlay **reset** (equals real name): learn does nothing; re-apply restores
  from the previously-learned map.

### Placement and gating

The learn rule and the re-apply run inside the existing chair-gated block
(`userParticipant?.role === 'chair'`). Guests never re-apply, so they do not need
to learn.

### Accepted consequences

- With multiple chairs, more than one may fire the restore POST at nearly the
  same time; all are idempotent `200`s. No leader election.
- The learn rule treats "overlay text differs from the real display name" as an
  assigned name, so it will also adopt an overlay set by other means as sticky.
  This is benign — the plugin simply preserves whatever name is displayed.

## Feature 2 — Persist self-name to webapp3 storage

WebApp3 (v41+) stores the join display name in `localStorage` under the key
`infinity-connect:displayName` as a JSON-encoded string (e.g. `"Bert3"`). The
plugin is served from the same origin as webapp3 and runs in an
`allow-same-origin` iframe, so it can read/write this key.

### Write rule

When the local user renames **themselves** — the clicked participant resolves to
the same identity as `userParticipant` — additionally persist the new name:

```ts
localStorage.setItem('infinity-connect:displayName', JSON.stringify(name))
```

Wrapped in try/catch so a storage failure (disabled/partitioned storage) never
breaks the rename itself.

Self-detection: locate the clicked participant in `participantsList` (already
done to seed the form), and compare `getIdentity(target)` with
`getIdentity(userParticipant)` when `userParticipant` is not null.

### No read/apply on join

WebApp3 already prefills the join screen from `infinity-connect:displayName`, so
the next session joins directly under that name (as the real display name — no
overlay needed for the local user). The plugin therefore only **writes** the key;
it does not read it back or re-apply an overlay to self on join.

## Scope / cleanup

- Remove the temporary `[RENAME-TIMING]` debug instrumentation from
  `src/index.ts`.
- No new user-facing strings; no i18n changes.

## Testing

No test framework exists in the repo and none is added. Verification is
`npm run lint` (type-aware) plus manual runtime checks against a Pexip Infinity
dev server:

**Feature 1**

1. Chair A renames a participant in main; confirm the name shows.
2. From a **second** chair (B), move that participant into a breakout; confirm
   B re-applies the name (name follows), proving B learned it by observation.
3. Reload chair A mid-call; confirm A's map re-seeds (rename a fresh participant,
   move them, and confirm re-apply still works after reload).
4. Confirm no console errors; redundant `200` overlaytext POSTs are acceptable.

**Feature 2**

1. As a chair, rename yourself to a new name.
2. Confirm `localStorage['infinity-connect:displayName']` now holds
   `"<new name>"`.
3. Leave and rejoin; confirm the join screen is prefilled with the new name and
   you join under it.

## Out of scope

- Cross-client message protocol / handshake (Approach B) — not needed; the
  server's `overlay_text` is the shared source of truth.
- Persisting self-name for guests (chairs-only per decision; guest self-overlay
  permissions are also uncertain).
- Reducing the ~10s breakout re-apply latency — established as Infinity's
  breakout call-setup time, not plugin-controllable.

## Implementation notes (2026-07-30)

- Implemented directly on `feat/sticky-rename-breakouts` (no separate plan doc,
  per request); `npm run lint` and `npm run build` pass.
- The learn rule was extracted into a `learnName` helper to stay within the
  linter's complexity limit for the activities handler.
- The breakout re-apply checks the `sendRequest` HTTP status and throws on a
  non-2xx (surfaced via the activities-loop catch → `console.error`), so breakout
  write failures are logged rather than silently ignored.
- A teammate-facing summary lives in
  `docs/breakout-rename-engineering-review.md`.
