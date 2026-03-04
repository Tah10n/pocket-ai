import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

const resources = {
    en: {
        translation: {
            chat: {
                title: 'Chat',
                inputPlaceholder: 'Ask local AI...',
                send: 'Send',
                stop: 'Stop',
                regenerate: 'Regenerate',
                warmingUp: 'Warming up model...',
                memoryWarning: 'Low memory warning',
                thermalWarning: 'Device is overheating!',
            },
            settings: {
                title: 'Settings',
                temperature: 'Temperature',
                topP: 'Top-P',
                maxTokens: 'Max Tokens',
                darkMode: 'Dark Mode',
                language: 'Language',
                presets: 'System Prompt Presets',
            },
            models: {
                title: 'Models',
                download: 'Download',
                cancel: 'Cancel',
                ready: 'Ready to use',
                storageManager: 'Storage Manager',
                offload: 'Offload',
            },
            common: {
                save: 'Save',
                delete: 'Delete',
                cancel: 'Cancel',
                edit: 'Edit',
                add: 'Add',
            },
        },
    },
    ru: {
        translation: {
            chat: {
                title: 'Чат',
                inputPlaceholder: 'Спросите ИИ...',
                send: 'Отправить',
                stop: 'Стоп',
                regenerate: 'Перегенерировать',
                warmingUp: 'Загрузка модели...',
                memoryWarning: 'Предупреждение: мало памяти',
                thermalWarning: 'Устройство перегревается!',
            },
            settings: {
                title: 'Настройки',
                temperature: 'Температура',
                topP: 'Top-P',
                maxTokens: 'Макс. токенов',
                darkMode: 'Тёмная тема',
                language: 'Язык',
                presets: 'Пресеты системных промптов',
            },
            models: {
                title: 'Модели',
                download: 'Скачать',
                cancel: 'Отмена',
                ready: 'Готово к использованию',
                storageManager: 'Управление хранилищем',
                offload: 'Удалить',
            },
            common: {
                save: 'Сохранить',
                delete: 'Удалить',
                cancel: 'Отмена',
                edit: 'Редактировать',
                add: 'Добавить',
            },
        },
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
