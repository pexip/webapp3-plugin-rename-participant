import {
  type Button,
  type InfinityParticipant,
  type ParticipantActionButtonPayload,
  ParticipantActivities,
  type ParticipantID,
  registerPlugin
} from '@pexip/plugin-api'
import { RenameForm } from './forms'

// The participant action button
let renameAction: Button<'participantActions'> | null = null

// The list of participants in the conference
let participantsList: InfinityParticipant[] = []

// The participant object of the user itself
let userParticipant: InfinityParticipant | null = null

// Register the plugin
const version = 1
const plugin = await registerPlugin({
  id: 'webapp3-rename-participant-plugin',
  version
})

// SSO authenticated participants are not allowed to rename
const getMatchingParticipants = (): ParticipantID[] =>
  participantsList
    .filter((participant) => participant.isIdpAuthenticated === false)
    .map((p) => p.uuid)

// The setup object for the participant action
const getSetup = (): ParticipantActionButtonPayload => ({
  position: 'participantActions',
  label: 'Rename',
  icon: 'IconEdit',
  participantIDs: getMatchingParticipants()
})

// Apply the setup object to the participant action
const applySetup = async (): Promise<void> => {
  // If the current user is not a chair, do not show the action
  if (userParticipant === null || userParticipant.role !== 'chair') {
    return
  }

  if (renameAction !== null) {
    // Synchronize the participant action with the latest participants
    await renameAction.update(getSetup())
  } else {
    renameAction = await plugin.ui.addButton(getSetup())

    renameAction.onClick.add(async (clickedParticipant) => {
      const clickedParticipantName =
        participantsList.find(
          (participant) =>
            participant.uuid === clickedParticipant.participantUuid
        )?.overlayText ?? ''

      const input = await plugin.ui.showForm(RenameForm(clickedParticipantName))
      const { name } = input

      if (name) {
        await plugin.conference.setTextOverlay({
          participantUuid: clickedParticipant.participantUuid,
          text: name
        })
      }
    })
  }
}

// Initial setup
await applySetup()

// Update setup when participants change
plugin.events.participantsActivities.add(async (roomParticipantActivities) => {
  roomParticipantActivities.forEach((roomParticipantActivity) => {
    const { roomId, activity } = roomParticipantActivity
    if (roomId !== 'main') {
      return
    }
    switch (activity.activity) {
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
