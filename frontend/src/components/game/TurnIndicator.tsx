export function TurnIndicator() {
  return (
    <div className="px-4 py-3 bg-slate-50 border-t border-slate-200">
      <div className="flex items-center gap-3 text-sm text-slate-600">
        <div className="relative">
          <div className="animate-spin h-5 w-5 border-2 border-slate-300 border-t-slate-700 rounded-full" />
        </div>
        <div className="flex flex-col">
          <span className="font-medium">Processing your action...</span>
          <span className="text-xs text-slate-400">The narrator is crafting a response</span>
        </div>
      </div>
    </div>
  );
}
