interface ConnectionStatusProps {
  isConnected: boolean;
}

export const ConnectionStatus = ({ isConnected }: ConnectionStatusProps) => {
  return (
    <div className="flex items-center gap-1">
      <div className={`w-2.5 h-2.5 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
      <span className="text-mobile-sm text-slate-500 hidden sm:inline">
        {isConnected ? 'Connected' : 'Disconnected'}
      </span>
    </div>
  );
};
