import { useEffect } from 'react'

export type CallStatus = 'ringing' | 'active' | 'ended' | 'missed' | 'declined' | 'cancelled'
export type CallInfo = { id: string; callerId: string; calleeId: string; media: 'audio' | 'video'; status: CallStatus; startedAt: string; answeredAt: string | null }
export type CallJoin = { call: CallInfo; url?: string; token?: string }
export type CallPeer = { username: string; avatar: string }
export type CallRecord = { id: string; status: CallStatus; media: 'audio' | 'video'; duration: number }

export function formatDuration(seconds: number) {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}

/** Text for a call entry in the conversation, from the viewer's side. */
export function callSummary(call: CallRecord, outgoing: boolean) {
  const kind = call.media === 'video' ? 'Chamada de vídeo' : 'Chamada de voz'
  const detail = {
    ringing: outgoing ? 'Chamando…' : 'Tocando…',
    active: 'Em andamento',
    ended: formatDuration(call.duration),
    missed: outgoing ? 'Não atendida' : 'Perdida',
    declined: 'Recusada',
    cancelled: outgoing ? 'Cancelada' : 'Perdida',
  }[call.status]
  const missed = !outgoing && (call.status === 'missed' || call.status === 'cancelled')
  return { kind, detail, missed, preview: missed ? (call.media === 'video' ? 'Chamada de vídeo perdida' : 'Chamada de voz perdida') : `${kind} · ${detail}` }
}

/** Plays a ringing pattern with Web Audio until the returned function is called. */
function playTone(kind: 'incoming' | 'outgoing') {
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx) return () => {}
  const ctx = new Ctx()
  const gain = ctx.createGain()
  gain.gain.value = 0
  gain.connect(ctx.destination)
  const freqs = kind === 'incoming' ? [660, 880] : [440, 480]
  const oscillators = freqs.map((f) => { const o = ctx.createOscillator(); o.frequency.value = f; o.connect(gain); o.start(); return o })
  const level = kind === 'incoming' ? 0.08 : 0.05
  const schedule = () => {
    const t = ctx.currentTime
    if (kind === 'incoming') {
      for (const offset of [0, 0.5]) { gain.gain.setValueAtTime(level, t + offset); gain.gain.setValueAtTime(0, t + offset + 0.35) }
    } else {
      gain.gain.setValueAtTime(level, t); gain.gain.setValueAtTime(0, t + 1.6)
    }
  }
  schedule()
  const timer = window.setInterval(schedule, kind === 'incoming' ? 2000 : 4000)
  return () => { window.clearInterval(timer); oscillators.forEach((o) => o.stop()); void ctx.close() }
}

export function useTone(kind: 'incoming' | 'outgoing', active: boolean) {
  useEffect(() => {
    if (!active) return
    return playTone(kind)
  }, [kind, active])
}

export const callIcons = {
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2',
  hangup: 'M3 15.5c5-4.7 13-4.7 18 0l-2.2 2.6-3.3-1.4V14a10 10 0 0 0-7 0v2.7l-3.3 1.4Z',
  video: 'M3 7h12v10H3zM15 10l6-3v10l-6-3',
  videoOff: 'M3 7h12v10H3zM15 10l6-3v10l-6-3M2 2l20 20',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3',
  micOff: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18',
  screen: 'M3 4h18v12H3zM8 20h8M12 16v4M12 13V7M9 10l3-3 3 3',
  missed: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2M15 3l6 6M21 3l-6 6',
}
