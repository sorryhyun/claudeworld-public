import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ko from "./locales/ko.json";
import en from "./locales/en.json";
import jp from "./locales/jp.json";

i18n.use(initReactI18next).init({
  resources: {
    ko: { translation: ko },
    en: { translation: en },
    jp: { translation: jp },
  },
  lng: localStorage.getItem("language") || "ko",
  fallbackLng: "ko",
  interpolation: {
    escapeValue: false, // React already escapes values
  },
});

export default i18n;

// Helper to change language and persist
export const changeLanguage = (lng: "ko" | "en" | "jp") => {
  localStorage.setItem("language", lng);
  i18n.changeLanguage(lng);
};

// Helper to get current language
export const getCurrentLanguage = () => {
  return i18n.language as "ko" | "en" | "jp";
};
