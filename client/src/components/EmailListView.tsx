import React, { useState } from 'react';
import { Search, Filter, RefreshCw, Star, Loader2, Inbox, Clock, AlertTriangle, Menu, ArrowUpDown, Check, Archive } from 'lucide-react';
import type { EmailJob } from '../types';

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface EmailListViewProps {
  mode: 'scheduled' | 'sent';
  emails: EmailJob[];
  loading: boolean;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onRefresh: () => void;
  pagination: Pagination;
  onPageChange: (p: number) => void;
  onSelectEmail: (email: EmailJob) => void;
  onOpenMobileNav: () => void;
  starredIds?: Record<string, boolean>;
  onToggleStar?: (id: string) => void;
  archivedIds?: Record<string, boolean>;
}

function formatTime(value?: string | null): string {
  if (!value) return '';
  return new Date(value).toLocaleString('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

function snippet(body: string, max = 80): string {
  const clean = body.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

export const EmailListView: React.FC<EmailListViewProps> = ({
  mode,
  emails,
  loading,
  searchQuery,
  onSearchChange,
  onRefresh,
  pagination,
  onPageChange,
  onSelectEmail,
  onOpenMobileNav,
  starredIds = {},
  onToggleStar,
  archivedIds = {},
}) => {
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [filterStarredOnly, setFilterStarredOnly] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [sortByNewest, setSortByNewest] = useState(true);

  const toggleStar = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (onToggleStar) {
      onToggleStar(id);
    }
  };

  // Local filtering & sorting
  let displayedEmails = [...emails];
  if (!showArchived) {
    displayedEmails = displayedEmails.filter((e) => !archivedIds[e.id]);
  }
  if (filterStarredOnly) {
    displayedEmails = displayedEmails.filter((e) => starredIds[e.id]);
  }
  if (!sortByNewest) {
    displayedEmails.reverse();
  }

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-white min-w-0">
      {/* Top Toolbar matching Figma */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-[#f0f0f0]">
        <button
          type="button"
          title="Open menu"
          onClick={onOpenMobileNav}
          className="p-2 -ml-2 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors cursor-pointer md:hidden shrink-0"
        >
          <Menu className="w-5 h-5" />
        </button>

        {/* Wide Pill Search Bar */}
        <div className="relative flex-1 max-w-2xl bg-[#f4f5f7] rounded-full px-4 py-2 flex items-center gap-2.5">
          <Search className="w-4 h-4 text-gray-400 shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search"
            className="w-full bg-transparent text-sm text-gray-800 placeholder-gray-400 focus:outline-none"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => onSearchChange('')}
              className="text-xs text-gray-400 hover:text-black cursor-pointer p-0.5"
            >
              ✕
            </button>
          )}
        </div>

        {/* Right utility buttons */}
        <div className="relative flex items-center gap-2 text-gray-400 shrink-0">
          <div className="relative">
            <button
              type="button"
              title="Filter"
              onClick={() => setShowFilterMenu((v) => !v)}
              className={`p-2 rounded-full transition-colors cursor-pointer ${
                filterStarredOnly || showArchived || showFilterMenu
                  ? 'text-[#00a854] bg-[#eaf5ed]'
                  : 'hover:text-gray-700 hover:bg-[#f4f5f7]'
              }`}
            >
              <Filter className="w-4 h-4" />
            </button>

            {/* Filter Dropdown */}
            {showFilterMenu && (
              <div className="absolute right-0 top-full mt-2 w-52 bg-white border border-[#edf0f2] rounded-xl shadow-lg z-30 py-2 animate-fade-in text-xs text-gray-700">
                <button
                  type="button"
                  onClick={() => {
                    setFilterStarredOnly((v) => !v);
                    setShowFilterMenu(false);
                  }}
                  className="w-full flex items-center justify-between px-3.5 py-2 hover:bg-[#f4f5f7] cursor-pointer"
                >
                  <span className="flex items-center gap-2">
                    <Star className="w-3.5 h-3.5 text-amber-500" />
                    <span>Starred only</span>
                  </span>
                  {filterStarredOnly && <Check className="w-3.5 h-3.5 text-[#00a854]" />}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setShowArchived((v) => !v);
                    setShowFilterMenu(false);
                  }}
                  className="w-full flex items-center justify-between px-3.5 py-2 hover:bg-[#f4f5f7] cursor-pointer border-t border-gray-50"
                >
                  <span className="flex items-center gap-2">
                    <Archive className="w-3.5 h-3.5 text-gray-500" />
                    <span>Show archived</span>
                  </span>
                  {showArchived && <Check className="w-3.5 h-3.5 text-[#00a854]" />}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setSortByNewest((v) => !v);
                    setShowFilterMenu(false);
                  }}
                  className="w-full flex items-center justify-between px-3.5 py-2 hover:bg-[#f4f5f7] cursor-pointer border-t border-gray-50"
                >
                  <span className="flex items-center gap-2">
                    <ArrowUpDown className="w-3.5 h-3.5 text-gray-400" />
                    <span>{sortByNewest ? 'Newest first' : 'Oldest first'}</span>
                  </span>
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            title="Refresh"
            onClick={onRefresh}
            className="p-2 rounded-full hover:text-gray-700 hover:bg-[#f4f5f7] transition-colors cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-[#00a854]' : ''}`} />
          </button>
        </div>
      </div>

      {/* Email List Content */}
      <div className="flex-1 overflow-y-auto">
        {loading && displayedEmails.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400 gap-3">
            <Loader2 className="w-6 h-6 animate-spin text-[#00a854]" />
            <span className="text-xs">Loading {mode} emails...</span>
          </div>
        ) : displayedEmails.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400 gap-2 px-4 text-center">
            <Inbox className="w-9 h-9 text-gray-300 mb-1" />
            <p className="text-sm font-medium text-gray-700">
              {filterStarredOnly
                ? 'No starred emails found'
                : showArchived
                ? 'No archived emails found'
                : mode === 'scheduled'
                ? 'No scheduled emails found'
                : 'No sent emails yet'}
            </p>
            <p className="text-xs text-gray-400">
              {mode === 'scheduled'
                ? 'Compose a new email to schedule a job.'
                : 'Delivered emails will show up here.'}
            </p>
          </div>
        ) : (
          displayedEmails.map((job) => {
            const recipientName = job.recipient.includes('@')
              ? job.recipient.split('@')[0].replace(/[._]/g, ' ')
              : job.recipient;
            const capitalizedRecipient =
              recipientName.charAt(0).toUpperCase() + recipientName.slice(1);
            const isStarred = Boolean(starredIds[job.id]);
            const isArchived = Boolean(archivedIds[job.id]);

            return (
              <div
                key={job.id}
                onClick={() => onSelectEmail(job)}
                className="w-full flex items-center gap-3 sm:gap-4 px-4 sm:px-6 py-3.5 border-b border-[#f4f5f7] hover:bg-[#fafafa] transition-colors cursor-pointer text-left"
              >
                {/* Recipient */}
                <span className="text-sm font-semibold text-gray-900 w-28 sm:w-36 shrink-0 truncate">
                  To: {capitalizedRecipient}
                </span>

                {/* Status Badge */}
                {isArchived ? (
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs font-medium shrink-0">
                    Archived
                  </span>
                ) : mode === 'scheduled' ? (
                  job.status === 'RATE_LIMITED' ? (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700 text-xs font-medium shrink-0">
                      <AlertTriangle className="w-3 h-3 text-amber-600" />
                      <span>{formatTime(job.scheduledAt)}</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-[#ffeada] text-[#d97706] text-xs font-medium shrink-0">
                      <Clock className="w-3 h-3 text-[#d97706]" />
                      <span>{formatTime(job.scheduledAt)}</span>
                    </span>
                  )
                ) : (
                  <span className="inline-flex items-center px-3 py-0.5 rounded-full bg-[#f3f4f6] text-[#6b7280] text-xs font-medium shrink-0">
                    {job.status === 'SENT' ? 'Sent' : 'Failed'}
                  </span>
                )}

                {/* Subject & Snippet Preview */}
                <div className="flex-1 min-w-0 truncate text-sm">
                  <span className="font-semibold text-gray-900">{job.subject}</span>
                  <span className="text-gray-400 font-normal ml-1">- {snippet(job.body)}</span>
                </div>

                {/* Star Icon with working toggle */}
                <button
                  type="button"
                  onClick={(e) => toggleStar(e, job.id)}
                  title={isStarred ? 'Unstar email' : 'Star email'}
                  className="p-1 -mr-1 rounded-full hover:bg-gray-100 transition-colors cursor-pointer ml-auto shrink-0"
                >
                  <Star
                    className={`w-4 h-4 transition-colors ${
                      isStarred ? 'text-amber-400 fill-amber-400' : 'text-gray-300 hover:text-amber-400'
                    }`}
                  />
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* Pagination Bar */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between px-6 py-3 border-t border-[#f0f0f0] text-xs text-gray-500">
          <span>
            Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onPageChange(pagination.page - 1)}
              disabled={pagination.page <= 1}
              className="px-3 py-1 rounded-lg border border-gray-200 text-gray-600 disabled:opacity-40 hover:bg-[#f4f5f7] transition-colors cursor-pointer"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => onPageChange(pagination.page + 1)}
              disabled={pagination.page >= pagination.totalPages}
              className="px-3 py-1 rounded-lg border border-gray-200 text-gray-600 disabled:opacity-40 hover:bg-[#f4f5f7] transition-colors cursor-pointer"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
