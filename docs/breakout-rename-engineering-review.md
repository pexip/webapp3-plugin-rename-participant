# Engineering Review: Rename-participant plugin — breakout persistence & shared state

**Audience:** Web App 3 plugin team
**Status:** Implemented on `feat/sticky-rename-breakouts`, manually verified against a live Infinity deployment. No automated tests (repo has none).
**Scope of file changes:** `src/index.ts` only (+~118 lines). No new dependencies, no i18n changes, no manifest changes.

---

## 1. Motivation

The plugin renames a participant by writing `overlay_text` via
`plugin.conference.setTextOverlay`. That overlay is **not carried over when a
participant is moved into a breakout room**, so the assigned name vanished on the
first room move. Goal: make an assigned name "sticky" for the whole call, and —
as a small follow-on — let a chair's self-chosen name persist to their next
session.

## 2. Behavioural changes (what users see)

- A chair-assigned name now **follows a participant** into breakout rooms, back
  to main, and between breakouts.
- Works regardless of **which chair** performs the move, and survives a chair
  **reload / late join**.
- When a chair renames **themselves**, that name is remembered for their **next
  join**.
- Unchanged: chair-only action, SSO participants excluded, overlay-text-only
  (real display name is not modified).

## 3. Technical changes

All in `src/index.ts`.

### 3.1 Identity keying (the core fix)

Names are held in `Map<identity, name>` keyed by a **stable identity**, not
`uuid`:

```ts
const getIdentity = (p) => p.uri (|| displayName || uuid)
```

**Finding:** a participant's `uuid` is **regenerated on every room move**.
Verified in logs — the same person had three different `uuid`s across
main → breakout → main, while `uri` stayed constant. Keying by `uuid` (the
obvious first implementation) silently fails after any move.

### 3.2 Breakout-scoped overlay via `sendRequest`

`setTextOverlay` posts to `/conferences/{conf}/participants/{uuid}/overlaytext`,
which **404s** for a participant inside a breakout. Breakout participants live
under `/conferences/{conf}/breakouts/{roomId}/participants/{uuid}/overlaytext`.
The public plugin API exposes no breakout-scoped overlay call, so we use the
**undocumented** `plugin.conference.sendRequest` (present at runtime, absent from
the type defs — typed locally and reached via a single asserted cast).

### 3.3 Shared state by observation (no message protocol)

Instead of broadcasting rename events between clients, each plugin instance
**learns** assigned names by observation: Infinity replicates `overlay_text` to
every client, so a non-empty overlay that differs from `rawData.display_name`
(the real name) is recorded as an assigned name (`learnName`). This gives
multi-chair and reload robustness for free — the server's `overlay_text` is the
source of truth. Re-apply happens on `Join`/`Update` in any room when the current
overlay doesn't match the remembered name.

> Note: `participant.displayName` mirrors the overlay once set, so it can't be
> used to detect a custom name — we compare against `rawData.display_name`.

### 3.4 Self-name persistence

On self-rename we also write webapp3's own key
`localStorage['infinity-connect:displayName'] = JSON.stringify(name)` (in
try/catch). WebApp3 prefills the join screen from this key on next load, so no
join-time overlay re-apply is needed.

### 3.5 Loop mechanics

The `participantsActivities` handler was converted from `forEach` to `for…of`
so the re-apply `await`s sequence correctly; each re-apply is wrapped in
try/catch so one failure doesn't abort the batch. The `overlayText === desired`
guard both avoids redundant calls and prevents a feedback loop (our own overlay
write produces an Update we then re-process). The breakout `sendRequest` resolves
with an HTTP status rather than throwing, so its status is checked and a non-2xx
is thrown — surfaced via the same catch as a failed `setTextOverlay`.

## 4. Risks

| # | Risk | Severity | Notes / mitigation |
|---|------|----------|--------------------|
| R1 | **Undocumented `sendRequest`** for breakout overlay | Medium | Not in public types; could change/break in a future `@pexip/plugin-api`. Isolated behind one call + local interface. **Ask:** is there / can there be an official breakout-scoped overlay API? |
| R2 | **Identity fallback for empty-`uri` guests** | Medium | Anonymous WebRTC guests can have empty `uri`; we fall back to `displayName`, which is non-unique → two identically-named guests could share a name. SIP/authenticated match exactly. |
| R3 | **`learnName` heuristic** ("overlay ≠ real name" ⇒ assigned) | Low–Med | Adopts any overlay set by other means as sticky. Benign for this plugin, but it means the plugin will re-assert overlays it didn't set. |
| R4 | **Redundant writes with multiple chairs** | Low | Every chair re-applies; N chairs → N idempotent 200 POSTs per reset. No leader election. Harmless but noisy; scales with chair count. |
| R5 | **In-memory, non-authoritative state** | Low | If a name's overlay is reset during a move **and** no chair that ever observed it is present, it's lost. Acceptable given server-as-source-of-truth model. |
| R6 | **`localStorage` in a sandboxed iframe** | Low | Relies on same-origin + `allow-same-origin`. Guarded by try/catch; silently no-ops if storage is partitioned/blocked. |
| R7 | **Coupling to webapp3 internals** | Low–Med | Hard-codes the key `infinity-connect:displayName`. If webapp3 renames/reshapes it, self-name persistence silently stops. |
| R8 | **~10s perceived latency** into breakout | Low (UX) | Inherent: Infinity tears down and rebuilds the participant's call; the participant (and its overlay) doesn't exist until that completes. We set at first opportunity; the POST succeeds first try (200). Not plugin-controllable. |
| R9 | **No automated tests** | Med | Repo has no test framework; all verification is manual. Regressions won't be caught in CI. |

## 5. Possible improvements

1. **Official breakout overlay API** (removes R1) — a `roomId`/breakout option on
   `setTextOverlay`, or documenting `sendRequest`. This is the main upstream ask.
2. **Stronger identity** (R2) — expose a stable per-participant identity that
   survives room moves and is unique for guests (e.g. a call/participant identity
   independent of the room-scoped `uuid`).
3. **De-duplicate re-applies** (R4) — e.g. only the chair who performed the move
   acts, or debounce per-identity, or elect the lowest-uuid chair. Weigh against
   added complexity.
4. **Make `learnName` precise** (R3) — if the API ever distinguishes
   plugin-set overlays from others, gate learning on that.
5. **Config the storage key** (R7) — read the key from plugin config/manifest
   rather than hard-coding, and/or have webapp3 expose an official "remember my
   name" hook.
6. **Tests** (R9) — introduce a light unit harness around the pure logic
   (`getIdentity`, `learnName`, the re-apply decision) with the plugin API mocked.
7. **Telemetry** — failed re-applies are now surfaced via `console.error` for
   both paths (the breakout `sendRequest` status is checked and a non-2xx throws,
   rather than being swallowed). A chair-facing toast / structured log on failure
   is still a possible enhancement.

## 6. Testing performed

Manual, against a live Infinity dev deployment:
- Rename in main; move to breakout; back to main; between breakouts — name follows.
- Second chair moves a participant renamed by the first chair — name applied
  (confirms observation-based learning).
- Breakout overlay POST returns **200** first try (confirmed in host logs).
- Self-rename writes `infinity-connect:displayName`; a fresh load joins under the
  new name.
- SSO participants still excluded; no update loop / flicker observed.

**Gaps:** no automated coverage; empty-`uri` anonymous guest matching not
exercised; behaviour with 3+ simultaneous chairs not stress-tested.

## 7. Compatibility notes

- Relies on `participant.rawData.display_name` and `participant.uri` from
  `@pexip/plugin-api` 22.1.0.
- Self-name persistence assumes webapp3 **v41+** localStorage key
  `infinity-connect:displayName` (JSON string).
- Breakout overlay relies on the runtime `conference.sendRequest` RPC.
