import React, { useState, useRef } from 'react';
import { Calendar } from 'lucide-react';

interface SendLaterPopoverProps {
  onCancel: () => void;
  onDone: (isoDate: string) => void;
}

const PRESETS = [
  { label: 'Tomorrow', hour: 9 },
  { label: 'Tomorrow, 10:00 AM', hour: 10 },
  { label: 'Tomorrow, 11:00 AM', hour: 11 },
  { label: 'Tomorrow, 3:00 PM', hour: 15 },
];

export const SendLaterPopover: React.FC<SendLaterPopoverProps> = ({ onCancel, onDone }) => {
  const [customDate, setCustomDate] = useState('');
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handlePresetClick = (preset: { label: string; hour: number }) => {
    setSelectedPreset(preset.label);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(preset.hour, 0, 0, 0);
    // Format to YYYY-MM-DDTHH:mm for datetime-local input
    const localIso = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    setCustomDate(localIso);
  };

  const handleDone = () => {
    if (customDate) {
      onDone(new Date(customDate).toISOString());
    } else {
      // Default to tomorrow 9:00 AM if done clicked without pick
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      onDone(tomorrow.toISOString());
    }
  };

  const handleContainerClick = () => {
    if (inputRef.current) {
      try {
        if ('showPicker' in HTMLInputElement.prototype) {
          inputRef.current.showPicker();
        } else {
          inputRef.current.focus();
        }
      } catch {
        inputRef.current.focus();
      }
    }
  };

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="absolute right-0 top-full mt-2 w-80 bg-white border border-[#edf0f2] rounded-2xl shadow-xl z-50 p-5 animate-fade-in"
    >
      {/* Title */}
      <h3 className="text-sm font-bold text-gray-900 mb-3.5">Send Later</h3>

      {/* Date/Time Input */}
      <div
        className="relative mb-3.5 cursor-pointer"
        onClick={handleContainerClick}
      >
        <input
          ref={inputRef}
          type="datetime-local"
          value={customDate}
          onChange={(e) => {
            setCustomDate(e.target.value);
            setSelectedPreset(null);
          }}
          className="w-full bg-[#f4f5f7] text-xs text-gray-700 rounded-xl px-3.5 py-2.5 focus:outline-none focus:ring-1 focus:ring-[#00a854] cursor-pointer"
        />
        {!customDate && (
          <div className="absolute inset-0 bg-[#f4f5f7] rounded-xl px-3.5 py-2.5 flex items-center justify-between pointer-events-none text-xs text-gray-400">
            <span>Pick date & time</span>
            <Calendar className="w-4 h-4 text-gray-400" />
          </div>
        )}
      </div>

      {/* Quick Presets matching Figma */}
      <div className="space-y-2 py-1 mb-4">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => handlePresetClick(p)}
            className={`w-full text-left text-xs py-1 transition-colors cursor-pointer block ${
              selectedPreset === p.label ? 'font-semibold text-[#00a854]' : 'text-gray-600 hover:text-black'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="text-xs font-medium text-gray-700 hover:text-black transition-colors cursor-pointer px-2"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleDone}
          className="px-5 py-1 rounded-full border border-[#00a854] text-[#00a854] font-semibold text-xs hover:bg-[#eaf5ed]/50 transition-colors cursor-pointer"
        >
          Done
        </button>
      </div>
    </div>
  );
};
