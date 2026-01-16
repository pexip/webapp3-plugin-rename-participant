import { i18next } from './i18n'

export const RenameForm = (participantName: string) =>
  ({
    title: i18next.t('title', { participantName }),
    description: i18next.t('description'),
    form: {
      elements: {
        name: {
          name: i18next.t('inputLabel'),
          type: 'text'
        }
      },
      submitBtnTitle: i18next.t('submitButton')
    }
  }) as const
