import React, { useRef, useState } from 'react';
import {
  ArrowLeft,
  Paperclip,
  Clock,
  Upload,
  X,
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
  file: File;
  previewUrl?: string;
}

const VISIBLE_CHIP_LIMIT = 3;

function extractEmails(text: string): string[] {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(emailRegex) || [];
  return Array.from(new Set(matches));
}

export const ComposeView: React.FC<ComposeViewProps> = ({ senders, onClose, onScheduledSuccess, onOpenMobileNav }) => {
  const [senderId, setSenderId] = useState('');
  const [recipients, setRecipients] = useState<string[]>([]);
  const [recipientInput, setRecipientInput] = useState('');
  const [showAllChips, setShowAllChips] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [delayBetweenEmails, setDelayBetweenEmails] = useState('');
  const [hourlyLimit, setHourlyLimit] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
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

  const defaultFromEmail =
    senders.find((s) => s.id === senderId)?.email || senders[0]?.email || 'oliver.brown@domain.io';

  const addRecipients = (raw: string) => {
    const emails = extractEmails(raw);
    if (emails.length === 0) return;
    setRecipients((prev) => Array.from(new Set([...prev, ...emails])));
    setRecipientInput('');
  };

  const handleRecipientKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
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
      file,
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
    }));

    setAttachments((prev) => [...prev, ...newAttachments]);
    if (attachmentInputRef.current) attachmentInputRef.current.value = '';
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
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
        startTime: isoOverride ?? scheduledIso ?? undefined,
        delayBetweenEmails: delayBetweenEmails === '' ? undefined : Number(delayBetweenEmails),
        hourlyLimit: hourlyLimit === '' ? undefined : Number(hourlyLimit),
        senderId: senderId || undefined,
      });
      onScheduledSuccess();
    } catch (err: any) {
      setErrorMsg(err.response?.data?.message || err.message || 'Failed to schedule emails');
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
      {/* Top Bar matching Figma */}
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
            className="text-gray-700 hover:text-black transition-colors cursor-pointer shrink-0"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h2 className="text-base font-semibold text-gray-900 truncate">Compose New Email</h2>
        </div>

        {/* Right utility buttons */}
        <div className="flex items-center gap-4 shrink-0">
          {/* Attachments */}
          <button
            type="button"
            onClick={() => attachmentInputRef.current?.click()}
            title="Attach files"
            className="text-gray-400 hover:text-gray-600 transition-colors cursor-pointer"
          >
            <Paperclip className="w-5 h-5" />
          </button>
          <input ref={attachmentInputRef} type="file" multiple className="hidden" onChange={handleAttachmentUpload} />

          {/* Clock / Send Later Popover Anchor */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowSendLater((v) => !v)}
              title="Send later"
              className={`transition-colors cursor-pointer ${
                scheduledIso ? 'text-[#00a854]' : 'text-gray-400 hover:text-gray-600'
              }`}
            >
              <Clock className="w-5 h-5" />
            </button>
            {showSendLater && (
              <SendLaterPopover onCancel={() => setShowSendLater(false)} onDone={handleSendLaterDone} />
            )}
          </div>

          {/* Send Button */}
          <button
            type="button"
            onClick={() => submit()}
            disabled={isSubmitting}
            className="px-6 py-1.5 rounded-full border border-[#00a854] text-[#00a854] text-xs font-semibold hover:bg-[#eaf5ed]/50 transition-colors cursor-pointer disabled:opacity-50"
          >
            {isSubmitting ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>

      {/* Main Form Body */}
      <div className="flex-1 overflow-y-auto px-6 sm:px-12 py-5 max-w-4xl w-full">
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
            <button type="button" onClick={() => setCsvFeedback(null)} className="p-0.5 cursor-pointer">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* From Field */}
        <div className="flex items-center gap-4 py-3 border-b border-[#f0f0f0]">
          <span className="text-xs text-gray-500 w-16 shrink-0">From</span>
          <div className="relative">
            <select
              value={senderId}
              onChange={(e) => setSenderId(e.target.value)}
              className="appearance-none bg-[#f4f5f7] text-xs text-gray-800 rounded-xl px-3.5 py-1.5 pr-8 focus:outline-none cursor-pointer"
            >
              <option value="">{defaultFromEmail}</option>
              {senders.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.email}
                </option>
              ))}
            </select>
            <ChevronDown className="w-3.5 h-3.5 text-gray-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
        </div>

        {/* To Field */}
        <div className="flex items-center gap-4 py-3 border-b border-[#f0f0f0]">
          <span className="text-xs text-gray-500 w-16 shrink-0">To</span>
          <div className="flex-1 flex items-center flex-wrap gap-1.5 min-w-0">
            {visibleChips.map((email) => (
              <span
                key={email}
                className="inline-flex items-center gap-1 bg-[#eaf5ed] text-[#00a854] text-xs px-2.5 py-0.5 rounded-full"
              >
                {email}
                <button type="button" onClick={() => removeRecipient(email)} className="hover:text-black cursor-pointer">
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
            {hiddenCount > 0 && !showAllChips && (
              <button
                type="button"
                onClick={() => setShowAllChips(true)}
                className="text-xs text-gray-500 px-2 py-0.5 rounded-full bg-gray-100 hover:bg-gray-200 cursor-pointer"
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
              placeholder={recipients.length === 0 ? 'recipient@example.com' : ''}
              className="flex-1 min-w-[160px] bg-transparent text-sm text-gray-800 placeholder-gray-400 focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => csvInputRef.current?.click()}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-[#00a854] cursor-pointer shrink-0"
            title="Upload CSV / TXT list"
          >
            <Upload className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Upload</span>
          </button>
          <input ref={csvInputRef} type="file" accept=".csv,.txt" className="hidden" onChange={handleCsvUpload} />
        </div>

        {/* Subject Field */}
        <div className="flex items-center gap-4 py-3 border-b border-[#f0f0f0]">
          <span className="text-xs text-gray-500 w-16 shrink-0">Subject</span>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className="flex-1 bg-transparent text-sm text-gray-800 placeholder-gray-400 focus:outline-none"
          />
        </div>

        {/* Delays & Rate Limits */}
        <div className="flex flex-wrap items-center gap-6 py-4">
          <div className="flex items-center gap-2.5">
            <span className="text-xs text-gray-500">Delay between 2 emails</span>
            <input
              type="number"
              min="0"
              value={delayBetweenEmails}
              onChange={(e) => setDelayBetweenEmails(e.target.value)}
              placeholder="00"
              className="w-14 bg-white border border-[#e5e7eb] rounded-lg px-2 py-1 text-center text-xs text-gray-800 focus:outline-none focus:border-[#00a854]"
            />
          </div>
          <div className="flex items-center gap-2.5">
            <span className="text-xs text-gray-500">Hourly Limit</span>
            <input
              type="number"
              min="0"
              value={hourlyLimit}
              onChange={(e) => setHourlyLimit(e.target.value)}
              placeholder="00"
              className="w-14 bg-white border border-[#e5e7eb] rounded-lg px-2 py-1 text-center text-xs text-gray-800 focus:outline-none focus:border-[#00a854]"
            />
          </div>
        </div>

        {/* Rich Text Editor Container matching Figma */}
        <div className="mt-2 bg-[#f8f9fa] rounded-2xl min-h-[380px] flex flex-col justify-between p-5 border border-[#f0f0f0]">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Type Your Reply..."
            rows={10}
            className="w-full bg-transparent text-sm text-gray-800 placeholder-gray-400 focus:outline-none resize-none"
          />

          {/* Attachments preview thumbnails */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-3 py-3">
              {attachments.map((att, i) => (
                <div key={i} className="relative w-20 h-20 rounded-xl overflow-hidden border border-gray-200 bg-white shrink-0">
                  {att.previewUrl ? (
                    <img src={att.previewUrl} alt={att.file.name} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[10px] text-gray-400 p-1 text-center">
                      {att.file.name}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => removeAttachment(i)}
                    className="absolute top-1 right-1 bg-black/60 hover:bg-black/80 text-white rounded-full p-0.5 cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Bottom Toolbar matching Figma */}
          <div className="flex flex-wrap items-center gap-4 pt-3 border-t border-gray-200/50 text-gray-400">
            <button type="button" title="Undo" className="hover:text-gray-700 cursor-pointer">
              <Undo2 className="w-4 h-4" />
            </button>
            <button type="button" title="Redo" className="hover:text-gray-700 cursor-pointer">
              <Redo2 className="w-4 h-4" />
            </button>
            <button type="button" title="Font size" className="hover:text-gray-700 cursor-pointer flex items-center">
              <Type className="w-4 h-4" />
              <ChevronDown className="w-3 h-3 ml-0.5" />
            </button>
            <button type="button" title="Bold" className="hover:text-gray-700 cursor-pointer font-bold">
              <Bold className="w-4 h-4" />
            </button>
            <button type="button" title="Italic" className="hover:text-gray-700 cursor-pointer italic">
              <Italic className="w-4 h-4" />
            </button>
            <button type="button" title="Underline" className="hover:text-gray-700 cursor-pointer underline">
              <Underline className="w-4 h-4" />
            </button>
            <button type="button" title="Align" className="hover:text-gray-700 cursor-pointer">
              <AlignLeft className="w-4 h-4" />
            </button>
            <button type="button" title="Line height" className="hover:text-gray-700 cursor-pointer">
              <ChevronsUpDown className="w-4 h-4" />
            </button>
            <button type="button" title="Numbered list" className="hover:text-gray-700 cursor-pointer">
              <ListOrdered className="w-4 h-4" />
            </button>
            <button type="button" title="Bullet list" className="hover:text-gray-700 cursor-pointer">
              <List className="w-4 h-4" />
            </button>
            <button type="button" title="Outdent" className="hover:text-gray-700 cursor-pointer">
              <Outdent className="w-4 h-4" />
            </button>
            <button type="button" title="Indent" className="hover:text-gray-700 cursor-pointer">
              <Indent className="w-4 h-4" />
            </button>
            <button type="button" title="Quote" className="hover:text-gray-700 cursor-pointer">
              <Quote className="w-4 h-4" />
            </button>
            <button type="button" title="Image" className="hover:text-gray-700 cursor-pointer">
              <ImageIcon className="w-4 h-4" />
            </button>
            <button type="button" title="Strikethrough" className="hover:text-gray-700 cursor-pointer">
              <Strikethrough className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
