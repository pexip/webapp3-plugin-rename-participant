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

// The participant action button
let renameAction: Button<'participantActions'> | null = null

// The list of participants in the conference
let participantsList: InfinityParticipant[] = []

// The participant object of the user itself
let userParticipant: InfinityParticipant | null = null

// Names assigned by the chair, kept for the whole call so they can be
// re-applied when a participant moves between rooms (e.g. into a breakout).
const renamedNames = new Map<ParticipantID, string>()

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
      const clickedParticipantName =
        participantsList.find(
          (participant) =>
            participant.uuid === clickedParticipant.participantUuid
        )?.overlayText ?? ''

      const input = await plugin.ui.showForm(RenameForm(clickedParticipantName))
      const { name } = input

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Form input may return undefined if form is closed
      if (name !== undefined && name !== '') {
        await plugin.conference.setTextOverlay({
          participantUuid: clickedParticipant.participantUuid,
          text: name
        })
        renamedNames.set(clickedParticipant.participantUuid, name)
      }
    })
  } else {
    // Synchronize the participant action with the latest participants
    await renameAction.update(getSetup())
  }
}

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
      try {
        // eslint-disable-next-line no-await-in-loop -- Re-apply names sequentially, one activity at a time
        await reapplyName(participant)
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
