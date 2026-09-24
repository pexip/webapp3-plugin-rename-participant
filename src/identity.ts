import type { InfinityParticipant } from '@pexip/plugin-api'

/**
 * Get the identity of a participant, prioritizing URI, then display name, and finally UUID.
 * @param participant The participant object
 * @returns The identity string of the participant
 */
export const getIdentity = (participant: InfinityParticipant): string => {
  if (participant.uri !== '') {
    return participant.uri
  }
  if (participant.displayName !== undefined && participant.displayName !== '') {
    return participant.displayName
  }
  return participant.uuid
}
