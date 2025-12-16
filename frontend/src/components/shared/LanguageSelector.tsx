import type { GameLanguage } from '../../contexts/GameContext';

interface LanguageSelectorProps {
  language: GameLanguage;
  onLanguageChange: (lang: GameLanguage) => void;
  className?: string;
}

export function LanguageSelector({ language, onLanguageChange, className = '' }: LanguageSelectorProps) {
  return (
    <div className={`flex justify-center gap-2 ${className}`}>
      <button
        onClick={() => onLanguageChange('en')}
        className={`px-4 py-2 rounded-lg font-medium transition-colors ${
          language === 'en'
            ? 'bg-slate-700 text-white'
            : 'bg-slate-200 text-slate-600 hover:bg-slate-300'
        }`}
      >
        English
      </button>
      <button
        onClick={() => onLanguageChange('ko')}
        className={`px-4 py-2 rounded-lg font-medium transition-colors ${
          language === 'ko'
            ? 'bg-slate-700 text-white'
            : 'bg-slate-200 text-slate-600 hover:bg-slate-300'
        }`}
      >
        한국어
      </button>
    </div>
  );
}
