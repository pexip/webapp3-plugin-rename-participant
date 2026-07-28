# Transfer Renamed Names to Breakout Rooms — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a chair-assigned participant name sticky for the whole call so it follows the participant into breakout rooms, back to main, and between breakouts.

**Architecture:** Keep an in-memory `Map<ParticipantID, string>` of assigned names. Re-apply the overlay text whenever a participant reappears (`Join`/`Update`) in any room and their current `overlayText` does not already match the assigned name. All logic lives in the existing event-driven `src/index.ts`.

**Tech Stack:** TypeScript, `@pexip/plugin-api` 22.1.0, Vite, ESLint (`eslint-config-love`, type-aware).

## Global Constraints

- No test framework exists in the repo and none is to be added; verification is `npm run lint` (type-aware) plus manual runtime checks.
- ESLint style: no semicolons, no trailing commas, single quotes, 2-space indent, 80-col print width (enforced by config — match surrounding code).
- Preserve existing constraints: rename button is chair-only and excludes SSO-authenticated participants.
- Renaming remains overlay-text only; the real display name is not changed.
- Node >= v20.12.2, NPM >= v10.5.0.

---

### Task 1: Make assigned names sticky across rooms

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes (existing, already in file): `plugin.conference.setTextOverlay({ participantUuid, text })`; `plugin.events.participantsActivities`; `getActivityType(activity)`; `ParticipantActivities` enum; `InfinityParticipant`, `ParticipantID` types (already imported at `src/index.ts:1-8`); module state `participantsList`, `userParticipant`.
- Produces: module-level `renamedNames: Map<ParticipantID, string>` and `reapplyName(participant: InfinityParticipant): Promise<void>`.

- [ ] **Step 1: Add the `renamedNames` map to module state**

In `src/index.ts`, immediately after the `userParticipant` declaration (currently `src/index.ts:19`), add:

```ts
// Names assigned by the chair, kept for the whole call so they can be
// re-applied when a participant moves between rooms (e.g. into a breakout).
const renamedNames = new Map<ParticipantID, string>()
```

- [ ] **Step 2: Record the name when a participant is renamed**

In the `renameAction.onClick` handler, inside the existing `if (name !== undefined && name !== '')` block (currently `src/index.ts:71-76`), add the `renamedNames.set(...)` line after the `setTextOverlay` call so the block reads:

```ts
      if (name !== undefined && name !== '') {
        await plugin.conference.setTextOverlay({
          participantUuid: clickedParticipant.participantUuid,
          text: name
        })
        renamedNames.set(clickedParticipant.participantUuid, name)
      }
```

- [ ] **Step 3: Add the `reapplyName` helper**

Add this helper after the `applySetup` function definition (after the closing brace currently at `src/index.ts:82`) and before the `getActivityType` comment block:

```ts
// Re-apply the assigned overlay name if the participant's current overlay
// text does not already match it. The mismatch guard also prevents an update
// loop: our own setTextOverlay call produces an Update activity which is then
// re-processed, but the values now match so no further call is made.
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

- [ ] **Step 4: Rewire the `participantsActivities` handler to all rooms**

Replace the entire current handler (currently `src/index.ts:97-121`) with:

```ts
// Update setup when participants change
plugin.events.participantsActivities.add(async (roomParticipantActivities) => {
  for (const { roomId, activity } of roomParticipantActivities) {
    const activityType = getActivityType(activity)
    const { participant } = activity

    // Re-apply a previously assigned name whenever the participant reappears
    // in ANY room (main or breakout). Chair-only; guest clients hold no names.
    if (
      userParticipant?.role === 'chair' &&
      (activityType === ParticipantActivities.Join ||
        activityType === ParticipantActivities.Update)
    ) {
      try {
        await reapplyName(participant)
      } catch (error) {
        console.error('Failed to re-apply overlay name', error)
      }
    }

    // Maintain the main-room participant list that drives the rename button
    if (roomId !== 'main') {
      continue
    }
    switch (activityType) {
      case ParticipantActivities.Join:
        participantsList.push(participant)
        break
      case ParticipantActivities.Leave:
        participantsList = participantsList.filter(
          (p) => p.uuid !== participant.uuid
        )
        break
      case ParticipantActivities.Update:
        participantsList = participantsList.map((p) =>
          p.uuid === participant.uuid ? participant : p
        )
        break
    }
  }
  await applySetup()
})
```

- [ ] **Step 5: Lint (type-aware gate)**

Run: `npm run lint`
Expected: PASS with no errors. In particular, no unused-variable, no-floating-promises, or type errors on the new code.

If lint reports the `console.error` is disallowed, keep it (it is the intended error surface) and, only if the config forbids it, replace with the plugin's logger if one is in use elsewhere; otherwise add a scoped `// eslint-disable-next-line` matching the file's existing convention (see the existing disable comment at the `if (name !== undefined ...)` guard).

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: PASS; `dist/` is produced with no errors.

- [ ] **Step 7: Manual runtime verification**

Start the dev server (requires `.env` with `VITE_INFINITY_TARGET`, per `README.md`):

Run: `npm start`
Then, accessed through the Web App 3 URL as a **chair**:

1. Rename a participant in the main room → overlay name shows. Expected: name visible in participant list.
2. Open a breakout room and move that participant in → Expected: the assigned name is shown in the breakout room.
3. Move the participant back to main → Expected: name still shown.
4. Move the participant directly between two breakout rooms → Expected: name still shown.
5. Confirm an SSO-authenticated participant still has no rename button. Expected: no rename action for them.
6. Watch for flicker/repeated updates on the renamed participant. Expected: name set once per appearance, no loop.

If step 2 fails because the chair's client receives no breakout-room activities (spec assumption 2), apply the documented fallback: subscribe to `plugin.events.breakoutBegin` / `plugin.events.breakoutRefer` and call `reapplyName` for the participant(s) in those payloads. Re-run this verification.

If any step shows the name not matching after a move, confirm spec assumption 1 (stable `uuid` across moves) by logging `participant.uuid` before/after a move; if uuids differ, stop and revisit the design (identity key would need to change).

- [ ] **Step 8: Commit**

```bash
git add src/index.ts
git commit -m "feat: keep renamed participant names across breakout rooms"
```

---

## Self-Review

**Spec coverage:**
- Sticky `Map<ParticipantID, string>`, never deleted on Leave → Step 1 (map is only ever `set`, never deleted). ✓
- Re-apply on Join/Update in any room with mismatch guard → Steps 3, 4. ✓
- Record on rename → Step 2. ✓
- `forEach` → `for…of` for correct `await` sequencing → Step 4. ✓
- try/catch per re-apply → Step 4. ✓
- main-only switch preserved under `roomId !== 'main'` guard → Step 4. ✓
- Chair-only gate on re-apply → Step 4. ✓
- SSO exclusion preserved (unchanged button logic) → not modified, so preserved. ✓
- Assumptions 1 & 2 handling → Step 7. ✓
- Manual testing, no new framework → Steps 5–7. ✓

**Placeholder scan:** No TBD/TODO; all code shown in full. ✓

**Type consistency:** `renamedNames` typed `Map<ParticipantID, string>`; `reapplyName(participant: InfinityParticipant)`; both types already imported at `src/index.ts:1-8`. `reapplyName` is defined (Step 3) before its use (Step 4). ✓
