import React from 'react';
import { Search, Filter, RefreshCw, Star, Loader2, Inbox, Clock, AlertTriangle, Menu } from 'lucide-react';
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
}) => {
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
        </div>

        {/* Right utility buttons */}
        <div className="flex items-center gap-2 text-gray-400 shrink-0">
          <button
            type="button"
            title="Filter"
            className="p-2 rounded-full hover:text-gray-700 hover:bg-[#f4f5f7] transition-colors cursor-pointer"
          >
            <Filter className="w-4 h-4" />
          </button>
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
        {loading ? (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400 gap-3">
            <Loader2 className="w-6 h-6 animate-spin text-[#00a854]" />
            <span className="text-xs">Loading {mode} emails...</span>
          </div>
        ) : emails.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400 gap-2 px-4 text-center">
            <Inbox className="w-9 h-9 text-gray-300 mb-1" />
            <p className="text-sm font-medium text-gray-700">
              {mode === 'scheduled' ? 'No scheduled emails found' : 'No sent emails yet'}
            </p>
            <p className="text-xs text-gray-400">
              {mode === 'scheduled'
                ? 'Compose a new email to schedule a job.'
                : 'Delivered emails will show up here.'}
            </p>
          </div>
        ) : (
          emails.map((job) => {
            const recipientName = job.recipient.includes('@')
              ? job.recipient.split('@')[0].replace(/[._]/g, ' ')
              : job.recipient;
            const capitalizedRecipient =
              recipientName.charAt(0).toUpperCase() + recipientName.slice(1);

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
                {mode === 'scheduled' ? (
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

                {/* Star Icon */}
                <Star className="w-4 h-4 text-gray-300 hover:text-amber-400 transition-colors shrink-0 ml-auto cursor-pointer" />
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
