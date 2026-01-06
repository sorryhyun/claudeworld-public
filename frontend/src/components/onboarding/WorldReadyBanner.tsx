interface WorldReadyBannerProps {
  onEnterWorld: () => void;
}

export function WorldReadyBanner({ onEnterWorld }: WorldReadyBannerProps) {
  return (
    <div className="bg-gradient-to-r from-emerald-500 to-teal-500 text-white px-4 py-3 flex items-center justify-between shadow-lg">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center">
          <svg
            className="w-6 h-6"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"
            />
          </svg>
        </div>
        <div>
          <h4 className="font-bold text-lg">Your World is Ready!</h4>
          <p className="text-white/90 text-sm">
            The adventure awaits. Enter your world to begin playing.
          </p>
        </div>
      </div>
      <button
        onClick={onEnterWorld}
        className="px-6 py-2 bg-white text-emerald-600 rounded-lg font-bold hover:bg-emerald-50 active:bg-emerald-100 transition-colors shadow-md flex items-center gap-2"
      >
        <svg
          className="w-5 h-5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13 7l5 5m0 0l-5 5m5-5H6"
          />
        </svg>
        Enter World
      </button>
    </div>
  );
}
