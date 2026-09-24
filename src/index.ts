import {
  type Button,
  type InfinityParticipant,
  type ParticipantActionButtonPayload,
  ParticipantActivities,
  type ParticipantID,
  registerPlugin
} from '@pexip/plugin-api'
import { i18next, initI18n } from './i18n'
import { RenameForm } from './forms'
import { getActivityType } from './activity'
import { getIdentity } from './identity'
import type { ConferenceWithSendRequest } from './types'
import { logger } from './logger'

const HTTP_SUCCESS_MIN = 200
const HTTP_SUCCESS_MAX = 300

// WebApp3 (v41+) stores the join display name in localStorage under this key
// as a JSON-encoded string. The plugin runs in the same origin, so it can write
// this key to persist a chair's self-chosen name for their next session.
const DISPLAY_NAME_KEY = 'infinity-connect:displayName'

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

/**
 * Applies the setup object to the participant action button, creating it if necessary.
 * @returns Promise<void>
 */
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
            } catch (error) {
              // Storage may be unavailable/partitioned; the rename still applies
              logger.warn(error, 'Could not persist display name')
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

/**
 * Learns an assigned name by observation. Infinity pushes overlay_text to every
 * client, so a non-empty overlay that differs from the real display name
 * (rawData.display_name) is a name some chair assigned. Recording it lets any
 * chair — including one that reloaded or joined late — re-apply it after a room
 * move, without any cross-client message protocol.
 * @param participant The participant whose overlay text is observed.
 * @returns void
 */
const learnName = (participant: InfinityParticipant): void => {
  if (
    participant.overlayText !== '' &&
    participant.overlayText !== participant.rawData.display_name
  ) {
    renamedNames.set(getIdentity(participant), participant.overlayText)
  }
}

/**
 * Re-applies a previously assigned overlay text to the specified participant.
 * Guests hold no names, so this is only meaningful for the chair.
 * @param participant The participant for whom to reapply the overlay text.
 * @param roomId The ID of the room where the participant is located.
 * @returns void
 */
const reapplyOverlayText = (
  participant: InfinityParticipant,
  roomId: string
): void => {
  // Only re-apply when the chair has assigned a name and it differs from the
  // current overlay, to avoid redundant API calls and update loops.
  const desiredOverlayText = renamedNames.get(getIdentity(participant))
  if (
    desiredOverlayText === undefined ||
    desiredOverlayText === participant.overlayText
  ) {
    return
  }

  if (roomId === 'main') {
    plugin.conference
      .setTextOverlay({
        participantUuid: participant.uuid,
        text: desiredOverlayText
      })
      .catch(logger.error)
    return
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Casting conference to ConferenceWithSendRequest to access sendRequest method
  ;(plugin.conference as unknown as ConferenceWithSendRequest)
    .sendRequest({
      path: `breakouts/${roomId}/participants/${participant.uuid}/overlaytext`,
      method: 'POST',
      payload: { text: desiredOverlayText }
    })
    .then((response) => {
      if (
        response !== undefined &&
        (response.status < HTTP_SUCCESS_MIN ||
          response.status >= HTTP_SUCCESS_MAX)
      ) {
        throw new Error(
          `Breakout overlay set failed for ${participant.uuid}: HTTP ${response.status}`
        )
      }
    })
    .catch(logger.error)
}

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
      reapplyOverlayText(participant, roomId)
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
plugin.events.me.add(async (me) => {
  const { participant } = me
  userParticipant = participant
  await applySetup()
})
