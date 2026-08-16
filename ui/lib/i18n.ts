'use client'

import i18n, { type Resource } from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import LocalStorageBackend from 'i18next-localstorage-backend'

import enUS from '@/public/locales/en-US/translation.json'
import jaJP from '@/public/locales/ja-JP/translation.json'
import thTH from '@/public/locales/th-TH/translation.json'
import frFR from '@/public/locales/fr-FR/translation.json'
import esES from '@/public/locales/es-ES/translation.json'
import ptPT from '@/public/locales/pt-PT/translation.json'
import deDE from '@/public/locales/de-DE/translation.json'
import koKR from '@/public/locales/ko-KR/translation.json'

const resources = {
  'en-US': { translation: enUS },
  'ja-JP': { translation: jaJP },
  'th-TH': { translation: thTH },
  'fr-FR': { translation: frFR },
  'es-ES': { translation: esES },
  'pt-PT': { translation: ptPT },
  'de-DE': { translation: deDE },
  'ko-KR': { translation: koKR },
} satisfies Resource

i18n
  .use(LocalStorageBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en-US',
    interpolation: {
      escapeValue: false, // not needed for react as it escapes by default
    },
    react: {
      useSuspense: false,
    },
    showSupportNotice: false,
  })

export default i18n
