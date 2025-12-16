import { StatDefinition } from '../../contexts/GameContext';

interface StatsDisplayProps {
  definitions: StatDefinition[];
  current: Record<string, number>;
}

export function StatsDisplay({ definitions, current }: StatsDisplayProps) {
  if (definitions.length === 0) {
    return (
      <div className="text-center py-6">
        <svg className="w-10 h-10 mx-auto mb-2 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
        <p className="text-sm text-slate-500">No stats defined yet</p>
        <p className="text-xs text-slate-400 mt-1">Stats will appear after world setup</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {definitions.map((stat) => {
        const value = current[stat.name] ?? stat.default;
        const percentage = stat.max ? (value / stat.max) * 100 : null;

        return (
          <div key={stat.name} className="group">
            <div className="flex justify-between text-sm mb-1.5">
              <span className="font-medium text-slate-700">{stat.display}</span>
              <span className="text-slate-500 tabular-nums">
                {value}
                {stat.max && <span className="text-slate-400"> / {stat.max}</span>}
              </span>
            </div>

            {/* Progress bar for bounded stats */}
            {stat.max && percentage !== null && (
              <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden shadow-inner">
                <div
                  className={`h-full transition-all duration-500 ease-out ${getStatColor(stat.name, percentage)}`}
                  style={{ width: `${Math.min(100, Math.max(0, percentage))}%` }}
                />
              </div>
            )}

            {/* Warning indicator */}
            {percentage !== null && percentage < 25 && (
              <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                Low!
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function getStatColor(statName: string, percentage: number): string {
  const lowerName = statName.toLowerCase();

  // Health-like stats
  if (['health', 'hp', 'vitality', 'life', 'hitpoints'].some(s => lowerName.includes(s))) {
    if (percentage < 25) return 'bg-red-500';
    if (percentage < 50) return 'bg-yellow-500';
    return 'bg-green-500';
  }

  // Mana/Energy-like stats
  if (['mana', 'mp', 'magic', 'energy', 'stamina', 'sp'].some(s => lowerName.includes(s))) {
    return 'bg-blue-500';
  }

  // Mental stats
  if (['sanity', 'stress', 'fear', 'morale', 'willpower'].some(s => lowerName.includes(s))) {
    if (percentage < 25) return 'bg-purple-700';
    if (percentage < 50) return 'bg-purple-500';
    return 'bg-purple-300';
  }

  // Currency/Resources
  if (['gold', 'money', 'coins', 'currency'].some(s => lowerName.includes(s))) {
    return 'bg-amber-500';
  }

  // Experience
  if (['exp', 'experience', 'xp'].some(s => lowerName.includes(s))) {
    return 'bg-emerald-500';
  }

  // Default
  return 'bg-slate-500';
}
