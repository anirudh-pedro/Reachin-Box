import React, { useState, useEffect, useRef } from 'react';
import type { User } from '../types';
import { api } from '../services/api';
import { Loader2, AlertCircle } from 'lucide-react';

interface LoginViewProps {
  onLogin: (user: User) => void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
            auto_select?: boolean;
            cancel_on_tap_outside?: boolean;
          }) => void;
          renderButton: (
            parent: HTMLElement,
            options: {
              theme?: 'outline' | 'filled_blue' | 'filled_black';
              size?: 'large' | 'medium' | 'small';
              text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
              shape?: 'rectangular' | 'pill' | 'circle' | 'square';
              width?: number;
              logo_alignment?: 'left' | 'center';
            }
          ) => void;
          prompt: () => void;
        };
      };
    };
  }
}

export const LoginView: React.FC<LoginViewProps> = ({ onLogin }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const googleHiddenBtnRef = useRef<HTMLDivElement>(null);

  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

  const handleGoogleCredentialResponse = async (response: { credential: string }) => {
    if (!response.credential) {
      setError('Google did not return a valid credential. Please try again.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await api.googleLogin(response.credential);
      if (res.user) {
        onLogin(res.user);
      }
    } catch (err: any) {
      console.error('Google login error:', err);
      const serverMessage = err.response?.data?.message || err.message || 'Authentication failed';
      setError(`Login failed: ${serverMessage}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!googleClientId) return;

    const initGsi = () => {
      if (window.google?.accounts?.id && googleHiddenBtnRef.current) {
        try {
          window.google.accounts.id.initialize({
            client_id: googleClientId,
            callback: handleGoogleCredentialResponse,
          });

          googleHiddenBtnRef.current.innerHTML = '';
          window.google.accounts.id.renderButton(googleHiddenBtnRef.current, {
            theme: 'outline',
            size: 'large',
            text: 'signin_with',
            shape: 'rectangular',
            width: 320,
          });
        } catch (e: any) {
          console.warn('Google Identity Services initialization warning:', e.message);
        }
      }
    };

    if (window.google?.accounts?.id) {
      initGsi();
    } else {
      const interval = setInterval(() => {
        if (window.google?.accounts?.id) {
          clearInterval(interval);
          initGsi();
        }
      }, 200);
      return () => clearInterval(interval);
    }
  }, [googleClientId]);

  const handleGoogleClick = () => {
    setError(null);
    if (window.google?.accounts?.id) {
      // Find the rendered button inside hidden container and click it
      const btn = googleHiddenBtnRef.current?.querySelector('div[role="button"]') as HTMLElement;
      if (btn) {
        btn.click();
      } else {
        window.google.accounts.id.prompt();
      }
    } else {
      setError('Google Sign-In is initializing. Please check that VITE_GOOGLE_CLIENT_ID is active.');
    }
  };

  const handleEmailLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      setError('Please enter your Email ID.');
      return;
    }
    setError(null);
    // Instant fallback demo login matching Figma profile
    const demoUser: User = {
      id: 'usr_oliver_brown',
      email: email.trim(),
      name: email.split('@')[0] || 'Oliver Brown',
      avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=64&h=64&fit=crop&crop=faces',
    };
    onLogin(demoUser);
  };

  return (
    <div className="min-h-screen bg-white flex items-center justify-center p-4">
      {/* Hidden container where official Google SDK renders */}
      <div ref={googleHiddenBtnRef} className="hidden" aria-hidden="true" />

      {/* Centered Figma Login Card */}
      <div className="w-full max-w-[420px] bg-white border border-[#eef0f2] rounded-2xl p-8 sm:p-10 shadow-[0_2px_16px_rgba(0,0,0,0.03)] flex flex-col">
        {/* Title */}
        <h1 className="text-3xl font-bold text-center text-[#111827] mb-8">Login</h1>

        {/* Error Alert */}
        {error && (
          <div className="mb-5 p-3 bg-red-50 border border-red-200 rounded-xl flex items-start gap-2.5 text-xs text-red-700">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-500" />
            <div className="flex-1">
              <p>{error}</p>
            </div>
          </div>
        )}

        {/* Loading Indicator */}
        {loading && (
          <div className="mb-5 p-3 bg-[#eaf5ed] border border-[#d2edd9] rounded-xl flex items-center justify-center gap-2.5 text-xs font-medium text-[#00a854]">
            <Loader2 className="w-4 h-4 animate-spin text-[#00a854]" />
            <span>Signing in with Google...</span>
          </div>
        )}

        {/* Figma "Login with Google" Button */}
        <button
          type="button"
          onClick={handleGoogleClick}
          disabled={loading}
          className="w-full bg-[#eaf5ed] hover:bg-[#dff0e3] text-[#2d3748] font-medium text-sm py-3 px-4 rounded-xl flex items-center justify-center gap-2.5 transition-colors cursor-pointer border-0"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24">
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
            />
            <path
              fill="#EA4335"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
            />
          </svg>
          <span>Login with Google</span>
        </button>

        {/* Divider: or sign up through email */}
        <div className="relative flex py-6 items-center">
          <div className="flex-grow border-t border-gray-200"></div>
          <span className="flex-shrink mx-3 text-xs text-gray-400 font-normal">or sign up through email</span>
          <div className="flex-grow border-t border-gray-200"></div>
        </div>

        {/* Email & Password Form */}
        <form onSubmit={handleEmailLogin} className="flex flex-col">
          <input
            type="text"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email ID"
            className="w-full bg-[#f4f5f7] border-0 rounded-xl px-4 py-3 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-[#00a854] mb-3"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full bg-[#f4f5f7] border-0 rounded-xl px-4 py-3 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-[#00a854] mb-6"
          />
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-[#00a854] hover:bg-[#00964b] text-white font-medium text-sm py-3 rounded-xl transition-colors cursor-pointer shadow-sm text-center"
          >
            Login
          </button>
        </form>
      </div>
    </div>
  );
};
