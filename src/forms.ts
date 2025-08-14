export const RenameForm = (participantName: string) =>
  ({
    title: `Rename ${participantName}`,
    description:
      'You can rename the participant by entering a new name in the field below.',
    form: {
      elements: {
        name: {
          name: 'Enter new display name',
          type: 'text'
        }
      },
      submitBtnTitle: 'Rename'
    }
  }) as const
