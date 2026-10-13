import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export const MultiSelectDropdown = ({
  choices = [],
  selectedValues = [],
  onChange,
  maxSelections = Number.POSITIVE_INFINITY,
  placeholder = 'Choose items',
  emptyMessage = 'No options available',
  ariaLabel = 'Choose multiple items',
  id,
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef(null);
  const panelId = useId();
  const groupedChoices = choices.reduce((groups, choice) => {
    const item = typeof choice === 'string' ? { value: choice, label: choice } : choice;
    const group = item.group || '';
    const current = groups.get(group) ?? [];
    current.push(item);
    groups.set(group, current);
    return groups;
  }, new Map());

  useEffect(() => {
    if (!isOpen) return undefined;
    const closeOnOutsideClick = (event) => {
      if (!rootRef.current?.contains(event.target)) setIsOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('touchstart', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('touchstart', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  const toggleChoice = (value) => {
    const isSelected = selectedValues.includes(value);
    if (isSelected) {
      onChange(selectedValues.filter((selected) => selected !== value));
      return;
    }
    if (selectedValues.length >= maxSelections) return;
    onChange([...selectedValues, value]);
  };

  const renderChoice = (choice) => {
    const checked = selectedValues.includes(choice.value);
    const atLimit = !checked && selectedValues.length >= maxSelections;
    return (
      <label key={choice.value} className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition ${checked ? 'border-lime-400/30 bg-lime-400/15 font-semibold text-lime-300 shadow-[0_0_15px_rgba(163,230,53,0.15)]' : 'border-transparent text-slate-200 hover:bg-slate-800/80 hover:text-slate-100'} ${atLimit ? 'cursor-not-allowed opacity-50' : ''}`}>
        <input
          type="checkbox"
          checked={checked}
          onChange={() => toggleChoice(choice.value)}
          disabled={disabled || atLimit}
          className="h-4 w-4 rounded border-slate-500 accent-lime-400"
        />
        <span className="min-w-0 flex-1">{choice.label}</span>
        {checked ? <Check className="h-4 w-4 shrink-0 text-lime-300" aria-hidden="true" /> : null}
      </label>
    );
  };

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        id={id}
        className="input flex min-h-11 w-full items-center justify-between gap-3 text-left"
        aria-label={ariaLabel}
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={() => setIsOpen((open) => !open)}
        disabled={disabled}
      >
        <span className={selectedValues.length ? 'truncate text-slate-900' : 'truncate text-slate-500'}>
          {selectedValues.length ? `${selectedValues.length} selected` : placeholder}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {isOpen ? (
        <div id={panelId} className="absolute z-30 mt-2 w-full min-w-64 overflow-hidden rounded-xl border border-slate-700 bg-slate-950 shadow-xl shadow-black/40">
          <div className="max-h-64 overflow-y-auto p-2">
            {!choices.length ? <p className="px-3 py-4 text-sm text-slate-400">{emptyMessage}</p> : [...groupedChoices.entries()].map(([group, items]) => (
              <div key={group || 'ungrouped'} className="space-y-1">
                {group ? <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">{group}</p> : null}
                {items.map(renderChoice)}
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-slate-800 bg-slate-900 px-3 py-2.5">
            {Number.isFinite(maxSelections) ? <span className="text-xs text-slate-300">{selectedValues.length} of {maxSelections} allowed</span> : <span className="text-xs text-slate-300">{selectedValues.length} selected</span>}
            <button type="button" className="btn-primary px-4 py-2 text-sm" onClick={() => setIsOpen(false)}>Done</button>
          </div>
        </div>
      ) : null}
    </div>
  );
};
