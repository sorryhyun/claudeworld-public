import { useState, useEffect, useMemo, memo, useCallback, useRef } from "react";
import { useGame } from "../../contexts/GameContext";
import * as gameService from "../../services/gameService";

interface Agent {
  id: number;
  name: string;
  profile_pic: string | null;
  in_a_nutshell: string | null;
  location_id: number;
  location_name: string;
}

// Memoized agent card component
interface AgentCardProps {
  agent: Agent;
  isHere: boolean;
  isExpanded: boolean;
  onToggleExpand: (id: number) => void;
}

const AgentCard = memo(function AgentCard({
  agent,
  isHere,
  isExpanded,
  onToggleExpand,
}: AgentCardProps) {
  return (
    <div
      className={`bg-white rounded-lg border transition-all overflow-hidden ${
        isHere
          ? "border-blue-200 hover:border-blue-300 shadow-sm"
          : "border-slate-200 hover:border-slate-300 opacity-75"
      }`}
    >
      <button
        onClick={() => onToggleExpand(agent.id)}
        className="w-full p-3 text-left"
      >
        <div className="flex items-start gap-3">
          {/* Profile picture */}
          <div
            className={`shrink-0 w-10 h-10 rounded-full overflow-hidden flex items-center justify-center ${
              isHere ? "bg-blue-50 ring-2 ring-blue-200" : "bg-slate-100"
            }`}
          >
            {agent.profile_pic ? (
              <img
                src={agent.profile_pic}
                alt={agent.name}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            ) : (
              <svg
                className={`w-5 h-5 ${isHere ? "text-blue-400" : "text-slate-400"}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                />
              </svg>
            )}
          </div>

          {/* Agent info */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between">
              <span
                className={`font-medium text-sm truncate ${isHere ? "text-slate-800" : "text-slate-600"}`}
              >
                {agent.name}
              </span>
              <svg
                className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${
                  isExpanded ? "rotate-180" : ""
                }`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </div>
            {!isHere && (
              <div className="flex items-center gap-1 mt-0.5">
                <svg
                  className="w-3 h-3 text-slate-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
                <span className="text-xs text-slate-500 truncate">
                  {agent.location_name}
                </span>
              </div>
            )}
          </div>
        </div>
      </button>

      {/* Expanded content */}
      {isExpanded && agent.in_a_nutshell && (
        <div className="px-3 pb-3 border-t border-slate-100">
          <p className="text-xs text-slate-600 mt-2 leading-relaxed">
            {agent.in_a_nutshell}
          </p>
        </div>
      )}
    </div>
  );
});

export function AgentsList() {
  const { world, currentLocation, isChatMode } = useGame();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const isInitialFetch = useRef(true);

  useEffect(() => {
    if (!world?.id) return;

    const fetchAgents = async () => {
      // Only show loading spinner on initial fetch, not on refetch due to travel
      if (isInitialFetch.current) {
        setLoading(true);
      }
      try {
        const characters = await gameService.getWorldCharacters(world.id);
        setAgents(characters);
      } catch (error) {
        console.error("Failed to fetch agents:", error);
      } finally {
        setLoading(false);
        isInitialFetch.current = false;
      }
    };

    fetchAgents();
    // Refetch agents when location changes (travel) to sync NPC positions
  }, [world?.id, currentLocation?.id]);

  // Memoized toggle handler
  const handleToggleExpand = useCallback((id: number) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  // Split agents by current location
  const { agentsHere, agentsElsewhere } = useMemo(() => {
    if (!currentLocation) {
      return { agentsHere: [], agentsElsewhere: agents };
    }
    return {
      agentsHere: agents.filter((a) => a.location_id === currentLocation.id),
      agentsElsewhere: agents.filter(
        (a) => a.location_id !== currentLocation.id,
      ),
    };
  }, [agents, currentLocation]);

  if (loading) {
    return (
      <div className="text-center py-6">
        <div className="w-6 h-6 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin mx-auto mb-2" />
        <p className="text-sm text-slate-500">Loading agents...</p>
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="text-center py-6">
        <svg
          className="w-10 h-10 mx-auto mb-2 text-slate-300"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
          />
        </svg>
        <p className="text-sm text-slate-500">No characters yet</p>
        <p className="text-xs text-slate-400 mt-1">
          Characters will appear as you explore
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Characters at current location */}
      {agentsHere.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-blue-600 uppercase tracking-wide">
              Here
            </span>
            {isChatMode && (
              <span className="text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-600 rounded-full">
                chatting
              </span>
            )}
          </div>
          {agentsHere.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              isHere={true}
              isExpanded={expandedId === agent.id}
              onToggleExpand={handleToggleExpand}
            />
          ))}
        </div>
      )}

      {/* Characters elsewhere */}
      {agentsElsewhere.length > 0 && (
        <div className="space-y-2">
          {agentsHere.length > 0 && (
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wide">
              Elsewhere
            </span>
          )}
          {agentsElsewhere.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              isHere={false}
              isExpanded={expandedId === agent.id}
              onToggleExpand={handleToggleExpand}
            />
          ))}
        </div>
      )}

      {/* Agent count */}
      {agents.length > 0 && (
        <div className="text-center pt-2 border-t border-slate-100">
          <p className="text-xs text-slate-400">
            {agentsHere.length} here · {agents.length} total
          </p>
        </div>
      )}
    </div>
  );
}
