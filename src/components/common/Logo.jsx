export const Logo = ({ className = '', showText = true }) => (
  <div className={`inline-flex items-center gap-3 ${className}`}>
    <img src="/logo.png" alt={showText ? '' : 'Examifying'} className="h-10 w-10 shrink-0 object-contain drop-shadow-lg sm:h-11 sm:w-11" />
    {showText ? (
      <div>
        <div>
          <p className="bg-gradient-to-r from-lime-400 via-lime-300 to-emerald-400 bg-clip-text text-base font-bold tracking-tight text-transparent sm:text-lg">Examifying</p>
        </div>
        <p className="hidden sm:block text-xs text-slate-400">Subject mastery • 70-20-10 learning</p>
      </div>
    ) : null}
  </div>
);
