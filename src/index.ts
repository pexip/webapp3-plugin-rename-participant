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
      }
    })
  } else {
    // Synchronize the participant action with the latest participants
    await renameAction.update(getSetup())
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
  roomParticipantActivities.forEach((roomParticipantActivity) => {
    const { roomId, activity } = roomParticipantActivity

    if (roomId !== 'main') {
      return
    }
    switch (getActivityType(activity)) {
      case ParticipantActivities.Join:
        participantsList.push(activity.participant)
        break
      case ParticipantActivities.Leave:
        participantsList = participantsList.filter(
          (p) => p.uuid !== activity.participant.uuid
        )
        break
      case ParticipantActivities.Update:
        participantsList = participantsList.map((p) =>
          p.uuid === activity.participant.uuid ? activity.participant : p
        )
        break
    }
  })
  await applySetup()
})

// Get the identity of the current participant
plugin.events.me.add((me) => {
  const { participant } = me
  userParticipant = participant
})
