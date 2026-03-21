import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import enLocale from './locales/en.json';
import ruLocale from './locales/ru.json';

const resources = {
    en: {
        translation: enLocale,
    },
    ru: {
        translation: ruLocale,
    },
};

i18n
    .use(initReactI18next)
    .init({
        resources,
        lng: 'en',
        fallbackLng: 'en',
        interpolation: {
            escapeValue: false,
        },
        compatibilityJSON: 'v4',
    });

export default i18n;
