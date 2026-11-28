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
  const label = tile.kind === 'screen' ? `Tela de ${tile.isLocal ? 'você' : tile.person.username}` : tile.isLocal ? `${tile.person.username} (você)` : tile.person.username
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
  const [connection, setConnection] = useState<ConnectionState>(ConnectionState.Disconnected)
  const [tiles, setTiles] = useState<Tile[]>([])
  const [peerJoined, setPeerJoined] = useState(false)
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(false)
  const [screenOn, setScreenOn] = useState(false)
  const [needsAudioClick, setNeedsAudioClick] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [failed, setFailed] = useState<string | null>(null)
  // null: automatic (a screen share takes focus), 'grid': no focus, otherwise a tile key.
  const [focus, setFocus] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  // null: automatic height; otherwise the height the user dragged to.
  const [panelHeight, setPanelHeight] = useState<number | null>(savedHeight)
  const [resizing, setResizing] = useState(false)
  const roomRef = useRef<Room | null>(null)
  const audioRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const outgoing = call.callerId === me.id
  useTone('outgoing', outgoing && call.status === 'ringing')

  useEffect(() => {
    if (!join.url || !join.token) return
    const room = new Room({ adaptiveStream: true, dynacast: true })
    roomRef.current = room
    let cancelled = false

    const refresh = () => {
      const next: Tile[] = []
      const add = (p: Participant, person: CallPerson, isLocal: boolean) => {
        const camera = p.getTrackPublication(Track.Source.Camera)
        const mic = p.getTrackPublication(Track.Source.Microphone)
        const screen = p.getTrackPublication(Track.Source.ScreenShare)
        next.push({ key: `camera:${person.id}`, kind: 'camera', person, isLocal, track: camera?.track && !camera.isMuted ? camera.track : undefined, muted: !mic || mic.isMuted, speaking: p.isSpeaking })
        if (screen?.track) next.push({ key: `screen:${person.id}`, kind: 'screen', person, isLocal, track: screen.track, muted: false, speaking: false })
      }
      const remote = [...room.remoteParticipants.values()][0]
      if (remote) add(remote, peer, false)
      add(room.localParticipant, me, true)
      setTiles(next)
      setPeerJoined(!!remote)
      const local = room.localParticipant
      setMicOn(local.isMicrophoneEnabled)
      setCamOn(local.isCameraEnabled)
      setScreenOn(local.isScreenShareEnabled)
    }
    const onSubscribed = (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio && audioRef.current) audioRef.current.appendChild(track.attach())
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
        await room.connect(join.url!, join.token!)
        if (cancelled) return
        refresh()
        // A call can end while devices start; then the failure is expected and silent.
        try { await room.localParticipant.setMicrophoneEnabled(true) }
        catch { if (!cancelled) notify('error', 'Não foi possível usar o microfone. Verifique a permissão do navegador.') }
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
      void room.disconnect()
    }
    // The room lives for this call; a new token means a new call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [join.url, join.token])

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

  async function toggle(kind: 'mic' | 'camera' | 'screen') {
    const local = roomRef.current?.localParticipant
    if (!local) return
    try {
      if (kind === 'mic') { await local.setMicrophoneEnabled(!local.isMicrophoneEnabled); setMicOn(local.isMicrophoneEnabled) }
      if (kind === 'camera') { await local.setCameraEnabled(!local.isCameraEnabled); setCamOn(local.isCameraEnabled) }
      if (kind === 'screen') { await local.setScreenShareEnabled(!local.isScreenShareEnabled, { audio: true }); setScreenOn(local.isScreenShareEnabled) }
    } catch (err) {
      const name = (err as Error).name
      if (name === 'NotAllowedError' && kind === 'screen') return // the user closed the picker
      notify('error', kind === 'screen' ? 'Não foi possível compartilhar a tela.' : kind === 'camera' ? 'Não foi possível ligar a câmera. Verifique a permissão do navegador.' : 'Não foi possível usar o microfone.')
    }
  }

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
