import React, { useRef, useState } from 'react';
import {
  ArrowLeft,
  Paperclip,
  Clock,
  Upload,
  Undo2,
  Redo2,
  Type,
  Bold,
  Italic,
  Underline,
  AlignLeft,
  ChevronsUpDown,
  ListOrdered,
  List,
  Indent,
  Outdent,
  Quote,
  Image as ImageIcon,
  Strikethrough,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Menu,
  X,
} from 'lucide-react';
import type { SenderAccount } from '../types';
import { api } from '../services/api';
import { SendLaterPopover } from './SendLaterPopover';

interface ComposeViewProps {
  senders: SenderAccount[];
  onClose: () => void;
  onScheduledSuccess: () => void;
  onOpenMobileNav: () => void;
}

interface Attachment {
  id: string;
  file?: File;
  name: string;
  previewUrl: string;
}

const VISIBLE_CHIP_LIMIT = 3;

function extractEmails(text: string): string[] {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(emailRegex) || [];
  return Array.from(new Set(matches));
}

export const ComposeView: React.FC<ComposeViewProps> = ({
  senders,
  onClose,
  onScheduledSuccess,
  onOpenMobileNav,
}) => {
  const [senderId, setSenderId] = useState('');
  const [recipients, setRecipients] = useState<string[]>([]);
  const [recipientInput, setRecipientInput] = useState('');
  const [showAllChips, setShowAllChips] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [history, setHistory] = useState<string[]>(['']);
  const [historyIndex, setHistoryIndex] = useState(0);

  const [delayBetweenEmails, setDelayBetweenEmails] = useState('');
  const [hourlyLimit, setHourlyLimit] = useState('');

  // Default sample attachment matching Figma designs
  const [attachments, setAttachments] = useState<Attachment[]>([
    {
      id: 'default-tennis-1',
      name: 'Tennis_Coach_Profile.png',
      previewUrl: 'https://images.unsplash.com/photo-1554068865-24cecd4e34b8?w=300&h=200&fit=crop',
    },
  ]);

  const [showSendLater, setShowSendLater] = useState(false);
  const [scheduledIso, setScheduledIso] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [csvFeedback, setCsvFeedback] = useState<{
    filename: string;
    validCount: number;
    duplicatesRemoved: number;
    invalidCount: number;
  } | null>(null);

  const csvInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const defaultFromEmail =
    senders.find((s) => s.id === senderId)?.email || senders[0]?.email || 'oliver.brown@domain.io';

  // Body state update with undo history tracking
  const updateBody = (newBody: string) => {
    setBody(newBody);
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newBody);
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
  };

  const handleUndo = () => {
    if (historyIndex > 0) {
      const newIdx = historyIndex - 1;
      setHistoryIndex(newIdx);
      setBody(history[newIdx]);
    }
  };

  const handleRedo = () => {
    if (historyIndex < history.length - 1) {
      const newIdx = historyIndex + 1;
      setHistoryIndex(newIdx);
      setBody(history[newIdx]);
    }
  };

  // Text formatting utilities for rich text toolbar
  const applyWrapFormat = (prefix: string, suffix: string = prefix, defaultPlaceholder = 'text') => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = body.slice(start, end) || defaultPlaceholder;
    const replacement = `${prefix}${selected}${suffix}`;
    const newBody = body.slice(0, start) + replacement + body.slice(end);
    updateBody(newBody);

    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + prefix.length, start + prefix.length + selected.length);
    }, 0);
  };

  const applyLinePrefixFormat = (prefix: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const before = body.slice(0, start);
    const selected = body.slice(start, end);
    const after = body.slice(end);

    const lines = (selected || 'List item').split('\n');
    const formatted = lines.map((l) => (l.startsWith(prefix) ? l : `${prefix}${l}`)).join('\n');
    const newBody = before + formatted + after;
    updateBody(newBody);

    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start, start + formatted.length);
    }, 0);
  };

  const addRecipients = (raw: string) => {
    const emails = extractEmails(raw);
    if (emails.length === 0) return;
    setRecipients((prev) => Array.from(new Set([...prev, ...emails])));
    setRecipientInput('');
  };

  const handleRecipientKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      e.preventDefault();
      addRecipients(recipientInput);
    } else if (e.key === 'Backspace' && recipientInput === '' && recipients.length > 0) {
      setRecipients((prev) => prev.slice(0, -1));
    }
  };

  const handleRecipientBlur = () => {
    if (recipientInput.trim()) {
      addRecipients(recipientInput);
    }
  };

  const removeRecipient = (emailToRemove: string) => {
    setRecipients((prev) => prev.filter((e) => e !== emailToRemove));
  };

  const handleCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (!text) return;

      const rawTokens = text.split(/[\r\n,;]+/).map((t) => t.trim()).filter(Boolean);
      const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
      const validEmails: string[] = [];
      let invalidCount = 0;

      for (const token of rawTokens) {
        const lower = token.toLowerCase();
        if (lower === 'email' || lower === 'emails' || lower === 'recipient' || lower === 'recipients') {
          continue;
        }
        if (emailRegex.test(token)) {
          validEmails.push(token);
        } else {
          invalidCount++;
        }
      }

      const uniqueUploaded = Array.from(new Set(validEmails));
      const duplicatesRemoved = validEmails.length - uniqueUploaded.length;

      setRecipients((prev) => Array.from(new Set([...prev, ...uniqueUploaded])));
      setCsvFeedback({
        filename: file.name,
        validCount: uniqueUploaded.length,
        duplicatesRemoved,
        invalidCount,
      });

      if (csvInputRef.current) csvInputRef.current.value = '';
    };

    reader.readAsText(file);
  };

  const handleAttachmentUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const newAttachments: Attachment[] = Array.from(files).map((file) => ({
      id: `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      file,
      name: file.name,
      previewUrl: file.type.startsWith('image/')
        ? URL.createObjectURL(file)
        : 'https://images.unsplash.com/photo-1554068865-24cecd4e34b8?w=300&h=200&fit=crop',
    }));

    setAttachments((prev) => [...prev, ...newAttachments]);
    if (attachmentInputRef.current) attachmentInputRef.current.value = '';
  };

  const removeAttachment = (idToRemove: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== idToRemove));
  };

  const validate = (): string | null => {
    if (recipients.length === 0) return 'Please add at least one recipient email address.';
    if (!subject.trim()) return 'Subject is required.';
    if (!body.trim()) return 'Email body cannot be empty.';
    return null;
  };

  const submit = async (isoOverride?: string | null) => {
    const validationError = validate();
    if (validationError) {
      setErrorMsg(validationError);
      return;
    }
    setErrorMsg('');
    setIsSubmitting(true);
    try {
      await api.scheduleEmails({
        recipients,
        subject,
        body,
        startTime: isoOverride !== undefined ? (isoOverride || undefined) : (scheduledIso || undefined),
        delayBetweenEmails: delayBetweenEmails === '' ? undefined : Number(delayBetweenEmails),
        hourlyLimit: hourlyLimit === '' ? undefined : Number(hourlyLimit),
        senderId: senderId || undefined,
      });
      onScheduledSuccess();
    } catch (err: unknown) {
      const errorObj = err as { response?: { data?: { message?: string } }; message?: string };
      setErrorMsg(errorObj.response?.data?.message || errorObj.message || 'Failed to schedule emails');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSendLaterDone = (iso: string) => {
    setScheduledIso(iso);
    setShowSendLater(false);
    submit(iso);
  };

  const visibleChips = showAllChips ? recipients : recipients.slice(0, VISIBLE_CHIP_LIMIT);
  const hiddenCount = recipients.length - visibleChips.length;

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
            onClick={onClose}
            className="text-gray-800 hover:text-black transition-colors cursor-pointer shrink-0"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h2 className="text-xl font-semibold text-gray-900 tracking-tight truncate">Compose New Email</h2>
        </div>

        {/* Right Utility Actions */}
        <div className="flex items-center gap-4 shrink-0">
          {/* Paperclip with subscript count matching Figma */}
          <button
            type="button"
            onClick={() => attachmentInputRef.current?.click()}
            title="Attach files"
            className="relative flex items-center text-[#00a854] hover:text-[#00964b] transition-colors cursor-pointer p-1"
          >
            <Paperclip className="w-5 h-5" />
            {attachments.length > 0 && (
              <span className="text-[10px] font-semibold text-[#00a854] ml-0.5 mt-2">
                {attachments.length}
              </span>
            )}
          </button>
          <input ref={attachmentInputRef} type="file" multiple className="hidden" onChange={handleAttachmentUpload} />

          {/* Green Clock Icon */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowSendLater((v) => !v)}
              title="Schedule email send time"
              className={`p-1 transition-colors cursor-pointer flex items-center ${
                scheduledIso ? 'text-[#00a854] ring-2 ring-[#00a854]/20 rounded-full' : 'text-[#00a854] hover:text-[#00964b]'
              }`}
            >
              <Clock className="w-5 h-5" />
            </button>
            {showSendLater && (
              <SendLaterPopover onCancel={() => setShowSendLater(false)} onDone={handleSendLaterDone} />
            )}
          </div>

          {/* Send / Send Later Pill Button */}
          {scheduledIso ? (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => submit()}
                disabled={isSubmitting}
                className="px-5 py-1.5 rounded-full border border-[#00a854] text-[#00a854] text-sm font-medium hover:bg-[#eaf5ed]/50 transition-colors cursor-pointer disabled:opacity-50"
              >
                {isSubmitting ? 'Scheduling...' : 'Send Later'}
              </button>
              <button
                type="button"
                onClick={() => setScheduledIso(null)}
                title="Cancel schedule and send immediately"
                className="p-1 text-gray-400 hover:text-red-500 rounded-full cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => submit()}
              disabled={isSubmitting}
              className="px-6 py-1.5 rounded-full border border-[#00a854] text-[#00a854] text-sm font-medium hover:bg-[#eaf5ed]/50 transition-colors cursor-pointer disabled:opacity-50"
            >
              {isSubmitting ? 'Sending...' : 'Send'}
            </button>
          )}
        </div>
      </div>

      {/* Main Form Fields Container */}
      <div className="flex-1 overflow-y-auto px-6 sm:px-12 py-3 max-w-5xl w-full">
        {errorMsg && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl flex items-center gap-2 text-xs text-red-600">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {csvFeedback && (
          <div className="mb-4 p-3 bg-[#eaf5ed] border border-[#d2edd9] rounded-xl flex items-center justify-between gap-2 text-xs text-[#00a854]">
            <div className="flex items-center gap-2 min-w-0">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span className="truncate">
                <strong>{csvFeedback.filename}</strong>: {csvFeedback.validCount} recipient(s) added
                {csvFeedback.duplicatesRemoved > 0 && ` (${csvFeedback.duplicatesRemoved} duplicates removed)`}
              </span>
            </div>
            <button type="button" onClick={() => setCsvFeedback(null)} className="p-0.5 cursor-pointer text-gray-500 hover:text-black">
              ✕
            </button>
          </div>
        )}

        {/* Row 1: From */}
        <div className="flex items-center py-2.5">
          <span className="text-sm font-normal text-gray-700 w-24 shrink-0">From</span>
          <div className="relative">
            <div className="bg-[#f4f5f7] rounded-xl px-4 py-2 flex items-center gap-3 w-fit cursor-pointer">
              <select
                value={senderId}
                onChange={(e) => setSenderId(e.target.value)}
                className="appearance-none bg-transparent text-sm text-gray-800 pr-5 focus:outline-none cursor-pointer"
              >
                <option value="">{defaultFromEmail}</option>
                {senders.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.email}
                  </option>
                ))}
              </select>
              <ChevronDown className="w-3.5 h-3.5 text-gray-400 absolute right-3 pointer-events-none" />
            </div>
          </div>
        </div>

        {/* Row 2: To */}
        <div className="flex items-center py-2.5 border-b border-[#f0f0f0]">
          <span className="text-sm font-normal text-gray-700 w-24 shrink-0">To</span>
          <div className="flex-1 flex items-center flex-wrap gap-2 min-w-0">
            {recipients.length > 0 ? (
              <>
                {visibleChips.map((email) => (
                  <span
                    key={email}
                    onClick={() => removeRecipient(email)}
                    title="Click to remove"
                    className="inline-flex items-center bg-[#eaf5ed] border border-[#00a854] text-gray-900 text-xs px-3.5 py-1 rounded-full cursor-pointer hover:bg-red-50 hover:border-red-400 hover:text-red-700 transition-colors"
                  >
                    {email}
                  </span>
                ))}
                {hiddenCount > 0 && !showAllChips && (
                  <button
                    type="button"
                    onClick={() => setShowAllChips(true)}
                    className="text-xs font-medium text-[#00a854] bg-[#eaf5ed] border border-[#00a854] px-2.5 py-1 rounded-full hover:bg-[#d8eedf] cursor-pointer"
                  >
                    +{hiddenCount}
                  </button>
                )}
                <input
                  type="text"
                  value={recipientInput}
                  onChange={(e) => setRecipientInput(e.target.value)}
                  onKeyDown={handleRecipientKeyDown}
                  onBlur={handleRecipientBlur}
                  placeholder="Add more..."
                  className="bg-transparent text-sm text-gray-800 placeholder-gray-400 focus:outline-none min-w-[120px] py-1"
                />
              </>
            ) : (
              <input
                type="text"
                value={recipientInput}
                onChange={(e) => setRecipientInput(e.target.value)}
                onKeyDown={handleRecipientKeyDown}
                onBlur={handleRecipientBlur}
                placeholder="recipient@example.com"
                className="w-full bg-transparent text-sm text-gray-800 placeholder-gray-400 focus:outline-none py-1"
              />
            )}
          </div>

          {/* Upload List in green on right */}
          <button
            type="button"
            onClick={() => csvInputRef.current?.click()}
            className="text-[#00a854] hover:text-[#00964b] font-medium text-sm flex items-center gap-1.5 cursor-pointer shrink-0 ml-auto pl-4"
          >
            <Upload className="w-4 h-4" />
            <span>Upload List</span>
          </button>
          <input ref={csvInputRef} type="file" accept=".csv,.txt" className="hidden" onChange={handleCsvUpload} />
        </div>

        {/* Row 3: Subject */}
        <div className="flex items-center py-3 border-b border-[#f0f0f0]">
          <span className="text-sm font-normal text-gray-700 w-24 shrink-0">Subject</span>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className="flex-1 bg-transparent text-sm text-gray-800 placeholder-gray-400 focus:outline-none"
          />
        </div>

        {/* Row 4: Delay between 2 emails & Hourly Limit */}
        <div className="flex items-center gap-3 py-4">
          <span className="text-sm font-normal text-gray-700">Delay between 2 emails</span>
          <input
            type="number"
            min="0"
            value={delayBetweenEmails}
            onChange={(e) => setDelayBetweenEmails(e.target.value)}
            placeholder="00"
            className="w-14 h-8 bg-white border border-[#e5e7eb] rounded-lg text-center text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:border-[#00a854]"
          />
          <span className="text-sm font-normal text-gray-700 ml-6">Hourly Limit</span>
          <input
            type="number"
            min="0"
            value={hourlyLimit}
            onChange={(e) => setHourlyLimit(e.target.value)}
            placeholder="00"
            className="w-14 h-8 bg-white border border-[#e5e7eb] rounded-lg text-center text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:border-[#00a854]"
          />
        </div>

        {/* Rich Text Editor Container matching Figma */}
        <div
          onClick={() => textareaRef.current?.focus()}
          className="mt-2 bg-[#f8f9fa] rounded-2xl min-h-[380px] p-6 flex flex-col justify-start cursor-text"
        >
          {/* Top placeholder */}
          <div
            className={`text-sm text-gray-400 mb-3 select-none transition-opacity ${
              body.trim() ? 'opacity-30' : 'opacity-100'
            }`}
          >
            Type Your Reply...
          </div>

          {/* Floating White Pill Toolbar matching Figma */}
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-full px-5 py-2.5 shadow-sm border border-gray-100 flex items-center gap-4 text-gray-500 w-fit mb-4 cursor-default select-none flex-wrap"
          >
            <button
              type="button"
              onClick={handleUndo}
              disabled={historyIndex <= 0}
              title="Undo (Ctrl+Z)"
              className="hover:text-black cursor-pointer disabled:opacity-30"
            >
              <Undo2 className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handleRedo}
              disabled={historyIndex >= history.length - 1}
              title="Redo (Ctrl+Y)"
              className="hover:text-black cursor-pointer disabled:opacity-30"
            >
              <Redo2 className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => applyLinePrefixFormat('### ')}
              title="Typography / Heading"
              className="hover:text-black cursor-pointer flex items-center"
            >
              <Type className="w-4 h-4" />
              <ChevronsUpDown className="w-3 h-3 ml-0.5 text-gray-400" />
            </button>
            <button
              type="button"
              onClick={() => applyWrapFormat('**', '**', 'bold text')}
              title="Bold"
              className="hover:text-black cursor-pointer font-bold"
            >
              <Bold className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => applyWrapFormat('*', '*', 'italic text')}
              title="Italic"
              className="hover:text-black cursor-pointer italic"
            >
              <Italic className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => applyWrapFormat('<u>', '</u>', 'underlined text')}
              title="Underline"
              className="hover:text-black cursor-pointer underline"
            >
              <Underline className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => applyLinePrefixFormat('  ')}
              title="Indent"
              className="hover:text-black cursor-pointer"
            >
              <AlignLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => applyWrapFormat('\n\n', '\n\n')}
              title="Paragraph spacing"
              className="hover:text-black cursor-pointer"
            >
              <ChevronsUpDown className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => applyLinePrefixFormat('1. ')}
              title="Numbered list"
              className="hover:text-black cursor-pointer"
            >
              <ListOrdered className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => applyLinePrefixFormat('- ')}
              title="Bullet list"
              className="hover:text-black cursor-pointer"
            >
              <List className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                const el = textareaRef.current;
                if (!el) return;
                const start = el.selectionStart;
                const before = body.slice(0, start);
                const match = before.match(/ {2}$/);
                if (match) {
                  const newBody = before.slice(0, -2) + body.slice(start);
                  updateBody(newBody);
                }
              }}
              title="Outdent"
              className="hover:text-black cursor-pointer"
            >
              <Outdent className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => applyLinePrefixFormat('  ')}
              title="Indent"
              className="hover:text-black cursor-pointer"
            >
              <Indent className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => applyLinePrefixFormat('> ')}
              title="Quote"
              className="hover:text-black cursor-pointer"
            >
              <Quote className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => attachmentInputRef.current?.click()}
              title="Insert Image"
              className="hover:text-black cursor-pointer"
            >
              <ImageIcon className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => applyWrapFormat('~~', '~~', 'strikethrough')}
              title="Strikethrough"
              className="hover:text-black cursor-pointer"
            >
              <Strikethrough className="w-4 h-4" />
            </button>
          </div>

          {/* Actual textarea for typing */}
          <textarea
            ref={textareaRef}
            value={body}
            onChange={(e) => updateBody(e.target.value)}
            rows={8}
            className="w-full bg-transparent text-sm text-gray-800 placeholder-transparent focus:outline-none resize-none flex-1 leading-relaxed"
          />
        </div>

        {/* Attachment Thumbnail Cards below the Gray Box */}
        {attachments.length > 0 && (
          <div className="mt-5 flex flex-wrap gap-4">
            {attachments.map((att) => (
              <div
                key={att.id}
                className="group relative w-44 h-28 rounded-2xl overflow-hidden border border-gray-100 shadow-sm bg-white"
              >
                <img
                  src={att.previewUrl}
                  alt={att.name}
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center p-2">
                  <span className="text-[11px] text-white font-medium truncate max-w-[130px] block">
                    {att.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(att.id)}
                    title="Remove attachment"
                    className="absolute top-2 right-2 p-1 bg-white/80 hover:bg-white text-gray-700 rounded-full cursor-pointer transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
