import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { callIcons, formatDuration, useTone, type CallInfo, type CallJoin, type CallPeer } from './callUtils'
import { ConnectionState, Room, RoomEvent, Track, type Participant, type RemoteTrack } from 'livekit-client'

function Icon({ path, size = 24 }: { path: string; size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg>
}

function Avatar({ peer, className }: { peer: CallPeer; className: string }) {
  return peer.avatar ? <img className={className} src={peer.avatar} alt="" /> : <span className={`${className} call-avatar-initial`}>{peer.username.slice(0, 1).toUpperCase()}</span>
}

export function IncomingCall({ call, peer, onAccept, onDecline, busy }: { call: CallInfo; peer: CallPeer; onAccept: (video: boolean) => void; onDecline: () => void; busy: boolean }) {
  useTone('incoming', true)
  return (
    <div className="incoming-call" role="alertdialog" aria-modal="false" aria-labelledby="incoming-title">
      <Avatar peer={peer} className="incoming-avatar" />
      <div className="incoming-text">
        <strong id="incoming-title">{peer.username}</strong>
        <span>{call.media === 'video' ? 'Chamada de vídeo recebida' : 'Chamada de voz recebida'}</span>
      </div>
      <div className="incoming-actions">
        <button type="button" className="call-round decline" onClick={onDecline} disabled={busy} aria-label="Recusar" title="Recusar"><Icon path={callIcons.hangup} /></button>
        {call.media === 'video' && <button type="button" className="call-round accept-audio" onClick={() => onAccept(false)} disabled={busy} aria-label="Atender só com áudio" title="Atender só com áudio"><Icon path={callIcons.phone} /></button>}
        <button type="button" className="call-round accept" onClick={() => onAccept(call.media === 'video')} disabled={busy} aria-label={call.media === 'video' ? 'Atender com vídeo' : 'Atender'} title={call.media === 'video' ? 'Atender com vídeo' : 'Atender'}><Icon path={call.media === 'video' ? callIcons.video : callIcons.phone} /></button>
      </div>
    </div>
  )
}

function VideoTrack({ track, className, mirror }: { track: Track; className: string; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    track.attach(el)
    return () => { track.detach(el) }
  }, [track])
  return <video ref={ref} className={`${className} ${mirror ? 'mirror' : ''}`} autoPlay playsInline muted />
}

export type CallPerson = CallPeer & { id: string }

const heightKey = 'golive.callPanelHeight'
const minPanelHeight = 220

function savedHeight(): number | null {
  try { const v = Number(localStorage.getItem(heightKey)); return v >= minPanelHeight ? v : null } catch { return null }
}

/** Keeps the composer and a few messages visible below the call panel. */
function maxPanelHeight(panel: HTMLElement | null) {
  const dock = panel?.parentElement
  const main = dock?.parentElement
  if (!dock || !main) return 600
  return Math.max(minPanelHeight, main.clientHeight - dock.offsetTop - 170)
}

type Tile = {
  key: string
  kind: 'camera' | 'screen'
  person: CallPerson
  isLocal: boolean
  track?: Track
  muted: boolean
  speaking: boolean
}

function CallTile({ tile, focused, small, status, onClick }: { tile: Tile; focused: boolean; small?: boolean; status?: string; onClick: () => void }) {
  const label = tile.kind === 'screen' ? (tile.isLocal ? 'Sua tela' : `Tela de ${tile.person.username}`) : tile.isLocal ? `${tile.person.username} (você)` : tile.person.username
  return (
    <button type="button" className={`vc-tile ${tile.kind} ${tile.speaking && tile.kind === 'camera' ? 'speaking' : ''} ${focused ? 'focused' : ''} ${small ? 'small' : ''}`}
      onClick={onClick} aria-label={`${label}${focused ? ' (em destaque, clique para voltar à grade)' : ' (clique para destacar)'}`}>
      {tile.track ? <VideoTrack track={tile.track} className={`vc-video ${tile.kind === 'screen' ? 'contain' : ''}`} mirror={tile.isLocal && tile.kind === 'camera'} /> : (
        <span className="vc-avatar-wrap">
          <Avatar peer={tile.person} className="vc-avatar" />
          {status && <span className="vc-tile-status">{status}</span>}
        </span>
      )}
      <span className="vc-label">
        {tile.kind === 'screen' && <span className="vc-live">AO VIVO</span>}
        {tile.kind === 'camera' && tile.muted && <span className="vc-label-muted" aria-label="no mudo"><Icon path={callIcons.micOff} size={14} /></span>}
        <span className="vc-label-name">{label}</span>
      </span>
    </button>
  )
}

type Notify = (kind: 'success' | 'error', message: string) => void

/**
 * Connects to a LiveKit room and exposes participant tiles and device toggles.
 * Shared by one-to-one calls and voice channels. person() maps a participant
 * identity (the user id) to the name and avatar shown on its tile.
 */
function useRoom({ url, token, startVideo, startMic = true, notify, person, deafened = false }: {
  url?: string
  token?: string
  startVideo: boolean
  /** False when the member may not speak (server mute or channel permission). */
  startMic?: boolean
  notify: Notify
  person: (identity: string, isLocal: boolean) => CallPerson
  deafened?: boolean
}) {
  const [connection, setConnection] = useState<ConnectionState>(ConnectionState.Disconnected)
  const [tiles, setTiles] = useState<Tile[]>([])
  const [remoteCount, setRemoteCount] = useState(0)
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(false)
  const [screenOn, setScreenOn] = useState(false)
  const [needsAudioClick, setNeedsAudioClick] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const roomRef = useRef<Room | null>(null)
  const audioRef = useRef<HTMLDivElement>(null)
  const personRef = useRef(person)
  const deafRef = useRef(deafened)
  const refreshRef = useRef<() => void>(() => {})
  useEffect(() => { personRef.current = person; refreshRef.current() })

  useEffect(() => {
    deafRef.current = deafened
    audioRef.current?.querySelectorAll('audio').forEach((el) => { el.muted = deafened })
  }, [deafened])

  useEffect(() => {
    if (!url || !token) return
    const room = new Room({ adaptiveStream: true, dynacast: true })
    roomRef.current = room
    let cancelled = false

    const refresh = () => {
      const next: Tile[] = []
      const add = (p: Participant, isLocal: boolean) => {
        const who = personRef.current(p.identity, isLocal)
        const camera = p.getTrackPublication(Track.Source.Camera)
        const mic = p.getTrackPublication(Track.Source.Microphone)
        const screen = p.getTrackPublication(Track.Source.ScreenShare)
        next.push({ key: `camera:${p.identity}`, kind: 'camera', person: who, isLocal, track: camera?.track && !camera.isMuted ? camera.track : undefined, muted: !mic || mic.isMuted, speaking: p.isSpeaking })
        if (screen?.track) next.push({ key: `screen:${p.identity}`, kind: 'screen', person: who, isLocal, track: screen.track, muted: false, speaking: false })
      }
      const remotes = [...room.remoteParticipants.values()].sort((a, b) => (a.joinedAt?.getTime() ?? 0) - (b.joinedAt?.getTime() ?? 0))
      remotes.forEach((p) => add(p, false))
      add(room.localParticipant, true)
      setTiles(next)
      setRemoteCount(remotes.length)
      const local = room.localParticipant
      setMicOn(local.isMicrophoneEnabled)
      setCamOn(local.isCameraEnabled)
      setScreenOn(local.isScreenShareEnabled)
    }
    refreshRef.current = refresh
    const onSubscribed = (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio && audioRef.current) {
        const el = track.attach()
        el.muted = deafRef.current
        audioRef.current.appendChild(el)
      }
      refresh()
    }
    const onUnsubscribed = (track: RemoteTrack) => { track.detach().forEach((el) => el.remove()); refresh() }

    room
      .on(RoomEvent.ConnectionStateChanged, (state) => setConnection(state))
      .on(RoomEvent.TrackSubscribed, onSubscribed)
      .on(RoomEvent.TrackUnsubscribed, onUnsubscribed)
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.LocalTrackPublished, refresh)
      .on(RoomEvent.LocalTrackUnpublished, refresh)
      .on(RoomEvent.ParticipantConnected, refresh)
      .on(RoomEvent.ParticipantDisconnected, refresh)
      .on(RoomEvent.ActiveSpeakersChanged, refresh)
      .on(RoomEvent.AudioPlaybackStatusChanged, () => setNeedsAudioClick(!room.canPlaybackAudio))

    ;(async () => {
      try {
        await room.connect(url, token)
        if (cancelled) return
        refresh()
        // The room can close while devices start; then the failure is expected and silent.
        if (!deafRef.current && startMic) {
          try { await room.localParticipant.setMicrophoneEnabled(true) }
          catch { if (!cancelled) notify('error', 'Não foi possível usar o microfone. Verifique a permissão do navegador.') }
        }
        if (startVideo && !cancelled) {
          try { await room.localParticipant.setCameraEnabled(true) }
          catch { if (!cancelled) notify('error', 'Não foi possível usar a câmera. Verifique a permissão do navegador.') }
        }
        if (cancelled) return
        setNeedsAudioClick(!room.canPlaybackAudio)
        refresh()
      } catch (err) {
        if (!cancelled) setFailed((err as Error).message)
      }
    })()

    return () => {
      cancelled = true
      roomRef.current = null
      refreshRef.current = () => {}
      void room.disconnect()
    }
    // The room lives for this token; a new token means a new connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, token])

  async function toggle(kind: 'mic' | 'camera' | 'screen', force?: boolean) {
    const local = roomRef.current?.localParticipant
    if (!local) return
    try {
      if (kind === 'mic') { await local.setMicrophoneEnabled(force ?? !local.isMicrophoneEnabled); setMicOn(local.isMicrophoneEnabled) }
      if (kind === 'camera') { await local.setCameraEnabled(!local.isCameraEnabled); setCamOn(local.isCameraEnabled) }
      if (kind === 'screen') { await local.setScreenShareEnabled(!local.isScreenShareEnabled, { audio: true }); setScreenOn(local.isScreenShareEnabled) }
    } catch (err) {
      const name = (err as Error).name
      if (name === 'NotAllowedError' && kind === 'screen') return // the user closed the picker
      notify('error', kind === 'screen' ? 'Não foi possível compartilhar a tela.' : kind === 'camera' ? 'Não foi possível ligar a câmera. Verifique a permissão do navegador.' : 'Não foi possível usar o microfone.')
    }
  }

  return { roomRef, audioRef, connection, tiles, remoteCount, micOn, camOn, screenOn, needsAudioClick, failed, toggle }
}

export function CallScreen({ join, me, peer, startVideo, docked, dockEl, miniEl, onOpen, onEnd, notify }: {
  join: CallJoin
  me: CallPerson
  peer: CallPerson
  startVideo: boolean
  /** Whether the conversation with the peer is open, so the call shows there. */
  docked: boolean
  dockEl: HTMLElement | null
  miniEl: HTMLElement | null
  onOpen: () => void
  onEnd: () => void
  notify: (kind: 'success' | 'error', message: string) => void
}) {
  const { call } = join
  const [now, setNow] = useState(() => Date.now())
  // null: automatic (a screen share takes focus), 'grid': no focus, otherwise a tile key.
  const [focus, setFocus] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  // null: automatic height; otherwise the height the user dragged to.
  const [panelHeight, setPanelHeight] = useState<number | null>(savedHeight)
  const [resizing, setResizing] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const outgoing = call.callerId === me.id
  useTone('outgoing', outgoing && call.status === 'ringing')
  const { roomRef, audioRef, connection, tiles, remoteCount, micOn, camOn, screenOn, needsAudioClick, failed, toggle } =
    useRoom({ url: join.url, token: join.token, startVideo, notify, person: (_id, isLocal) => isLocal ? me : peer })
  const peerJoined = remoteCount > 0

  useEffect(() => {
    if (call.status !== 'active' && !(outgoing && call.status === 'ringing')) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [call.status, outgoing])

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === panelRef.current && !!panelRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  function applyHeight(next: number | null) {
    const value = next === null ? null : Math.round(Math.min(maxPanelHeight(panelRef.current), Math.max(minPanelHeight, next)))
    setPanelHeight(value)
    try { if (value === null) localStorage.removeItem(heightKey); else localStorage.setItem(heightKey, String(value)) } catch { /* storage unavailable */ }
  }

  function startResize(event: React.PointerEvent<HTMLDivElement>) {
    const panelEl = panelRef.current
    if (!panelEl || event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const startY = event.clientY
    const startHeight = panelEl.getBoundingClientRect().height
    setResizing(true)
    const move = (e: PointerEvent) => applyHeight(startHeight + e.clientY - startY)
    const up = () => {
      setResizing(false)
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  function resizeKey(event: React.KeyboardEvent<HTMLDivElement>) {
    const current = panelRef.current?.getBoundingClientRect().height ?? 400
    const step = event.shiftKey ? 96 : 32
    if (event.key === 'ArrowUp') { event.preventDefault(); applyHeight(current - step) }
    if (event.key === 'ArrowDown') { event.preventDefault(); applyHeight(current + step) }
    if (event.key === 'Home') { event.preventDefault(); applyHeight(minPanelHeight) }
    if (event.key === 'End') { event.preventDefault(); applyHeight(maxPanelHeight(panelRef.current)) }
    if (event.key === 'Enter') { event.preventDefault(); applyHeight(null) }
  }

  function toggleMaxHeight() {
    const max = maxPanelHeight(panelRef.current)
    applyHeight(panelHeight !== null && panelHeight >= max - 4 ? null : max)
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void panelRef.current?.requestFullscreen?.()
  }

  const answeredAt = call.answeredAt ? new Date(call.answeredAt).getTime() : null
  // Media that never connects shows an explanation instead of an endless "Conectando…".
  const peerLate = call.status === 'active' && !peerJoined && answeredAt !== null && now - answeredAt > 25000
  const reconnecting = connection === ConnectionState.Reconnecting || connection === ConnectionState.SignalReconnecting
  const problem = failed ? `Não foi possível conectar o áudio e o vídeo (${failed}).` : peerLate ? `${peer.username} não conseguiu se conectar. Desligue e tente de novo.` : null
  const waiting = call.status === 'ringing' ? (outgoing ? 'Chamando…' : 'Conectando…') : !peerJoined ? 'Conectando…' : undefined
  const clock = answeredAt && peerJoined ? formatDuration((now - answeredAt) / 1000) : ''
  const headline = problem ? 'Problema na conexão' : reconnecting ? 'Reconectando…' : waiting ?? 'Ligação conectada'

  // The peer shows as a placeholder tile until they join the room.
  const shown: Tile[] = peerJoined ? tiles : [{ key: `camera:${peer.id}`, kind: 'camera', person: peer, isLocal: false, muted: false, speaking: false }, ...tiles.filter((t) => t.isLocal)]
  if (!shown.some((t) => t.isLocal)) shown.push({ key: `camera:${me.id}`, kind: 'camera', person: me, isLocal: true, muted: !micOn, speaking: false })
  const autoFocus = shown.find((t) => t.kind === 'screen' && !t.isLocal) ?? shown.find((t) => t.kind === 'screen')
  const focusedKey = focus === 'grid' ? null : focus && shown.some((t) => t.key === focus) ? focus : autoFocus?.key ?? null
  const focusedTile = shown.find((t) => t.key === focusedKey)
  const others = shown.filter((t) => t.key !== focusedKey)
  const clickTile = (key: string) => setFocus(focusedKey === key ? 'grid' : key)
  const canShare = typeof navigator !== 'undefined' && !!navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices

  const controls = (
    <div className="vc-controls">
      <div className="vc-controls-group">
        <button type="button" className={`vc-btn ${camOn ? 'active' : ''}`} onClick={() => toggle('camera')} aria-pressed={camOn} aria-label={camOn ? 'Desligar câmera' : 'Ligar câmera'} title={camOn ? 'Desligar câmera' : 'Ligar câmera'}><Icon path={camOn ? callIcons.video : callIcons.videoOff} /></button>
        {canShare && <button type="button" className={`vc-btn ${screenOn ? 'active' : ''}`} onClick={() => toggle('screen')} aria-pressed={screenOn} aria-label={screenOn ? 'Parar de compartilhar a tela' : 'Compartilhar a tela'} title={screenOn ? 'Parar de compartilhar' : 'Compartilhar a tela'}><Icon path={callIcons.screen} /></button>}
        <button type="button" className={`vc-btn ${micOn ? '' : 'muted'}`} onClick={() => toggle('mic')} aria-pressed={!micOn} aria-label={micOn ? 'Desativar microfone' : 'Ativar microfone'} title={micOn ? 'Desativar microfone' : 'Ativar microfone'}><Icon path={micOn ? callIcons.mic : callIcons.micOff} /></button>
        <button type="button" className="vc-btn hangup" onClick={onEnd} aria-label="Encerrar ligação" title="Encerrar ligação"><Icon path={callIcons.hangup} /></button>
      </div>
      {document.fullscreenEnabled && <button type="button" className="vc-btn vc-fullscreen" onClick={toggleFullscreen} aria-label={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'} title={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}><Icon path={fullscreen ? 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' : 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'} size={20} /></button>}
    </div>
  )

  const panel = (
    <section ref={panelRef} className={`vc-panel ${fullscreen ? 'is-fullscreen' : ''} ${focusedTile ? 'has-focus' : ''} ${resizing ? 'is-resizing' : ''}`}
      style={panelHeight !== null && !fullscreen ? { height: panelHeight } : undefined} aria-label={`Ligação com ${peer.username}`}>
      <div className="vc-topbar">
        <span className={`vc-state ${problem ? 'bad' : waiting || reconnecting ? 'wait' : 'ok'}`}><span className="vc-state-dot" />{headline}</span>
        {clock && <span className="vc-clock">{clock}</span>}
        <span className="vc-kind">{call.media === 'video' ? 'Chamada de vídeo' : 'Chamada de voz'}</span>
      </div>
      {focusedTile ? (
        <div className="vc-focus">
          <div className="vc-stage"><CallTile tile={focusedTile} focused status={!focusedTile.isLocal ? waiting : undefined} onClick={() => clickTile(focusedTile.key)} /></div>
          {others.length > 0 && <div className="vc-strip">{others.map((t) => <CallTile key={t.key} tile={t} focused={false} small status={!t.isLocal ? waiting : undefined} onClick={() => clickTile(t.key)} />)}</div>}
        </div>
      ) : (
        <div className="vc-grid">{shown.map((t) => <CallTile key={t.key} tile={t} focused={false} status={!t.isLocal ? waiting : undefined} onClick={() => clickTile(t.key)} />)}</div>
      )}
      {problem && <p className="vc-problem" role="alert">{problem}</p>}
      {needsAudioClick && <button type="button" className="vc-audio-unlock" onClick={() => void roomRef.current?.startAudio()}>Clique para ativar o áudio</button>}
      {controls}
      {!fullscreen && (
        <div className="vc-resizer" role="separator" aria-orientation="horizontal" tabIndex={0}
          aria-label="Ajustar a altura da ligação (arraste, use as setas, ou clique duas vezes para maximizar)"
          aria-valuemin={minPanelHeight} aria-valuenow={panelHeight ?? undefined}
          title="Arraste para ajustar · clique duas vezes para maximizar ou voltar ao automático"
          onPointerDown={startResize} onDoubleClick={toggleMaxHeight} onKeyDown={resizeKey}>
          <span className="vc-grip" />
        </div>
      )}
    </section>
  )

  const mini = (
    <div className="vc-mini" role="region" aria-label="Ligação em andamento">
      <button type="button" className="vc-mini-info" onClick={onOpen} title="Voltar para a ligação">
        <strong className={problem ? 'bad' : waiting || reconnecting ? 'wait' : 'ok'}>{headline}</strong>
        <span>{peer.username}{clock ? ` · ${clock}` : ''}</span>
      </button>
      <button type="button" className={`vc-mini-btn ${micOn ? '' : 'muted'}`} onClick={() => toggle('mic')} aria-label={micOn ? 'Desativar microfone' : 'Ativar microfone'} title={micOn ? 'Desativar microfone' : 'Ativar microfone'}><Icon path={micOn ? callIcons.mic : callIcons.micOff} size={18} /></button>
      <button type="button" className="vc-mini-btn hangup" onClick={onEnd} aria-label="Encerrar ligação" title="Encerrar ligação"><Icon path={callIcons.hangup} size={18} /></button>
    </div>
  )

  return (
    <>
      <div ref={audioRef} hidden />
      {docked && dockEl ? createPortal(panel, dockEl) : miniEl ? createPortal(mini, miniEl) : null}
    </>
  )
}

export type VoiceJoin = { channelId: string; guildId: string; url: string; token: string }
export type VoiceState = { muted: boolean; deafened: boolean; video: boolean; screen: boolean }

const headphones = 'M3 14v-2a9 9 0 0 1 18 0v2M21 14v3a2 2 0 0 1-2 2h-1v-6h3M3 14v3a2 2 0 0 0 2 2h1v-6H3'
const headphonesOff = headphones + 'M3 3l18 18'
const speaker = 'M11 5 6 9H2v6h4l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14'

/** A voice channel: anyone in the server can drop in and out, like Discord. */
export function VoiceScreen({ join, channelName, guildName, me, person, canSpeak, canVideo, serverMuted, docked, dockEl, miniEl, onOpen, onLeave, onSpeaking, onState, notify }: {
  join: VoiceJoin
  /** Channel permissions; a moderator's server mute also blocks the microphone. */
  canSpeak: boolean
  canVideo: boolean
  serverMuted: boolean
  channelName: string
  guildName: string
  me: CallPerson
  person: (id: string) => CallPerson
  /** Whether the voice channel is open in the main area. */
  docked: boolean
  dockEl: HTMLElement | null
  miniEl: HTMLElement | null
  onOpen: () => void
  onLeave: () => void
  onSpeaking: (ids: string[]) => void
  onState: (state: VoiceState) => void
  notify: Notify
}) {
  const [deafened, setDeafened] = useState(false)
  const [focus, setFocus] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const micBeforeDeaf = useRef(true)
  const panelRef = useRef<HTMLElement>(null)
  const { roomRef, audioRef, connection, tiles, micOn, camOn, screenOn, needsAudioClick, failed, toggle } =
    useRoom({ url: join.url, token: join.token, startVideo: false, startMic: canSpeak && !serverMuted, notify, deafened, person: (id, isLocal) => isLocal ? me : person(id) })
  const micBlocked = !canSpeak || serverMuted
  const micWhy = serverMuted ? 'Silenciado por um moderador' : 'Você não tem permissão para falar neste canal'
  const connected = connection === ConnectionState.Connected

  useEffect(() => {
    if (connected) onState({ muted: !micOn, deafened, video: camOn, screen: screenOn })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, micOn, deafened, camOn, screenOn])

  const speakingKey = tiles.filter((t) => t.kind === 'camera' && t.speaking).map((t) => t.person.id).join(',')
  useEffect(() => { onSpeaking(speakingKey ? speakingKey.split(',') : []) }, [speakingKey, onSpeaking])
  useEffect(() => () => onSpeaking([]), [onSpeaking])

  useEffect(() => {
    const onChange = () => setFullscreen(!!panelRef.current && document.fullscreenElement === panelRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  async function toggleDeafen() {
    if (!deafened) {
      micBeforeDeaf.current = micOn
      setDeafened(true)
      if (micOn) await toggle('mic', false)
    } else {
      setDeafened(false)
      if (micBeforeDeaf.current && !micBlocked) await toggle('mic', true)
    }
  }

  async function toggleMic() {
    if (micBlocked) { notify('error', `${micWhy}.`); return }
    // Unmuting while deafened also brings the sound back, like Discord.
    if (deafened) { setDeafened(false); await toggle('mic', true); return }
    await toggle('mic')
  }

  const reconnecting = connection === ConnectionState.Reconnecting || connection === ConnectionState.SignalReconnecting
  const headline = failed ? 'Problema na conexão' : reconnecting ? 'Reconectando…' : connected ? 'Voz conectada' : 'Conectando…'
  const tone = failed ? 'bad' : connected && !reconnecting ? 'ok' : 'wait'
  const autoFocus = tiles.find((t) => t.kind === 'screen' && !t.isLocal) ?? tiles.find((t) => t.kind === 'screen')
  const focusedKey = focus === 'grid' ? null : focus && tiles.some((t) => t.key === focus) ? focus : autoFocus?.key ?? null
  const focusedTile = tiles.find((t) => t.key === focusedKey)
  const others = tiles.filter((t) => t.key !== focusedKey)
  const clickTile = (key: string) => setFocus(focusedKey === key ? 'grid' : key)
  const count = tiles.filter((t) => t.kind === 'camera').length
  const cols = tiles.length <= 2 ? Math.max(1, tiles.length) : tiles.length <= 4 ? 2 : tiles.length <= 9 ? 3 : 4
  const rows = Math.ceil(tiles.length / cols)
  const canShare = typeof navigator !== 'undefined' && !!navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices

  const panel = (
    <section ref={panelRef} className={`vc-panel voice ${fullscreen ? 'is-fullscreen' : ''}`} aria-label={`Canal de voz ${channelName}`}>
      <div className="vc-topbar">
        <span className={`vc-state ${tone}`}><span className="vc-state-dot" />{headline}</span>
        <span className="vc-clock">{count} {count === 1 ? 'pessoa' : 'pessoas'}</span>
        {serverMuted && <span className="vc-server-muted"><Icon path={callIcons.micOff} size={14} /> Silenciado por um moderador</span>}
        <span className="vc-kind"><Icon path={speaker} size={14} /> {channelName}</span>
      </div>
      {focusedTile ? (
        <div className="vc-focus">
          <div className="vc-stage"><CallTile tile={focusedTile} focused onClick={() => clickTile(focusedTile.key)} /></div>
          {others.length > 0 && <div className="vc-strip">{others.map((t) => <CallTile key={t.key} tile={t} focused={false} small onClick={() => clickTile(t.key)} />)}</div>}
        </div>
      ) : (
        <div className="vc-grid voice-grid" style={{ '--cols': cols, '--rows': rows } as React.CSSProperties}>
          {tiles.map((t) => <CallTile key={t.key} tile={t} focused={false} onClick={() => clickTile(t.key)} />)}
          {connected && count === 1 && <p className="vc-alone">Você é o único aqui. Quem entrar em {channelName} aparece nesta tela.</p>}
        </div>
      )}
      {failed && <p className="vc-problem" role="alert">Não foi possível conectar o áudio e o vídeo ({failed}).</p>}
      {needsAudioClick && <button type="button" className="vc-audio-unlock" onClick={() => void roomRef.current?.startAudio()}>Clique para ativar o áudio</button>}
      <div className="vc-controls">
        <div className="vc-controls-group">
          <button type="button" className={`vc-btn ${camOn ? 'active' : ''}`} onClick={() => toggle('camera')} disabled={!canVideo} aria-pressed={camOn} aria-label={camOn ? 'Desligar câmera' : 'Ligar câmera'} title={!canVideo ? 'Sem permissão para vídeo neste canal' : camOn ? 'Desligar câmera' : 'Ligar câmera'}><Icon path={camOn ? callIcons.video : callIcons.videoOff} /></button>
          {canShare && <button type="button" className={`vc-btn ${screenOn ? 'active' : ''}`} onClick={() => toggle('screen')} disabled={!canVideo} aria-pressed={screenOn} aria-label={screenOn ? 'Parar de compartilhar a tela' : 'Compartilhar a tela'} title={!canVideo ? 'Sem permissão para compartilhar a tela neste canal' : screenOn ? 'Parar de compartilhar' : 'Compartilhar a tela'}><Icon path={callIcons.screen} /></button>}
          <button type="button" className={`vc-btn ${micOn ? '' : 'muted'} ${micBlocked ? 'blocked' : ''}`} onClick={toggleMic} aria-pressed={!micOn} aria-disabled={micBlocked} aria-label={micBlocked ? micWhy : micOn ? 'Desativar microfone' : 'Ativar microfone'} title={micBlocked ? micWhy : micOn ? 'Desativar microfone' : 'Ativar microfone'}><Icon path={micOn ? callIcons.mic : callIcons.micOff} /></button>
          <button type="button" className={`vc-btn ${deafened ? 'muted' : ''}`} onClick={toggleDeafen} aria-pressed={deafened} aria-label={deafened ? 'Ativar som' : 'Desativar som (ensurdecer)'} title={deafened ? 'Ativar som' : 'Desativar som'}><Icon path={deafened ? headphonesOff : headphones} /></button>
          <button type="button" className="vc-btn hangup" onClick={onLeave} aria-label="Desconectar do canal de voz" title="Desconectar"><Icon path={callIcons.hangup} /></button>
        </div>
        {document.fullscreenEnabled && <button type="button" className="vc-btn vc-fullscreen" onClick={() => document.fullscreenElement ? void document.exitFullscreen() : void panelRef.current?.requestFullscreen?.()} aria-label={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'} title={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}><Icon path={fullscreen ? 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' : 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'} size={20} /></button>}
      </div>
    </section>
  )

  const mini = (
    <div className="vc-mini voice" role="region" aria-label="Canal de voz conectado">
      <button type="button" className="vc-mini-info" onClick={onOpen} title={`Abrir ${channelName}`}>
        <strong className={tone}>{headline}</strong>
        <span>{channelName} / {guildName}</span>
      </button>
      <button type="button" className={`vc-mini-btn ${micOn ? '' : 'muted'}`} onClick={toggleMic} aria-label={micOn ? 'Desativar microfone' : 'Ativar microfone'} title={micOn ? 'Desativar microfone' : 'Ativar microfone'}><Icon path={micOn ? callIcons.mic : callIcons.micOff} size={18} /></button>
      <button type="button" className={`vc-mini-btn ${deafened ? 'muted' : ''}`} onClick={toggleDeafen} aria-label={deafened ? 'Ativar som' : 'Desativar som'} title={deafened ? 'Ativar som' : 'Desativar som'}><Icon path={deafened ? headphonesOff : headphones} size={18} /></button>
      <button type="button" className="vc-mini-btn hangup" onClick={onLeave} aria-label="Desconectar do canal de voz" title="Desconectar"><Icon path={callIcons.hangup} size={18} /></button>
    </div>
  )

  return (
    <>
      <div ref={audioRef} hidden />
      {docked && dockEl ? createPortal(panel, dockEl) : miniEl ? createPortal(mini, miniEl) : null}
    </>
  )
}
