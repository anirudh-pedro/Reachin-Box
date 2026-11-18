import React, { useState } from 'react';
import { ChevronDown, Clock, Send, LogOut, MessageSquare, X } from 'lucide-react';
import type { User, SlackStatus } from '../types';

interface SidebarProps {
  user: User;
  activeTab: 'scheduled' | 'sent';
  onTabChange: (tab: 'scheduled' | 'sent') => void;
  onCompose: () => void;
  scheduledCount: number;
  sentCount: number;
  slackStatus: SlackStatus;
  onOpenSlackModal: () => void;
  onLogout: () => void;
  isOpen: boolean;
  onCloseMobile: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  user,
  activeTab,
  onTabChange,
  onCompose,
  scheduledCount,
  sentCount,
  slackStatus,
  onOpenSlackModal,
  onLogout,
  isOpen,
  onCloseMobile,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);

  const displayName = user.name || 'Oliver Brown';
  const displayEmail = user.email || 'oliver.brown@domain.io';
  const avatarUrl =
    user.avatar || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=64&h=64&fit=crop&crop=faces';

  return (
    <>
      {/* Backdrop for mobile */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-40 md:hidden"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}

      <aside
        className={`flex flex-col h-screen overflow-y-auto bg-white border-r border-[#f0f0f0]
          fixed top-0 left-0 z-50 w-64 px-4 py-6
          transition-transform duration-200 ease-out
          ${isOpen ? 'translate-x-0' : '-translate-x-full'}
          md:sticky md:translate-x-0 md:top-0 md:z-0 md:w-64`}
      >
        {/* Logo */}
        <div className="mb-6 px-2 flex items-center justify-between">
          <span className="text-2xl font-black tracking-tighter text-black">ONB</span>
          <button
            type="button"
            onClick={onCloseMobile}
            className="md:hidden p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors cursor-pointer"
            aria-label="Close menu"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* User Profile Card */}
        <div className="relative mb-5">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="w-full bg-[#f4f5f7] hover:bg-[#eceef2] rounded-2xl p-2.5 flex items-center justify-between transition-colors cursor-pointer text-left"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <img
                src={avatarUrl}
                alt={displayName}
                className="w-8 h-8 rounded-full object-cover shrink-0"
              />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-gray-900 truncate">{displayName}</div>
                <div className="text-[10px] text-gray-400 truncate">{displayEmail}</div>
              </div>
            </div>
            <ChevronDown
              className={`w-3.5 h-3.5 text-gray-400 transition-transform shrink-0 ml-1 ${
                menuOpen ? 'rotate-180' : ''
              }`}
            />
          </button>

          {/* Profile Dropdown Menu */}
          {menuOpen && (
            <div className="absolute left-0 right-0 mt-1.5 bg-white border border-gray-100 rounded-xl shadow-lg z-30 overflow-hidden animate-fade-in">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenSlackModal();
                }}
                className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-xs text-gray-700 hover:bg-[#f4f5f7] transition-colors cursor-pointer"
              >
                <MessageSquare className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                <span className="truncate">
                  {slackStatus.connected ? `Slack: ${slackStatus.channel || 'Connected'}` : 'Slack Integration'}
                </span>
                {slackStatus.connected && (
                  <span className="w-2 h-2 rounded-full bg-[#00a854] ml-auto shrink-0" />
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onLogout();
                }}
                className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-xs text-red-600 hover:bg-red-50 transition-colors cursor-pointer border-t border-gray-50"
              >
                <LogOut className="w-3.5 h-3.5 shrink-0" />
                <span>Logout</span>
              </button>
            </div>
          )}
        </div>

        {/* Compose Button */}
        <button
          type="button"
          onClick={onCompose}
          className="w-full mb-6 py-2 px-6 rounded-full border-[1.5px] border-[#00a854] text-[#00a854] font-medium text-sm hover:bg-[#eaf5ed]/50 transition-colors cursor-pointer text-center"
        >
          Compose
        </button>

        {/* Navigation Core Section */}
        <div className="px-1">
          <p className="text-[10px] font-bold text-gray-400 tracking-wider uppercase mb-2 px-1">CORE</p>
          <nav className="space-y-1">
            <button
              type="button"
              onClick={() => onTabChange('scheduled')}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition-colors cursor-pointer ${
                activeTab === 'scheduled'
                  ? 'bg-[#eaf5ed] text-[#111827]'
                  : 'text-gray-700 hover:bg-[#f4f5f7]'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Clock className="w-3.5 h-3.5 shrink-0" />
                <span>Scheduled</span>
              </div>
              <span className="text-xs text-gray-500 font-normal">
                {scheduledCount}
              </span>
            </button>

            <button
              type="button"
              onClick={() => onTabChange('sent')}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition-colors cursor-pointer ${
                activeTab === 'sent'
                  ? 'bg-[#eaf5ed] text-[#111827]'
                  : 'text-gray-700 hover:bg-[#f4f5f7]'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Send className="w-3.5 h-3.5 shrink-0" />
                <span>Sent</span>
              </div>
              <span className="text-xs text-gray-500 font-normal">
                {sentCount}
              </span>
            </button>
          </nav>
        </div>
      </aside>
    </>
  );
};
