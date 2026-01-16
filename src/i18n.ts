import i18next from 'i18next'
import Backend from 'i18next-http-backend'

export const initI18n = async (): Promise<void> => {
  await i18next.use(Backend).init({
    fallbackLng: 'en',
    backend: {
      loadPath: 'locales/{{lng}}/{{ns}}.json'
    }
  })
}

export { i18next }
