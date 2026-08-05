'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Volume2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { paperTradingService } from '../lib/trading-services';

export type VoiceSettings = { voiceAlerts: boolean; voiceVolume: number; voiceSpeed: number; voicePitch: number; voiceLanguage: string };
export type VoiceAlert = { id: string; tradeId: string; eventName: string; symbol: string; title: string; message: string; payload: string; status: string; createdAt: string; spokenAt?: string | null };
export type VoiceCenterResponse = { settings: VoiceSettings; pending: VoiceAlert[]; executionLog: VoiceAlert[] };

export function VoiceAlertCenter({ enabled }: { enabled: boolean }) {
  const client = useQueryClient();
  const [toasts, setToasts] = useState<VoiceAlert[]>([]);
  const processing = useRef(new Set<string>());
  const center = useQuery({ queryKey: ['paper-voice-alerts'], queryFn: () => paperTradingService.voiceAlerts<VoiceCenterResponse>(), enabled, refetchInterval: 2_000, retry: false });

  useEffect(() => {
    if (!center.data) return;
    let cancelled = false;
    const acknowledgePending = async () => {
      for (const alert of center.data.pending) {
        if (cancelled) return;
        const eventKey = `${alert.tradeId}:${alert.eventName}`;
        if (processing.current.has(eventKey)) continue;
        processing.current.add(eventKey);
        const stored = localStorage.getItem(`quantpulse.voice.${eventKey}`);
        setToasts((current) => [...current.filter((item) => item.id !== alert.id), alert].slice(-4));
        let status: 'SPOKEN' | 'TOASTED' = 'TOASTED';
        if (center.data.settings.voiceAlerts && !stored && 'speechSynthesis' in window) {
          const speech = new SpeechSynthesisUtterance(alert.message);
          speech.rate = center.data.settings.voiceSpeed;
          speech.pitch = center.data.settings.voicePitch;
          speech.volume = center.data.settings.voiceVolume / 100;
          speech.lang = center.data.settings.voiceLanguage;
          window.speechSynthesis.speak(speech);
          localStorage.setItem(`quantpulse.voice.${eventKey}`, new Date().toISOString());
          status = 'SPOKEN';
        }
        try {
          await paperTradingService.acknowledgeVoiceAlert(alert.id, status);
        } catch (error) {
          processing.current.delete(eventKey);
          console.warn('[Voice Alerts] Acknowledgement will be retried.', { alertId: alert.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (!cancelled) await client.invalidateQueries({ queryKey: ['paper-voice-alerts'] });
    };
    void acknowledgePending().catch((error) => console.warn('[Voice Alerts] Pending queue failed.', error));
    return () => { cancelled = true; };
  }, [center.data, client]);

  useEffect(() => {
    if (!toasts.length) return;
    const timer = window.setTimeout(() => setToasts((current) => current.slice(1)), 6_000);
    return () => window.clearTimeout(timer);
  }, [toasts]);

  return <div className="fixed right-4 top-20 z-[80] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
    {toasts.map((toast) => {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(toast.payload || '{}'); } catch { payload = {}; }
      return <article key={toast.id} className="rounded-md border border-emerald-400/30 bg-[#0b1420] p-4 shadow-2xl shadow-black/50">
        <div className="flex items-start gap-3"><div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-emerald-400/15 text-emerald-300">{toast.status === 'SPOKEN' ? <Volume2 className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}</div><div className="min-w-0 flex-1"><p className="text-xs font-black text-emerald-300">{toast.title}</p><p className="mt-1 font-black text-white">{toast.symbol}</p><p className="mt-1 text-xs leading-5 text-slate-300">{toast.message}</p>{Object.keys(payload).length > 0 && <p className="mt-2 text-[11px] text-slate-500">{payload.quantity ? `Qty: ${String(payload.quantity)}  ` : ''}{payload.investment ? `₹${Number(payload.investment).toLocaleString('en-IN')}  ` : ''}{payload.entryPrice ? `Entry ₹${Number(payload.entryPrice).toFixed(2)}` : ''}</p>}</div><button onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))} title="Dismiss notification" aria-label="Dismiss notification" className="text-slate-500 hover:text-white"><X className="h-4 w-4" /></button></div>
      </article>;
    })}
  </div>;
}
