'use client'

import i18n, { type Resource } from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import LocalStorageBackend from 'i18next-localstorage-backend'

import enUS from '@/public/locales/en-US/translation.json'
import jaJP from '@/public/locales/ja-JP/translation.json'
import thTH from '@/public/locales/th-TH/translation.json'

const resources = {
  'en-US': { translation: enUS },
  'ja-JP': { translation: jaJP },
  'th-TH': { translation: thTH },
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
