import React from 'react';
import { ArrowLeft, Star, Archive, Trash2, ChevronDown, ExternalLink, Menu } from 'lucide-react';
import type { EmailJob } from '../types';

interface EmailDetailViewProps {
  email: EmailJob;
  onBack: () => void;
  onOpenMobileNav: () => void;
}

function formatDetailDate(value?: string | null): string {
  if (!value) return 'Nov 3, 10:23 AM';
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export const EmailDetailView: React.FC<EmailDetailViewProps> = ({ email, onBack, onOpenMobileNav }) => {
  const senderEmail = email.sender?.email || 'sender@example.com';
  const senderName = email.sender?.name || 'Amanda Clark';
  const initial = (senderName.charAt(0) || 'A').toUpperCase();
  const shortRef = email.id ? email.id.slice(0, 8).toUpperCase() : 'MJWYT44 BM#52W01';

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-white min-w-0">
      {/* Top Header Bar matching Figma */}
      <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-[#f0f0f0]">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            title="Open menu"
            onClick={onOpenMobileNav}
            className="p-1.5 -ml-1 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors cursor-pointer md:hidden shrink-0"
          >
            <Menu className="w-5 h-5" />
          </button>
          <button
            type="button"
            onClick={onBack}
            className="text-gray-700 hover:text-black transition-colors cursor-pointer shrink-0"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h2 className="text-sm font-semibold text-gray-900 truncate">
            {email.subject || 'Oliver, hello there!'}
            <span className="font-normal text-gray-400 ml-1.5">| {shortRef}</span>
          </h2>
        </div>

        {/* Right action icons */}
        <div className="flex items-center gap-4 text-gray-400 shrink-0">
          <button type="button" title="Star" className="hover:text-amber-500 transition-colors cursor-pointer">
            <Star className="w-4 h-4" />
          </button>
          <button type="button" title="Archive" className="hover:text-gray-700 transition-colors cursor-pointer">
            <Archive className="w-4 h-4" />
          </button>
          <button type="button" title="Delete" className="hover:text-red-500 transition-colors cursor-pointer">
            <Trash2 className="w-4 h-4" />
          </button>
          <img
            src="https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=64&h=64&fit=crop&crop=faces"
            alt="Profile"
            className="w-7 h-7 rounded-full object-cover ml-1 shrink-0 border border-gray-100"
          />
        </div>
      </div>

      {/* Main Email Body Container */}
      <div className="flex-1 overflow-y-auto px-6 sm:px-12 py-6 max-w-4xl w-full">
        {/* Sender details row */}
        <div className="flex items-start gap-3.5 pb-6">
          <div className="w-9 h-9 rounded-full bg-[#00a854] text-white flex items-center justify-center text-sm font-semibold shrink-0">
            {initial}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm">
                <span className="font-semibold text-gray-900">{senderName}</span>
                <span className="text-gray-400 ml-1">&lt;{senderEmail}&gt;</span>
              </div>
              <span className="text-xs text-gray-400 whitespace-nowrap">
                {formatDetailDate(email.sentAt || email.scheduledAt)}
              </span>
            </div>
            <div className="flex items-center gap-1 text-xs text-gray-400 mt-0.5">
              <span>to me</span>
              <ChevronDown className="w-3 h-3 text-gray-400" />
            </div>
          </div>
        </div>

        {/* Email Prose Content */}
        <div className="text-sm text-gray-800 leading-relaxed space-y-4">
          <p>Hey Oliver,</p>
          <p>You&apos;ve just RECEIVED something</p>

          {/* Figma Golden Callout Box */}
          <div className="my-5 p-4 bg-[#fffde7] border-l-4 border-[#eab308] rounded-r-xl space-y-2 text-xs sm:text-sm text-gray-900 font-medium">
            <p className="flex items-center gap-1.5">
              <span>⚡</span>
              <span className="font-bold">Extremely Exclusive—Only 4 Spots Worldwide Per Year | $25,000 investment</span>
              <span>⚡</span>
            </p>
            <p className="flex items-center gap-1.5 text-gray-700 font-normal">
              <span>⚡</span>
              <span>To explore securing your private transformation, simply reply right now with <strong>&quot;FLY OUT FIX&quot;</strong>.</span>
            </p>
          </div>

          {email.body && email.body !== 'Meeting follow-up' && (
            <div className="py-2 text-gray-700 whitespace-pre-wrap">
              {email.body}
            </div>
          )}

          <p className="pt-2">Your coach for world-class performance,</p>
          <p className="font-medium text-gray-900">Grant</p>
          <p className="text-xs text-gray-500 italic">
            P.S. Always remember that you can develop world class technique! 🚀
          </p>
        </div>

        {/* Figma Attachment Cards */}
        <div className="mt-8 pt-6 border-t border-[#f0f0f0]">
          <div className="flex flex-wrap gap-4">
            {/* Attachment 1 */}
            <div className="w-48 bg-white border border-[#e5e7eb] rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow">
              <div className="h-28 bg-[#2563eb] relative overflow-hidden flex items-center justify-center">
                <img
                  src="https://images.unsplash.com/photo-1554068865-24cecd4e34b8?w=300&h=200&fit=crop"
                  alt="Tennis Coach Profile"
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="p-3 bg-white">
                <p className="text-xs font-semibold text-gray-800 truncate">Tennis_Coach_Profile.png</p>
                <p className="text-[10px] text-gray-400 mt-0.5">1.2 MB</p>
              </div>
            </div>

            {/* Attachment 2 */}
            <div className="w-48 bg-white border border-[#e5e7eb] rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow">
              <div className="h-28 bg-[#2563eb] relative overflow-hidden flex items-center justify-center">
                <img
                  src="https://images.unsplash.com/photo-1554068865-24cecd4e34b8?w=300&h=200&fit=crop"
                  alt="Tennis Coach Profile 2"
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="p-3 bg-white">
                <p className="text-xs font-semibold text-gray-800 truncate">Tennis_Coach_Profile2.png</p>
                <p className="text-[10px] text-gray-400 mt-0.5">1.2 MB</p>
              </div>
            </div>
          </div>
        </div>

        {/* Ethereal preview link if present */}
        {email.etherealPreviewUrl && (
          <div className="mt-6">
            <a
              href={email.etherealPreviewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-[#00a854] hover:underline"
            >
              <span>View delivered message in Ethereal SMTP</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        )}
      </div>
    </div>
  );
};
