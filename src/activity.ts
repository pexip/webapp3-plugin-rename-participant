import type { ParticipantActivities } from '@pexip/plugin-api'

/**
 * Get the type of the activity, handling both legacy 'activity' and current 'type' properties.
 * @param activity The activity object which may contain either 'activity' or 'type' property
 * @returns The type of the activity as a ParticipantActivities value
 */
export const getActivityType = (
  activity:
    | { activity: ParticipantActivities }
    | { type: ParticipantActivities }
): ParticipantActivities =>
  'activity' in activity ? activity.activity : activity.type
