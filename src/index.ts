import {
  type Button,
  type InfinityParticipant,
  type ParticipantActionButtonPayload,
  ParticipantActivities,
  type ParticipantID,
  type RoomID,
  registerPlugin
} from '@pexip/plugin-api'
import { i18next, initI18n } from './i18n'
import { RenameForm } from './forms'

// plugin.conference.sendRequest exists at runtime but is missing from the
// public @pexip/plugin-api types. It is the only way to reach a participant
// inside a breakout room, whose overlay text lives under a breakout-scoped
// endpoint that setTextOverlay (main room only) cannot address. Typed locally
// so it can be called without `any`.
interface ConferenceWithSendRequest {
  sendRequest: (opt: {
    path: string
    method: 'GET' | 'POST'
    payload?: Record<string, unknown>
  }) => Promise<{ status: number; data: unknown } | undefined>
}

// WebApp3 (v41+) stores the join display name in localStorage under this key
// as a JSON-encoded string. The plugin runs in the same origin, so it can write
// this key to persist a chair's self-chosen name for their next session.
const DISPLAY_NAME_KEY = 'infinity-connect:displayName'

// Inclusive lower / exclusive upper bound of the HTTP 2xx success range,
// used to check sendRequest responses (which resolve with a status rather
// than throwing on failure).
const HTTP_SUCCESS_MIN = 200
const HTTP_SUCCESS_MAX = 300

// The participant action button
let renameAction: Button<'participantActions'> | null = null

// The list of participants in the conference
let participantsList: InfinityParticipant[] = []

// The participant object of the user itself
let userParticipant: InfinityParticipant | null = null

// Names assigned by the chair, keyed by a stable participant identity (see
// getIdentity) so they can be re-applied when a participant moves between
// rooms. A participant's uuid changes on every room move (e.g. into a
// breakout), so it cannot be used as the key here.
const renamedNames = new Map<string, string>()

// A stable identity for a participant that survives room moves. The uuid
// changes whenever Infinity moves a participant between rooms, but the uri is
// preserved; fall back to the display name, then the uuid, when the uri is
// empty (as it can be for some guests).
const getIdentity = (participant: InfinityParticipant): string => {
  if (participant.uri !== '') {
    return participant.uri
  }
  if (participant.displayName !== undefined && participant.displayName !== '') {
    return participant.displayName
  }
  return participant.uuid
}

// Initialize i18n before using it
await initI18n()

// Register the plugin
const version = 1
const plugin = await registerPlugin({
  id: 'webapp3-rename-participant-plugin',
  version
})

plugin.events.languageSelect.add(async (language) => {
  await i18next.changeLanguage(language)
  await renameAction?.update(getSetup())
})

// SSO authenticated participants are not allowed to rename
const getMatchingParticipants = (): ParticipantID[] =>
  participantsList
    .filter((participant) => participant.isIdpAuthenticated === false)
    .map((p) => p.uuid)

// The setup object for the participant action
const getSetup = (): ParticipantActionButtonPayload => ({
  position: 'participantActions',
  label: i18next.t('rename'),
  icon: 'IconEdit',
  participantIDs: getMatchingParticipants()
})

// Apply the setup object to the participant action
const applySetup = async (): Promise<void> => {
  // If the current user is not a chair, do not show the action
  if (userParticipant?.role !== 'chair') {
    return
  }

  if (renameAction === null) {
    renameAction = await plugin.ui.addButton(getSetup())

    renameAction.onClick.add(async (clickedParticipant) => {
      const target = participantsList.find(
        (participant) => participant.uuid === clickedParticipant.participantUuid
      )
      const clickedParticipantName = target?.overlayText ?? ''

      const input = await plugin.ui.showForm(RenameForm(clickedParticipantName))
      const { name } = input

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Form input may return undefined if form is closed
      if (name !== undefined && name !== '') {
        await plugin.conference.setTextOverlay({
          participantUuid: clickedParticipant.participantUuid,
          text: name
        })
        // Remember the name under a stable identity so it can be re-applied
        // after the participant moves rooms. Skip if the participant is no
        // longer in the list (the overlay is still applied, just not sticky).
        if (target !== undefined) {
          renamedNames.set(getIdentity(target), name)

          // If the chair renamed themselves, persist the name to webapp3's
          // stored display name so their next session joins under it.
          if (
            userParticipant !== null &&
            getIdentity(target) === getIdentity(userParticipant)
          ) {
            try {
              localStorage.setItem(DISPLAY_NAME_KEY, JSON.stringify(name))
            } catch {
              // Storage may be unavailable/partitioned; the rename still applies
            }
          }
        }
      }
    })
  } else {
    // Synchronize the participant action with the latest participants
    await renameAction.update(getSetup())
  }
}

// Learn an assigned name by observation. Infinity pushes overlay_text to every
// client, so a non-empty overlay that differs from the real display name
// (rawData.display_name) is a name some chair assigned. Recording it lets any
// chair — including one that reloaded or joined late — re-apply it after a room
// move, without any cross-client message protocol.
const learnName = (participant: InfinityParticipant): void => {
  if (
    participant.overlayText !== '' &&
    participant.overlayText !== participant.rawData.display_name
  ) {
    renamedNames.set(getIdentity(participant), participant.overlayText)
  }
}

// Re-apply the assigned overlay name if the participant's current overlay
// text does not already match it. The mismatch guard also prevents an update
// loop: our own overlay call produces an Update activity which is then
// re-processed, but the values now match so no further call is made.
//
// A participant in the main room is addressed with setTextOverlay. A
// participant inside a breakout room must be addressed through the
// breakout-scoped overlaytext endpoint (setTextOverlay targets the main room
// only and returns 404 for breakout participants), which is only reachable via
// the undocumented sendRequest.
const reapplyName = async (
  participant: InfinityParticipant,
  roomId: RoomID
): Promise<void> => {
  const desired = renamedNames.get(getIdentity(participant))
  if (desired === undefined || participant.overlayText === desired) {
    return
  }

  if (roomId === 'main') {
    await plugin.conference.setTextOverlay({
      participantUuid: participant.uuid,
      text: desired
    })
    return
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- sendRequest exists at runtime but is absent from the public conference type
  const conference = plugin.conference as unknown as ConferenceWithSendRequest
  const response = await conference.sendRequest({
    path: `breakouts/${roomId}/participants/${participant.uuid}/overlaytext`,
    method: 'POST',
    payload: { text: desired }
  })
  // sendRequest resolves with the HTTP status instead of throwing, so surface a
  // non-2xx as an error (handled the same way as a failed setTextOverlay).
  if (
    response !== undefined &&
    (response.status < HTTP_SUCCESS_MIN || response.status >= HTTP_SUCCESS_MAX)
  ) {
    throw new Error(
      `Breakout overlay set failed for ${participant.uuid}: HTTP ${response.status}`
    )
  }
}

// Type guard to check if activity uses 'activity' or 'type' property
// activity was replaced by tpye in later versions of the API
const getActivityType = (
  activity:
    | { activity: ParticipantActivities }
    | { type: ParticipantActivities }
): ParticipantActivities =>
  'activity' in activity ? activity.activity : activity.type

// Initial setup
await applySetup()

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
      learnName(participant)

      try {
        // eslint-disable-next-line no-await-in-loop -- Re-apply names sequentially, one activity at a time
        await reapplyName(participant, roomId)
      } catch (error) {
        // eslint-disable-next-line no-console -- Intended error surface for a failed overlay re-apply
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

// Get the identity of the current participant
plugin.events.me.add((me) => {
  const { participant } = me
  userParticipant = participant
})
