import { BadgeCheck, Sparkles } from 'lucide-react';

const confettiPieces = Array.from({ length: 24 }, (_, index) => ({
  left: `${(index * 37) % 100}%`,
  delay: `${(index % 8) * 90}ms`,
  hue: index % 3 === 0 ? 'lime' : index % 3 === 1 ? 'emerald' : 'yellow',
}));

export const OnboardingCompletionCelebration = ({ title = 'Profile complete', message = 'Taking you to your Examifying home…' }) => (
  <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/80 px-4 backdrop-blur-sm" role="status" aria-live="polite">
    <style>{`
      @keyframes onboarding-confetti-fall {
        0% { transform: translate3d(0, -12vh, 0) rotate(0deg); opacity: 0; }
        10% { opacity: 1; }
        100% { transform: translate3d(28px, 105vh, 0) rotate(640deg); opacity: 0; }
      }
    `}</style>
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {confettiPieces.map((piece, index) => (
        <span
          key={index}
          className={`absolute top-0 h-3 w-2 rounded-sm ${piece.hue === 'lime' ? 'bg-lime-300' : piece.hue === 'emerald' ? 'bg-emerald-400' : 'bg-yellow-300'}`}
          style={{ left: piece.left, animation: `onboarding-confetti-fall ${1900 + (index % 5) * 260}ms ${piece.delay} ease-in forwards` }}
        />
      ))}
    </div>
    <section className="relative w-full max-w-md rounded-3xl border border-lime-300/30 bg-slate-900 p-7 text-center shadow-2xl shadow-lime-950/40">
      <span className="mx-auto grid h-14 w-14 place-items-center rounded-full border border-lime-300/50 bg-lime-300/15 text-lime-200">
        <BadgeCheck className="h-7 w-7" aria-hidden="true" />
      </span>
      <h1 className="mt-4 text-2xl font-bold text-white">{title}</h1>
      <p className="mt-2 text-sm leading-6 text-slate-300">{message}</p>
      <Sparkles className="mx-auto mt-4 h-5 w-5 text-lime-300" aria-hidden="true" />
    </section>
  </div>
);
