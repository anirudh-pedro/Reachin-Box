import React, { useState } from 'react';
import { ArrowLeft, Star, Archive, Trash2, ChevronDown, ExternalLink, Menu, Check } from 'lucide-react';
import type { EmailJob } from '../types';

interface EmailDetailViewProps {
  email: EmailJob;
  onBack: () => void;
  onOpenMobileNav: () => void;
  isStarred?: boolean;
  onToggleStar?: () => void;
  onArchive?: () => void;
  onDelete?: () => Promise<void> | void;
}

function formatDetailDate(value?: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export const EmailDetailView: React.FC<EmailDetailViewProps> = ({
  email,
  onBack,
  onOpenMobileNav,
  isStarred = false,
  onToggleStar,
  onArchive,
  onDelete,
}) => {
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const senderEmail = email.sender?.email || 'reachinbox@domain.io';
  const senderName =
    email.sender?.name || (senderEmail.includes('@') ? senderEmail.split('@')[0] : 'Sender');
  const initial = (senderName.charAt(0) || 'S').toUpperCase();
  const shortRef = email.id ? email.id.slice(0, 8).toUpperCase() : '';

  const showNotification = (msg: string) => {
    setActionNotice(msg);
    setTimeout(() => setActionNotice(null), 2500);
  };

  const handleStarClick = () => {
    if (onToggleStar) {
      onToggleStar();
      showNotification(!isStarred ? 'Email starred' : 'Email unstarred');
    }
  };

  const handleArchiveClick = () => {
    if (onArchive) {
      onArchive();
    }
    showNotification('Email archived');
    setTimeout(() => {
      onBack();
    }, 600);
  };

  const handleDeleteClick = async () => {
    setIsDeleting(true);
    showNotification('Deleting email...');
    try {
      if (onDelete) {
        await onDelete();
      }
      showNotification('Email deleted');
      setTimeout(() => {
        onBack();
      }, 500);
    } catch {
      showNotification('Failed to delete email');
      setIsDeleting(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-white min-w-0">
      {/* Top Header Bar */}
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
            {email.subject || '(No Subject)'}
            {shortRef && <span className="font-normal text-gray-400 ml-1.5">| {shortRef}</span>}
          </h2>
        </div>

        {/* Right action icons */}
        <div className="flex items-center gap-4 text-gray-400 shrink-0">
          {/* Star Button */}
          <button
            type="button"
            onClick={handleStarClick}
            title={isStarred ? 'Unstar email' : 'Star email'}
            className="hover:text-amber-500 transition-colors cursor-pointer p-1"
          >
            <Star
              className={`w-4 h-4 transition-colors ${
                isStarred ? 'text-amber-400 fill-amber-400' : 'text-gray-400 hover:text-amber-500'
              }`}
            />
          </button>

          {/* Archive Button */}
          <button
            type="button"
            onClick={handleArchiveClick}
            title="Archive email"
            className="hover:text-gray-700 transition-colors cursor-pointer p-1"
          >
            <Archive className="w-4 h-4" />
          </button>

          {/* Delete Button */}
          <button
            type="button"
            onClick={handleDeleteClick}
            disabled={isDeleting}
            title="Delete email"
            className="hover:text-red-500 transition-colors cursor-pointer p-1 disabled:opacity-40"
          >
            <Trash2 className="w-4 h-4" />
          </button>

          <div className="w-7 h-7 rounded-full bg-[#00a854] text-white flex items-center justify-center text-xs font-semibold shrink-0">
            {initial}
          </div>
        </div>
      </div>

      {actionNotice && (
        <div className="mx-6 sm:mx-12 mt-3 p-2.5 bg-[#eaf5ed] border border-[#d2edd9] rounded-xl flex items-center gap-2 text-xs text-[#00a854] animate-fade-in">
          <Check className="w-4 h-4 shrink-0" />
          <span>{actionNotice}</span>
        </div>
      )}

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
                {formatDetailDate(email.sentAt || email.scheduledAt || email.createdAt)}
              </span>
            </div>
            <div className="flex items-center gap-1 text-xs text-gray-400 mt-0.5">
              <span>to {email.recipient}</span>
              <ChevronDown className="w-3 h-3 text-gray-400" />
            </div>
          </div>
        </div>

        {/* Real Email Body Content */}
        <div className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap py-2">
          {email.body || '(Empty email body)'}
        </div>

        {/* Ethereal preview link if present */}
        {email.etherealPreviewUrl && (
          <div className="mt-6 pt-4 border-t border-[#f0f0f0]">
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
