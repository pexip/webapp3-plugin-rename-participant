# Design: Transfer renamed participant names to breakout rooms

**Date:** 2026-07-28
**Status:** Approved (pending spec review)

## Problem

The plugin renames a participant by overwriting Pexip's per-participant
`overlay_text` via `plugin.conference.setTextOverlay`. This value is not carried
over when Infinity moves a participant into a breakout room, so the custom name
disappears the moment the participant leaves the main room. The plugin also keeps
no memory of the name it assigned, so it cannot restore it.

## Goal

Make a renamed name **sticky for the whole call**: once a chair renames a
participant, that name follows them into any breakout room, back to the main
room, and between breakout rooms.

## Approach

**Approach A — react to all-room participant activities.** The plugin remembers
each assigned name and re-applies the overlay text whenever the participant
reappears (a `Join` or `Update` activity) in *any* room, if the participant's
current `overlayText` does not already match the assigned name.

Rejected alternatives:

- **Breakout-specific events only** (`breakoutBegin` / `breakoutRefer`): narrower
  payloads and still requires the activities stream for breakout→main and
  breakout→breakout moves. Ends up being Approach A plus extra wiring.
- **Polling via `requestParticipants`**: added latency and complexity with no
  benefit over event-driven re-application.

## Design

### State

Add one module-level structure to `src/index.ts`:

- `renamedNames: Map<ParticipantID, string>` — maps a participant `uuid` to the
  name the chair assigned.

Lifecycle: populated on rename; entries are **never removed on `Leave`**. A
main→breakout move surfaces as `Leave(main)` immediately followed by
`Join(breakout)`; deleting on `Leave` would drop the name just before it needs to
be re-applied. Because move and disconnect cannot be reliably distinguished from
activities alone, the map is treated as session-scoped and is discarded naturally
when the plugin/call ends. A lingering entry for a genuinely disconnected
participant is bounded (by call size) and harmless.

`participantsList` keeps its existing meaning — **main-room participants only** —
and continues to drive the rename button's `participantIDs`. Unchanged.

### Core helper

```ts
const reapplyName = async (participant: InfinityParticipant): Promise<void> => {
  const desired = renamedNames.get(participant.uuid)
  if (desired !== undefined && participant.overlayText !== desired) {
    await plugin.conference.setTextOverlay({
      participantUuid: participant.uuid,
      text: desired
    })
  }
}
```

The `participant.overlayText !== desired` guard prevents an infinite loop: our
own `setTextOverlay` call produces an `Update` activity, which is re-processed,
but the values now match so no further call is made.

### Wiring / data flow

1. **On rename** (`renameAction.onClick`): after `setTextOverlay` resolves,
   record the assignment with `renamedNames.set(participantUuid, name)`.

2. **On `participantsActivities`**: process activities for **all rooms**, not just
   `main`.
   - Convert the handler's `forEach` to a `for…of` loop so the `await`s inside
     sequence correctly (the current `forEach` callback cannot `await`).
   - For every activity whose type is `Join` or `Update`, call
     `reapplyName(activity.participant)`, wrapped in try/catch so a single failed
     overlay call does not abort processing of the remaining activities.
   - The existing main-room `switch` that maintains `participantsList` (Join /
     Leave / Update) stays as-is, nested under `if (roomId === 'main')`.
   - `applySetup()` continues to run once after the activities are processed.

Activity-type reading continues to use the existing `getActivityType` shim
(`activity.activity` vs `activity.type`).

### Preserved constraints

- **SSO exclusion**: unchanged. SSO-authenticated participants never receive the
  rename button, so they never enter `renamedNames` and are never re-applied.
- **Chair-only**: re-application is gated on `userParticipant?.role === 'chair'`.
  Only a chair's client ever populates `renamedNames`, but the explicit guard
  documents the intent.

## Assumptions to verify during implementation

1. A participant retains the same `uuid` across a main↔breakout move. (If uuids
   change, matching by `uuid` fails and identity would need a different key such
   as `uri`; this would be a larger redesign.)
2. The chair's client receives `participantsActivities` for breakout rooms it is
   not a member of.

If assumption (2) is false, the documented fallback is to additionally subscribe
to `breakoutBegin` / `breakoutRefer` and call the same `reapplyName` helper for
the participants named in those payloads.

## Testing

The repository has no test framework, and this design does not introduce one.
Verification is manual against a Pexip Infinity dev server (`npm start`):

1. As a chair, rename a participant in the main room; confirm the overlay name
   shows.
2. Open a breakout room and move the renamed participant in; confirm the name
   follows.
3. Move the participant back to main; confirm the name persists.
4. Move the participant directly between two breakout rooms; confirm the name
   persists.
5. Confirm SSO-authenticated participants still cannot be renamed (no button).
6. Confirm there is no flicker or repeated overlay updates (no loop).

## Out of scope

- Renaming the participant's real display name (still overlay text only, per the
  existing plugin limitation).
- Persisting names across full disconnect/rejoin (a rejoin yields a new `uuid`).
- Introducing an automated test framework.
