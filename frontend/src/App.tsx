import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent, type KeyboardEvent } from 'react'
import './App.css'
import { callIcons, callSummary, type CallInfo, type CallJoin, type CallRecord } from './callUtils'
import { apiBase, avatarSource, request } from './api'
import { AddMembersDialog, AddServerDialog, ChannelDialog, ChannelSettingsDialog, ConfirmDialog, GuildSidebar, InviteDialog, InvitePreviewDialog, MemberList, ServerRail, ServerSettingsDialog, type GuildAction, type MemberAction, type VoiceAction } from './guilds'
import { P, has, type Channel, type GuildDetail, type GuildSummary, type Member, type VoiceMember } from './guildTypes'
import { applyTheme, savedTheme, watchSystemTheme, type ThemePref } from './theme'

type User = {
  id: string
  avatar: string
  username: string
  email: string
  userTag: string
  role: 'master' | 'user'
  accountStatus: 'active' | 'blocked'
  status: 'online' | 'away' | 'busy' | 'offline'
}
type Toast = { kind: 'success' | 'error'; message: string }
type Contact = Pick<User, 'id' | 'avatar' | 'username' | 'userTag' | 'status'>
type Panel = 'chat' | 'profile' | 'admin'
type Attachment = { kind: 'image' | 'file'; url: string; contentType: string; name: string; size: number; width?: number; height?: number }
type Message = { id: number; senderId: string; recipientId?: string; channelId?: string; body: string; attachment: Attachment | null; createdAt: string; readAt: string | null; editedAt: string | null; deletedAt: string | null; call: CallRecord | null }
type PendingAttachment = { contactId: string; file: File; kind: 'image' | 'file'; preview: string | null }
type Conversation = { contactId: string; lastMessage: Message; unread: number }
type Thread = { messages: Message[]; hasMore: boolean; loaded: boolean }
type RealtimeEvent = { type: 'message' | 'message_updated'; message: Message } | { type: 'read'; readerId: string; readAt: string } | { type: 'presence'; userId: string; status: User['status'] } | { type: 'call'; call: CallInfo } | { type: 'guild'; guildId: string; action: 'updated' | 'removed' } | { type: 'voice'; guildId: string; channelId: string; members: VoiceMember[] } | { type: 'voice_moved'; channelId: string; guildId: string; url: string; token: string }

// The LiveKit client is large, so the call UI loads on first use.
const CallScreen = lazy(() => import('./calls').then((m) => ({ default: m.CallScreen })))
const IncomingCall = lazy(() => import('./calls').then((m) => ({ default: m.IncomingCall })))
const VoiceScreen = lazy(() => import('./calls').then((m) => ({ default: m.VoiceScreen })))

const realtimeUrl = `${apiBase.replace(/^http/, 'ws')}/api/ws`
const pageSize = 50
const maxMessageLength = 4000
const changeWindowMs = 5 * 60 * 1000

function changeTimeLeft(m: Message, now = Date.now()) {
  return changeWindowMs - (now - new Date(m.createdAt).getTime())
}
const maxImageBytes = 10 * 1024 * 1024
const maxFileBytes = 25 * 1024 * 1024
const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const documentExtensions = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'txt', 'csv', 'md', 'zip', 'rar', '7z']
const attachmentAccept = [...imageTypes, ...documentExtensions.map((ext) => `.${ext}`)].join(',')

function fileExtension(name: string) {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function fileTone(ext: string) {
  if (ext === 'pdf') return 'pdf'
  if (['doc', 'docx', 'odt', 'txt', 'md'].includes(ext)) return 'doc'
  if (['xls', 'xlsx', 'ods', 'csv'].includes(ext)) return 'sheet'
  if (['ppt', 'pptx', 'odp'].includes(ext)) return 'slides'
  return 'archive'
}

function FileBadge({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  const ext = fileExtension(name)
  return (
    <span className={`file-badge ${fileTone(ext)} ${size}`} aria-hidden="true">
      <svg viewBox="0 0 32 40" fill="none"><path d="M4 1h17l10 10v25a3 3 0 0 1-3 3H4a3 3 0 0 1-3-3V4a3 3 0 0 1 3-3Z" fill="currentColor" /><path d="M21 1v7a3 3 0 0 0 3 3h7" fill="rgba(255,255,255,.35)" /></svg>
      <span>{ext.slice(0, 4) || 'arq'}</span>
    </span>
  )
}

function FileIcon() {
  return (
    <svg className="preview-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5" />
    </svg>
  )
}

function MenuIcon({ path }: { path: string }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg>
}
function CallIcon({ path, size = 18 }: { path: string; size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg>
}

const iconPaths = {
  chevron: 'm6 9 6 6 6-6',
  edit: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4ZM13.5 6.5l4 4',
  copy: 'M9 9h10v12H9zM5 15H4V3h11v1',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  ban: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM5.6 5.6l12.8 12.8',
  close: 'M6 6l12 12M18 6 6 18',
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" /></svg>
  )
}

function formatBytes(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`
}

function fileFromClipboard(data: DataTransfer | null) {
  if (!data) return undefined
  return data.files[0] ?? [...data.items].find((i) => i.kind === 'file')?.getAsFile() ?? undefined
}

function previewText(m: Message, me?: string) {
  if (m.deletedAt) return 'Mensagem apagada'
  if (m.call) return callSummary(m.call, m.senderId === me).preview
  if (!m.attachment || m.body) return m.body
  return m.attachment.kind === 'image' ? 'Foto' : m.attachment.name
}

function PhotoIcon() {
  return (
    <svg className="preview-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" />
    </svg>
  )
}

function bubbleImageSize(a: Attachment) {
  const width = a.width || 320, height = a.height || 240
  const scale = Math.min(1, 320 / width, 360 / height)
  return { width: Math.max(80, Math.round(width * scale)), height: Math.max(60, Math.round(height * scale)) }
}

function uploadAttachment(key: string, file: File, caption: string, onProgress: (fraction: number) => void) {
  return new Promise<Message>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${apiBase}${convPath(key)}/attachments`)
    xhr.withCredentials = true
    xhr.responseType = 'json'
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded / event.total) }
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.response as Message) : reject(new Error(xhr.response?.error || `Erro HTTP ${xhr.status}`))
    xhr.onerror = () => reject(new Error('Falha de conexão ao enviar o arquivo.'))
    const data = new FormData()
    data.append('file', file)
    data.append('caption', caption)
    xhr.send(data)
  })
}

function mergeMessages(current: Message[], incoming: Message[]) {
  const byId = new Map(current.map((m) => [m.id, m]))
  for (const m of incoming) byId.set(m.id, { ...byId.get(m.id), ...m })
  return [...byId.values()].sort((a, b) => a.id - b.id)
}

const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })
const dateFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
const shortDateFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' })

function dayLabel(iso: string) {
  const date = new Date(iso)
  const today = new Date()
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Hoje'
  if (date.toDateString() === yesterday.toDateString()) return 'Ontem'
  return dateFormat.format(date)
}

function previewTime(iso: string) {
  const date = new Date(iso)
  return date.toDateString() === new Date().toDateString() ? timeFormat.format(date) : shortDateFormat.format(date)
}

function ReadTicks({ message }: { message: Message }) {
  const read = !!message.readAt
  const label = read ? `Lida às ${timeFormat.format(new Date(message.readAt!))}` : 'Enviada, ainda não lida'
  return (
    <span className={`ticks ${read ? 'read' : 'sent'}`} role="img" aria-label={label} title={label}>
      <svg viewBox="0 0 18 12" width="18" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 6.5 4.5 10 11 2" /><path d="M7.5 9 8.5 10 15 2" />
      </svg>
    </span>
  )
}

/** Conversation keys: a contact id for direct messages, "ch:<id>" for a server channel. */
function convPath(key: string) {
  return key.startsWith('ch:') ? `/api/channels/${key.slice(3)}` : `/api/conversations/${key}`
}

function App() {
  const [user, setUser] = useState<User | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [contacts, setContacts] = useState<Contact[]>([])
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null)
  const [panel, setPanel] = useState<Panel>('chat')
  const [search, setSearch] = useState('')
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [nextPassword, setNextPassword] = useState('')
  const [dragging, setDragging] = useState(false)
  const [status, setStatus] = useState<User['status']>('offline')
  const [statusSaving, setStatusSaving] = useState(false)
  const [themePref, setThemePref] = useState<ThemePref>(savedTheme)
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPasswords, setShowPasswords] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const [newUser, setNewUser] = useState({ username: '', email: '', userTag: '', password: '' })
  const [conversations, setConversations] = useState<Record<string, Conversation>>({})
  const [threads, setThreads] = useState<Record<string, Thread>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)
  const [pending, setPending] = useState<PendingAttachment | null>(null)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const [lightbox, setLightbox] = useState<Message | null>(null)
  const [editing, setEditing] = useState<{ contactId: string; message: Message } | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [menu, setMenu] = useState<{ id: number; up: boolean } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Message | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [activeCall, setActiveCall] = useState<(CallJoin & { startVideo: boolean }) | null>(null)
  const [incomingCall, setIncomingCall] = useState<CallInfo | null>(null)
  const [callBusy, setCallBusy] = useState(false)
  const [callDockEl, setCallDockEl] = useState<HTMLDivElement | null>(null)
  const [callMiniEl, setCallMiniEl] = useState<HTMLDivElement | null>(null)
  const [guilds, setGuilds] = useState<GuildSummary[]>([])
  const [guildDetails, setGuildDetails] = useState<Record<string, GuildDetail>>({})
  // null shows direct messages; otherwise the open server.
  const [selectedGuildId, setSelectedGuildId] = useState<string | null>(null)
  const [channelByGuild, setChannelByGuild] = useState<Record<string, string>>({})
  const [channelUnread, setChannelUnread] = useState<Record<string, number>>({})
  const [mobileChannelOpen, setMobileChannelOpen] = useState(false)
  const [showMembers, setShowMembers] = useState(true)
  const [guildDialog, setGuildDialog] = useState<{ kind: 'add-server' } | { kind: 'invite-preview'; code: string } | { kind: Exclude<GuildAction, 'settings'> } | { kind: 'settings'; tab?: 'overview' | 'roles' | 'members' } | { kind: 'channel'; channel: Channel | null; voice?: boolean } | { kind: 'confirm'; title: string; text: string; action: string; run: () => Promise<void> } | null>(null)
  const [pendingInvite, setPendingInvite] = useState<string | null>(() => window.location.pathname.match(/^\/convite\/([A-Za-z0-9]{6,16})\/?$/)?.[1] ?? null)
  const channelGuildRef = useRef<Record<string, string>>({})
  type VoiceJoin = { channelId: string; guildId: string; url: string; token: string }
  const [activeVoice, setActiveVoice] = useState<VoiceJoin | null>(null)
  const [voiceByChannel, setVoiceByChannel] = useState<Record<string, VoiceMember[]>>({})
  const [speakingIds, setSpeakingIds] = useState<string[]>([])
  const [voiceDockEl, setVoiceDockEl] = useState<HTMLDivElement | null>(null)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const activeVoiceRef = useRef<VoiceJoin | null>(null)
  useLayoutEffect(() => { activeVoiceRef.current = activeVoice })
  const activeCallRef = useRef<string | null>(null)
  useLayoutEffect(() => { activeCallRef.current = activeCall?.call.id ?? null })
  const deleteCancelRef = useRef<HTMLButtonElement>(null)
  const dragDepth = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const lightboxCloseRef = useRef<HTMLButtonElement>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [connected, setConnected] = useState(true)
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  const canvasRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const stickToBottom = useRef(true)
  const olderAnchor = useRef<number | null>(null)
  const userIdRef = useRef<string | null>(null)
  const contactsRef = useRef<Contact[]>([])
  const selectedRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    userIdRef.current = user?.id ?? null
    contactsRef.current = contacts
  })

  useEffect(() => {
    applyTheme(themePref)
    if (themePref !== 'system') return
    return watchSystemTheme(() => applyTheme('system'))
  }, [themePref])

  function notify(kind: Toast['kind'], message: string) {
    setToast({ kind, message })
  }

  const selectedGuild = selectedGuildId ? guildDetails[selectedGuildId] : undefined
  const guildTextChannels = selectedGuild?.channels.filter((c) => c.kind === 'text') ?? []
  const selectedChannel = selectedGuild ? selectedGuild.channels.find((c) => c.id === channelByGuild[selectedGuild.id]) ?? guildTextChannels[0] : undefined
  const isVoiceView = selectedChannel?.kind === 'voice'
  const activeKey = selectedGuildId ? (selectedChannel && !isVoiceView ? `ch:${selectedChannel.id}` : null) : selectedContactId
  const activeChannelId = selectedChannel && !isVoiceView ? selectedChannel.id : null
  // Your permissions in the open text channel (-1: a direct message, where everything is allowed).
  const chanPerms = selectedGuild && selectedChannel && !isVoiceView ? selectedGuild.channelPermissions[selectedChannel.id] ?? 0 : -1
  const canSend = chanPerms === -1 || has(chanPerms, P.sendMessages)
  const canAttach = chanPerms === -1 || has(chanPerms, P.attachFiles)
  const canModerate = chanPerms !== -1 && has(chanPerms, P.manageMessages)
  useLayoutEffect(() => { selectedRef.current = panel === 'chat' ? activeKey : null })

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast((current) => current === toast ? null : current), toast.kind === 'error' ? 6000 : 4000)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    request<User>('/api/auth/me').then((u) => {
      setUser(u)
      setStatus(u.status)
    }).catch(() => {}).finally(() => setReady(true))
  }, [])

  useEffect(() => {
    if (user?.role === 'master') {
      request<User[]>('/api/users').then(setUsers).catch((err: Error) => notify('error', err.message))
    }
  }, [user?.role])

  useEffect(() => {
    if (!user?.id) return
    request<Contact[]>('/api/contacts').then(setContacts).catch((err: Error) => notify('error', err.message))
  }, [user?.id])

  const loadGuilds = useCallback(() => {
    request<GuildSummary[]>('/api/guilds').then(setGuilds).catch((err: Error) => notify('error', err.message))
  }, [])

  const loadGuild = useCallback(async (id: string) => {
    try {
      const detail = await request<GuildDetail>(`/api/guilds/${id}`)
      for (const c of detail.channels) channelGuildRef.current[c.id] = id
      setGuildDetails((all) => ({ ...all, [id]: detail }))
      setChannelUnread((all) => ({ ...all, ...Object.fromEntries(detail.channels.map((c) => [c.id, detail.unread[c.id] ?? 0])) }))
      setVoiceByChannel((all) => ({ ...all, ...Object.fromEntries(detail.channels.filter((c) => c.kind === 'voice').map((c) => [c.id, detail.voice?.[c.id] ?? []])) }))
    } catch (err) { notify('error', (err as Error).message) }
  }, [])

  const loadConversations = useCallback(() => {
    request<Conversation[]>('/api/conversations')
      .then((list) => setConversations(Object.fromEntries(list.map((c) => [c.contactId, c]))))
      .catch((err: Error) => notify('error', err.message))
  }, [])

  const loadThread = useCallback(async (key: string) => {
    try {
      const list = await request<Message[]>(`${convPath(key)}/messages?limit=${pageSize}`)
      setThreads((all) => {
        const previous = all[key]
        return { ...all, [key]: { messages: mergeMessages(previous?.messages ?? [], list), hasMore: previous?.loaded ? previous.hasMore : list.length === pageSize, loaded: true } }
      })
    } catch (err) { notify('error', (err as Error).message) }
  }, [])

  const applyUpdate = useCallback((message: Message) => {
    const me = userIdRef.current
    if (!me) return
    const contactId = message.channelId ? `ch:${message.channelId}` : message.senderId === me ? message.recipientId! : message.senderId
    setThreads((all) => {
      const thread = all[contactId]
      if (!thread) return all
      return { ...all, [contactId]: { ...thread, messages: thread.messages.map((m) => m.id === message.id ? message : m) } }
    })
    if (message.channelId) {
      if (message.deletedAt) {
        setLightbox((current) => current?.id === message.id ? null : current)
        setEditing((current) => current?.message.id === message.id ? null : current)
        setConfirmDelete((current) => current?.id === message.id ? null : current)
      }
      return
    }
    setConversations((all) => {
      const current = all[contactId]
      if (!current) return all
      const lastMessage = current.lastMessage.id === message.id ? message : current.lastMessage
      // The server announces a deletion once, so an unread deleted message is discounted once.
      const removedUnread = message.deletedAt && message.senderId === contactId && !message.readAt && current.unread > 0
      return { ...all, [contactId]: { ...current, lastMessage, unread: current.unread - (removedUnread ? 1 : 0) } }
    })
    if (message.call && message.call.status !== 'ringing' && message.call.status !== 'active' && message.senderId !== me) loadConversations()
    if (message.deletedAt) {
      setLightbox((current) => current?.id === message.id ? null : current)
      setEditing((current) => current?.message.id === message.id ? null : current)
      setConfirmDelete((current) => current?.id === message.id ? null : current)
    }
  }, [loadConversations])

  const guildDetailsRef = useRef<Record<string, GuildDetail>>({})
  const selectedGuildRef = useRef<string | null>(null)
  useLayoutEffect(() => { guildDetailsRef.current = guildDetails; selectedGuildRef.current = selectedGuildId })

  const handleGuildEvent = useCallback((guildId: string, action: 'updated' | 'removed') => {
    loadGuilds()
    if (action === 'updated') {
      if (guildDetailsRef.current[guildId]) void loadGuild(guildId)
      return
    }
    const name = guildDetailsRef.current[guildId]?.name
    setGuildDetails((all) => { const next = { ...all }; delete next[guildId]; return next })
    if (activeVoiceRef.current?.guildId === guildId) setActiveVoice(null)
    if (selectedGuildRef.current === guildId) {
      setSelectedGuildId(null)
      notify('error', name ? `Você não faz mais parte de ${name}.` : 'Você não faz mais parte deste servidor.')
    }
  }, [loadGuilds, loadGuild])

  const contactName = useCallback((id: string) => contactsRef.current.find((c) => c.id === id)?.username ?? 'O contato', [])

  const handleCallEvent = useCallback((call: CallInfo) => {
    const me = userIdRef.current
    if (!me) return
    const mine = activeCallRef.current === call.id
    if (call.status === 'ringing') {
      if (call.calleeId === me && !activeCallRef.current) setIncomingCall(call)
      return
    }
    // Answered in another tab, or finished: stop ringing here.
    setIncomingCall((current) => current?.id === call.id ? null : current)
    if (call.status === 'active') {
      if (mine) setActiveCall((current) => current ? { ...current, call } : current)
      return
    }
    if (mine) {
      setActiveCall(null)
      const name = contactName(call.callerId === me ? call.calleeId : call.callerId)
      if (call.callerId === me && call.status === 'declined') notify('error', `${name} recusou a ligação.`)
      else if (call.callerId === me && call.status === 'missed') notify('error', `${name} não atendeu.`)
      else if (call.status === 'ended') notify('success', 'Ligação encerrada.')
      else if (call.calleeId === me && call.status === 'cancelled') notify('success', `${name} desligou.`)
    }
  }, [contactName])

  const receive = useCallback((message: Message) => {
    const me = userIdRef.current
    if (!me) return
    const contactId = message.channelId ? `ch:${message.channelId}` : message.senderId === me ? message.recipientId! : message.senderId
    setThreads((all) => all[contactId] ? { ...all, [contactId]: { ...all[contactId], messages: mergeMessages(all[contactId].messages, [message]) } } : all)
    if (message.channelId) {
      const channelId = message.channelId
      if (message.senderId !== me) setChannelUnread((all) => ({ ...all, [channelId]: (all[channelId] ?? 0) + 1 }))
      // A channel of a server not opened yet: refresh the rail's unread dots.
      if (!channelGuildRef.current[channelId]) loadGuilds()
      return
    }
    setConversations((all) => {
      const current = all[contactId]
      if (current && current.lastMessage.id >= message.id) return all
      const isNewIncoming = message.senderId === contactId && !message.readAt && (!message.call || message.call.status === 'missed')
      return { ...all, [contactId]: { contactId, lastMessage: message, unread: (current?.unread ?? 0) + (isNewIncoming ? 1 : 0) } }
    })
  }, [loadGuilds])

  useEffect(() => {
    if (!user?.id) return
    let socket: WebSocket | null = null
    let retry = 0
    let timer: number | undefined
    let stopped = false
    const connect = () => {
      socket = new WebSocket(realtimeUrl)
      socket.onopen = () => {
        setConnected(true)
        // Reload on every open: events sent before the socket was ready would be lost.
        loadConversations()
        loadGuilds()
        for (const id of Object.keys(guildDetailsRef.current)) void loadGuild(id)
        if (retry > 0) {
          request<Contact[]>('/api/contacts').then(setContacts).catch(() => {})
          if (selectedRef.current) void loadThread(selectedRef.current)
        }
        retry = 0
      }
      socket.onmessage = (event) => {
        let data: RealtimeEvent
        try { data = JSON.parse(event.data) } catch { return }
        if (data.type === 'message') receive(data.message)
        if (data.type === 'message_updated') applyUpdate(data.message)
        if (data.type === 'call') handleCallEvent(data.call)
        if (data.type === 'guild') handleGuildEvent(data.guildId, data.action)
        if (data.type === 'voice_moved') {
          // A moderator moved us: follow to the new room, and to its view if we were watching the old one.
          const { channelId, guildId, url, token } = data
          setActiveVoice((current) => {
            setChannelByGuild((all) => all[guildId] === current?.channelId ? { ...all, [guildId]: channelId } : all)
            return { channelId, guildId, url, token }
          })
          notify('success', 'Você foi movido para outro canal de voz.')
        }
        if (data.type === 'voice') {
          const { channelId, members } = data
          setVoiceByChannel((all) => ({ ...all, [channelId]: members }))
          // Removed by the server (kicked, channel deleted, joined elsewhere in another tab).
          const me = userIdRef.current
          if (activeVoiceRef.current?.channelId === channelId && me && !members.some((m) => m.userId === me)) setActiveVoice(null)
        }
        if (data.type === 'presence') {
          const { userId, status } = data
          setContacts((list) => list.map((contact) => contact.id === userId ? { ...contact, status } : contact))
        }
        if (data.type === 'read') {
          const mark = (m: Message) => m.recipientId === data.readerId && !m.readAt ? { ...m, readAt: data.readAt } : m
          setThreads((all) => all[data.readerId] ? { ...all, [data.readerId]: { ...all[data.readerId], messages: all[data.readerId].messages.map(mark) } } : all)
          setConversations((all) => all[data.readerId] ? { ...all, [data.readerId]: { ...all[data.readerId], lastMessage: mark(all[data.readerId].lastMessage) } } : all)
        }
      }
      socket.onclose = () => {
        if (stopped) return
        setConnected(false)
        retry += 1
        timer = window.setTimeout(connect, Math.min(15000, 1000 * 2 ** Math.min(retry - 1, 4)))
      }
    }
    connect()
    return () => { stopped = true; window.clearTimeout(timer); socket?.close() }
  }, [user?.id, loadConversations, loadThread, receive, applyUpdate, handleCallEvent, loadGuilds, loadGuild, handleGuildEvent])

  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useEffect(() => {
    if (selectedGuildId && !guildDetails[selectedGuildId]) void loadGuild(selectedGuildId)
  }, [selectedGuildId, guildDetails, loadGuild])

  useEffect(() => {
    if (!activeKey || panel !== 'chat') return
    stickToBottom.current = true
    if (!threads[activeKey]?.loaded) void loadThread(activeKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, panel, loadThread])

  const openThread = activeKey && panel === 'chat' ? threads[activeKey] : undefined
  const dmKey = activeKey && !activeKey.startsWith('ch:') ? activeKey : null
  const hasUnreadOpen = !!dmKey && !!openThread?.messages.some((m) => m.senderId === dmKey && !m.readAt)
  const openChannelUnread = activeChannelId && panel === 'chat' ? channelUnread[activeChannelId] ?? 0 : 0

  // An open, visible channel counts as read.
  useEffect(() => {
    if (!activeChannelId || !openChannelUnread || !visible) return
    const id = activeChannelId
    setChannelUnread((all) => ({ ...all, [id]: 0 }))
    request<void>(`/api/channels/${id}/read`, { method: 'POST' }).catch(() => {})
  }, [activeChannelId, openChannelUnread, visible])

  useEffect(() => {
    if (!dmKey || !hasUnreadOpen || !visible) return
    const contactId = dmKey
    const now = new Date().toISOString()
    setThreads((all) => all[contactId] ? { ...all, [contactId]: { ...all[contactId], messages: all[contactId].messages.map((m) => m.senderId === contactId && !m.readAt ? { ...m, readAt: now } : m) } } : all)
    setConversations((all) => all[contactId] ? { ...all, [contactId]: { ...all[contactId], unread: 0 } } : all)
    request<void>(`/api/conversations/${contactId}/read`, { method: 'POST' }).catch(() => {})
  }, [dmKey, hasUnreadOpen, visible])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (olderAnchor.current !== null) {
      canvas.scrollTop = canvas.scrollHeight - olderAnchor.current
      olderAnchor.current = null
    } else if (stickToBottom.current) {
      canvas.scrollTop = canvas.scrollHeight
    }
  }, [openThread?.messages])

  async function loadOlder() {
    if (!activeKey || !openThread?.messages.length) return
    const contactId = activeKey
    setLoadingOlder(true)
    try {
      const list = await request<Message[]>(`${convPath(contactId)}/messages?limit=${pageSize}&before=${openThread.messages[0].id}`)
      olderAnchor.current = canvasRef.current ? canvasRef.current.scrollHeight - canvasRef.current.scrollTop : null
      setThreads((all) => ({ ...all, [contactId]: { messages: mergeMessages(all[contactId]?.messages ?? [], list), hasMore: list.length === pageSize, loaded: true } }))
    } catch (err) { notify('error', (err as Error).message) }
    finally { setLoadingOlder(false) }
  }

  function attachFile(file?: File | null) {
    if (!file || !activeKey) return
    if (!canSend || !canAttach) { notify('error', 'Você não tem permissão para enviar arquivos neste canal.'); return }
    const isImage = imageTypes.includes(file.type)
    if (!isImage && !documentExtensions.includes(fileExtension(file.name))) {
      notify('error', 'Tipo de arquivo não permitido. Envie imagens, PDF, documentos do Office/LibreOffice, TXT, CSV, MD, ZIP, RAR ou 7z.'); return
    }
    if (isImage && file.size > maxImageBytes) { notify('error', 'A imagem deve ter até 10 MB.'); return }
    if (file.size > maxFileBytes) { notify('error', 'O arquivo deve ter até 25 MB.'); return }
    if (file.size === 0) { notify('error', 'O arquivo está vazio.'); return }
    setPending((current) => {
      if (current?.preview) URL.revokeObjectURL(current.preview)
      return { contactId: activeKey, file, kind: isImage ? 'image' : 'file', preview: isImage ? URL.createObjectURL(file) : null }
    })
    composerRef.current?.focus()
  }

  function discardPending() {
    setPending((current) => { if (current?.preview) URL.revokeObjectURL(current.preview); return null })
  }

  async function sendPending(contactId: string, item: PendingAttachment) {
    const caption = (drafts[contactId] ?? '').trim()
    if (caption.length > maxMessageLength) { notify('error', `A legenda pode ter até ${maxMessageLength} caracteres.`); return }
    setSending(true); setUploadProgress(0)
    try {
      const message = await uploadAttachment(contactId, item.file, caption, setUploadProgress)
      stickToBottom.current = true
      setDrafts((all) => ({ ...all, [contactId]: '' }))
      setPending((current) => { if (current === item) { if (item.preview) URL.revokeObjectURL(item.preview); return null } return current })
      receive(message)
    } catch (err) { notify('error', (err as Error).message) }
    finally { setSending(false); setUploadProgress(null); composerRef.current?.focus() }
  }

  useEffect(() => {
    if (!activeKey || panel !== 'chat') return
    const onPaste = (event: ClipboardEvent) => {
      const file = fileFromClipboard(event.clipboardData)
      if (!file) return
      event.preventDefault()
      attachFile(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  })

  function dragHasFiles(event: DragEvent<HTMLElement>) {
    return [...event.dataTransfer.types].includes('Files')
  }

  function dropFile(event: DragEvent<HTMLElement>) {
    if (!dragHasFiles(event)) return
    event.preventDefault()
    dragDepth.current = 0; setDropActive(false)
    if (!activeKey || panel !== 'chat') return
    if (event.dataTransfer.files.length > 1) notify('error', 'Envie um arquivo por vez; o primeiro foi selecionado.')
    attachFile(event.dataTransfer.files[0])
  }

  useEffect(() => {
    if (!lightbox) return
    lightboxCloseRef.current?.focus()
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setLightbox(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox])

  useEffect(() => {
    if (!user?.id) return
    request<CallJoin | { call: null }>('/api/calls/current').then((res) => {
      if (!res.call) return
      if ('token' in res && res.token) setActiveCall({ ...(res as CallJoin), startVideo: false })
      else if (res.call.status === 'ringing' && res.call.calleeId === user.id) setIncomingCall(res.call)
    }).catch(() => {})
  }, [user?.id])

  // Warm up the call UI so an incoming call shows without delay.
  useEffect(() => {
    if (!user?.id) return
    const timer = window.setTimeout(() => { void import('./calls') }, 2000)
    return () => window.clearTimeout(timer)
  }, [user?.id])

  useEffect(() => {
    if (!user?.id) return
    request<VoiceJoin | { channelId: null }>('/api/voice/current').then((res) => { if (res.channelId) setActiveVoice(res as VoiceJoin) }).catch(() => {})
  }, [user?.id])

  async function joinVoice(channel: Channel) {
    if (activeVoice?.channelId === channel.id || voiceBusy) return
    const perms = guildDetails[channel.guildId]?.channelPermissions[channel.id] ?? 0
    if (!has(perms, P.connect)) { notify('error', 'Seus cargos não permitem entrar neste canal de voz.'); return }
    if (activeCall) { notify('error', 'Encerre a ligação atual antes de entrar em um canal de voz.'); return }
    setVoiceBusy(true)
    try {
      const res = await request<VoiceJoin>(`/api/channels/${channel.id}/voice/join`, { method: 'POST' })
      setActiveVoice(res)
    } catch (err) { notify('error', (err as Error).message) }
    finally { setVoiceBusy(false) }
  }

  async function leaveVoice() {
    setActiveVoice(null)
    await request<void>('/api/voice/leave', { method: 'POST' }).catch(() => {})
  }

  const reportVoiceState = useCallback((state: { muted: boolean; deafened: boolean; video: boolean; screen: boolean }) => {
    request<void>('/api/voice/state', { method: 'POST', body: JSON.stringify(state) }).catch(() => {})
  }, [])

  async function startCall(media: 'audio' | 'video') {
    if (!selectedContactId || callBusy) return
    if (activeCall) { notify('error', 'Você já está em uma ligação.'); return }
    if (activeVoice) { notify('error', 'Saia do canal de voz antes de ligar.'); return }
    setCallBusy(true)
    try {
      const res = await request<CallJoin & { unavailable?: string; message?: string }>('/api/calls', { method: 'POST', body: JSON.stringify({ contactId: selectedContactId, media }) })
      if (res.unavailable) notify('error', res.message ?? 'O contato não está disponível.')
      else setActiveCall({ ...res, startVideo: media === 'video' })
    } catch (err) { notify('error', (err as Error).message) }
    finally { setCallBusy(false) }
  }

  async function acceptCall(video: boolean) {
    if (!incomingCall || callBusy) return
    setCallBusy(true)
    try {
      const res = await request<CallJoin>(`/api/calls/${incomingCall.id}/accept`, { method: 'POST' })
      setIncomingCall(null)
      setActiveCall({ ...res, startVideo: video })
      // Like answering on Discord: open the conversation where the call lives.
      setSelectedContactId(res.call.callerId); setPanel('chat')
    } catch (err) { setIncomingCall(null); notify('error', (err as Error).message) }
    finally { setCallBusy(false) }
  }

  async function declineCall() {
    if (!incomingCall) return
    const id = incomingCall.id
    setIncomingCall(null)
    await request<void>(`/api/calls/${id}/decline`, { method: 'POST' }).catch(() => {})
  }

  async function endCall() {
    if (!activeCall) return
    const id = activeCall.call.id
    setActiveCall(null)
    await request<void>(`/api/calls/${id}/end`, { method: 'POST' }).catch(() => {})
  }

  function startEdit(message: Message) {
    if (!activeKey) return
    setMenu(null)
    setEditing({ contactId: activeKey, message })
    setEditDraft(message.body)
    window.requestAnimationFrame(() => { const field = composerRef.current; if (field) { field.focus(); field.setSelectionRange(field.value.length, field.value.length) } })
  }

  function cancelEdit() {
    setEditing(null); setEditDraft('')
    composerRef.current?.focus()
  }

  async function saveEdit() {
    if (!editing || sending) return
    const body = editDraft.trim()
    if (!body && !editing.message.attachment) { notify('error', 'A mensagem não pode ficar vazia. Para remover, use Apagar.'); return }
    if (body.length > maxMessageLength) { notify('error', `A mensagem pode ter até ${maxMessageLength} caracteres.`); return }
    if (body === editing.message.body) { cancelEdit(); return }
    setSending(true)
    try {
      const updated = await request<Message>(`/api/messages/${editing.message.id}`, { method: 'PATCH', body: JSON.stringify({ body }) })
      applyUpdate(updated)
      setEditing(null); setEditDraft('')
    } catch (err) {
      notify('error', (err as Error).message)
      if (changeTimeLeft(editing.message) <= 0) { setEditing(null); setEditDraft('') }
    }
    finally { setSending(false); composerRef.current?.focus() }
  }

  async function deleteMessage() {
    if (!confirmDelete) return
    setDeleting(true)
    try {
      const updated = await request<Message>(`/api/messages/${confirmDelete.id}`, { method: 'DELETE' })
      applyUpdate(updated)
      setConfirmDelete(null)
    } catch (err) { notify('error', (err as Error).message) }
    finally { setDeleting(false) }
  }

  async function copyMessage(message: Message) {
    setMenu(null)
    try { await navigator.clipboard.writeText(message.body); notify('success', 'Texto copiado.') }
    catch { notify('error', 'Não foi possível copiar o texto.') }
  }

  function openMenu(message: Message, anchor: HTMLElement) {
    setNow(Date.now())
    const canvas = canvasRef.current?.getBoundingClientRect()
    const rect = anchor.getBoundingClientRect()
    setMenu((current) => current?.id === message.id ? null : { id: message.id, up: !!canvas && rect.bottom > canvas.top + canvas.height * 0.6 })
  }

  useEffect(() => {
    if (!menu && !editing) return
    const timer = window.setInterval(() => setNow(Date.now()), 15000)
    return () => window.clearInterval(timer)
  }, [menu, editing])

  useEffect(() => {
    if (!menu) return
    const close = (event: MouseEvent) => { if (!(event.target as Element).closest?.('.message-menu, .bubble-menu-button')) setMenu(null) }
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setMenu(null) }
    document.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey) }
  }, [menu])

  useEffect(() => {
    if (!confirmDelete) return
    deleteCancelRef.current?.focus()
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape' && !deleting) setConfirmDelete(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmDelete, deleting])

  useEffect(() => {
    setMenu(null)
    setEditing((current) => current && current.contactId !== activeKey ? null : current)
  }, [activeKey, panel])

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault()
    if (!activeKey || sending) return
    if (editing?.contactId === activeKey) { await saveEdit(); return }
    const contactId = activeKey
    if (pending?.contactId === contactId) { await sendPending(contactId, pending); return }
    const body = (drafts[contactId] ?? '').trim()
    if (!body) return
    if (body.length > maxMessageLength) { notify('error', `A mensagem pode ter até ${maxMessageLength} caracteres.`); return }
    setSending(true)
    try {
      const message = await request<Message>(`${convPath(contactId)}/messages`, { method: 'POST', body: JSON.stringify({ body }) })
      stickToBottom.current = true
      setDrafts((all) => ({ ...all, [contactId]: '' }))
      receive(message)
    } catch (err) { notify('error', (err as Error).message) }
    finally { setSending(false); composerRef.current?.focus() }
  }

  function composerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void sendMessage()
    } else if (event.key === 'Escape' && editing && !sending) {
      cancelEdit()
    } else if (event.key === 'Escape' && pending && !sending) {
      discardPending()
    } else if (event.key === 'ArrowUp' && !editing && !pending && !event.currentTarget.value && activeKey && user) {
      const last = [...(threads[activeKey]?.messages ?? [])].reverse().find((m) => m.senderId === user.id && !m.deletedAt)
      if (last && changeTimeLeft(last) > 0) { event.preventDefault(); startEdit(last) }
    }
  }

  function clearSession() {
    setUser(null); setUsers([]); setContacts([]); setSelectedContactId(null); setPanel('chat')
    setGuilds([]); setGuildDetails({}); setSelectedGuildId(null); setChannelUnread({}); setGuildDialog(null)
    setConversations({}); setThreads({}); setDrafts({}); discardPending(); setLightbox(null); setEditing(null); setMenu(null); setConfirmDelete(null); setActiveCall(null); setIncomingCall(null); setActiveVoice(null); setVoiceByChannel({})
  }

  useLayoutEffect(() => {
    const field = composerRef.current
    // A hidden composer (mobile, before the chat opens) measures 0; size it once visible.
    if (!field || !field.offsetParent) return
    field.style.height = 'auto'
    field.style.height = `${Math.min(field.scrollHeight, 140)}px`
  }, [drafts, editDraft, activeKey, mobileChannelOpen, panel])

  async function login(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      const u = await request<User>('/api/auth/login', { method: 'POST', body: JSON.stringify({ identifier, password }) })
      setUser(u); setStatus(u.status); setPassword('')
    } catch (err) { notify('error', (err as Error).message) }
    finally { setBusy(false) }
  }

  async function logout() {
    try {
      await request<void>('/api/auth/logout', { method: 'POST' })
      clearSession(); notify('success', 'Você saiu da sua conta.')
    } catch (err) { notify('error', (err as Error).message) }
  }

  async function changeStatus(next: User['status']) {
    if (next === status || statusSaving) return
    const previous = status
    setStatus(next); setStatusSaving(true)
    try {
      const u = await request<User>('/api/auth/me', { method: 'PATCH', body: JSON.stringify({ status: next }) })
      setUser(u)
    } catch (err) { setStatus(previous); notify('error', (err as Error).message) }
    finally { setStatusSaving(false) }
  }

  async function uploadAvatar(file?: File) {
    if (!file) return
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 4 * 1024 * 1024) {
      notify('error', 'Escolha uma imagem PNG ou JPEG de até 4 MB.'); return
    }
    setAvatarUploading(true)
    try {
      const data = new FormData()
      data.append('avatar', file)
      const response = await fetch(`${apiBase}/api/auth/avatar`, { method: 'POST', credentials: 'include', body: data })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Não foi possível enviar a imagem.')
      setUser(result as User)
      notify('success', 'Foto atualizada.')
    } catch (err) { notify('error', (err as Error).message) }
    finally { setAvatarUploading(false) }
  }

  function dropAvatar(event: DragEvent<HTMLElement>) {
    event.preventDefault(); setDragging(false)
    void uploadAvatar(event.dataTransfer.files[0])
  }

  function selectAvatar(event: ChangeEvent<HTMLInputElement>) {
    void uploadAvatar(event.target.files?.[0])
    event.target.value = ''
  }

  function closePasswordForm() {
    setPasswordOpen(false); setCurrentPassword(''); setNextPassword(''); setConfirmPassword(''); setShowPasswords(false)
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault()
    if (nextPassword !== confirmPassword) { notify('error', 'A confirmação não confere com a nova senha.'); return }
    if (nextPassword === currentPassword) { notify('error', 'A nova senha precisa ser diferente da atual.'); return }
    setBusy(true)
    try {
      await request<void>('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword: nextPassword }) })
      clearSession(); closePasswordForm()
      notify('success', 'Senha alterada. Entre novamente.')
    } catch (err) { notify('error', (err as Error).message) }
    finally { setBusy(false) }
  }

  async function createUser(event: FormEvent) {
    event.preventDefault(); setBusy(true)
    try {
      const created = await request<User>('/api/users', { method: 'POST', body: JSON.stringify(newUser) })
      setUsers((list) => [...list, created]); setContacts((list) => [...list, { id: created.id, avatar: created.avatar, username: created.username, userTag: created.userTag, status: created.status }].sort((a, b) => a.username.localeCompare(b.username))); setNewUser({ username: '', email: '', userTag: '', password: '' })
      notify('success', `Usuário @${created.userTag} criado.`)
    } catch (err) { notify('error', (err as Error).message) }
    finally { setBusy(false) }
  }

  async function toggleUser(target: User) {
    const next = target.accountStatus === 'active' ? 'blocked' : 'active'
    try {
      await request<void>(`/api/users/${target.id}/status`, { method: 'PATCH', body: JSON.stringify({ accountStatus: next }) })
      setUsers((list) => list.map((u) => u.id === target.id ? { ...u, accountStatus: next } : u))
      if (next === 'blocked') {
        setContacts((list) => list.filter((contact) => contact.id !== target.id))
        if (selectedContactId === target.id) setSelectedContactId(null)
      } else {
        setContacts((list) => [...list, { id: target.id, avatar: target.avatar, username: target.username, userTag: target.userTag, status: target.status }].sort((a, b) => a.username.localeCompare(b.username)))
      }
      notify('success', `@${target.userTag}: ${next === 'active' ? 'ativo' : 'bloqueado'}.`)
    } catch (err) { notify('error', (err as Error).message) }
  }

  // Invite links (/convite/CODE) open a preview once logged in.
  useEffect(() => {
    if (!user || !pendingInvite) return
    setGuildDialog({ kind: 'invite-preview', code: pendingInvite })
    setPendingInvite(null)
    window.history.replaceState(null, '', '/')
  }, [user, pendingInvite])

  function openGuild(id: string | null) {
    setSelectedGuildId(id); setPanel('chat'); setMobileChannelOpen(false)
    if (id) loadGuilds()
  }

  function selectChannel(id: string) {
    if (!selectedGuildId) return
    setChannelByGuild((all) => ({ ...all, [selectedGuildId]: id })); setPanel('chat'); setMobileChannelOpen(true)
    // Clicking a voice channel joins it, like Discord.
    const channel = guildDetails[selectedGuildId]?.channels.find((c) => c.id === id)
    if (channel?.kind === 'voice') void joinVoice(channel)
  }

  function openVoiceView() {
    if (!activeVoice) return
    setSelectedGuildId(activeVoice.guildId)
    setChannelByGuild((all) => ({ ...all, [activeVoice.guildId]: activeVoice.channelId })); setPanel('chat'); setMobileChannelOpen(true)
  }

  async function joinedGuild(id: string) {
    setGuildDialog(null); loadGuilds(); await loadGuild(id); openGuild(id)
  }

  function guildAction(action: GuildAction) {
    if (!selectedGuild) return
    if (action === 'create-channel' || action === 'create-voice') { setGuildDialog({ kind: 'channel', channel: null, voice: action === 'create-voice' }); return }
    if (action === 'leave') {
      const g = selectedGuild
      setGuildDialog({ kind: 'confirm', title: `Sair de ${g.name}?`, text: 'Você deixa de ver os canais e só volta com um novo convite.', action: 'Sair do servidor', run: async () => {
        try {
          await request<void>(`/api/guilds/${g.id}/leave`, { method: 'POST' })
          setGuildDialog(null); openGuild(null); loadGuilds(); notify('success', `Você saiu de ${g.name}.`)
        } catch (err) { notify('error', (err as Error).message) }
      } })
      return
    }
    setGuildDialog({ kind: action })
  }

  function memberAction(member: Member, action: MemberAction) {
    if (!selectedGuild) return
    const g = selectedGuild
    if (action === 'message') { openGuild(null); setSelectedContactId(member.userId); return }
    if (action === 'kick') {
      setGuildDialog({ kind: 'confirm', title: `Remover ${member.username}?`, text: `${member.username} sai de ${g.name} e só volta com um novo convite.`, action: 'Remover do servidor', run: async () => {
        try { await request<void>(`/api/guilds/${g.id}/members/${member.userId}`, { method: 'DELETE' }); setGuildDialog(null); notify('success', `${member.username} foi removido.`) }
        catch (err) { notify('error', (err as Error).message) }
      } })
      return
    }
    setGuildDialog({ kind: 'settings', tab: 'members' })
  }

  function voiceAction(userId: string, action: VoiceAction) {
    const name = selectedGuild?.members.find((m) => m.userId === userId)?.username ?? 'Membro'
    const [path, body, done] = action.kind === 'move'
      ? ['move', { channelId: action.to }, `${name} foi movido.`]
      : action.kind === 'mute'
        ? ['mute', { muted: action.muted }, action.muted ? `${name} foi silenciado no servidor.` : `${name} pode falar de novo.`]
        : ['disconnect', {}, `${name} foi desconectado da voz.`]
    request<void>(`/api/voice/members/${userId}/${path}`, { method: 'POST', body: JSON.stringify(body) })
      .then(() => notify('success', done))
      .catch((err: Error) => notify('error', err.message))
  }

  const contactStatus = new Map(contacts.map((c) => [c.id, c.status]))
  const statusOf = (m: Member) => m.userId === user?.id ? status : contactStatus.get(m.userId) ?? m.status
  const guildHasUnread = (id: string) => {
    const detail = guildDetails[id]
    if (!detail) return (guilds.find((g) => g.id === id)?.unread ?? 0) > 0
    return detail.channels.some((c) => (channelUnread[c.id] ?? 0) > 0 && c.id !== activeChannelId)
  }
  const dmUnread = Object.values(conversations).reduce((sum, c) => sum + c.unread, 0)
  const memberById = new Map((selectedGuild?.members ?? []).map((m) => [m.userId, m]))
  const isChannel = !!selectedChannel && !!selectedGuildId && !isVoiceView

  const selectedContact = selectedGuildId ? undefined : contacts.find((contact) => contact.id === selectedContactId)
  const conv = isChannel && selectedChannel ? { key: `ch:${selectedChannel.id}`, label: `#${selectedChannel.name}` } : selectedContact ? { key: selectedContact.id, label: selectedContact.username } : null
  const mobileMainOpen = panel !== 'chat' || (selectedGuildId ? mobileChannelOpen : !!selectedContact)
  const filteredContacts = contacts
    .filter((contact) => `${contact.username} ${contact.userTag}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    .sort((a, b) => (conversations[b.id]?.lastMessage.id ?? 0) - (conversations[a.id]?.lastMessage.id ?? 0))
  const draft = activeKey ? drafts[activeKey] ?? '' : ''
  const isEditing = !!editing && editing.contactId === activeKey
  const composerValue = isEditing ? editDraft : draft

  return (
    <main className={user ? 'chat-app' : 'auth-shell'}>
      {!ready ? <p className="loading-state">Carregando…</p> : !user ? (
        <>
          <header className="auth-brand"><img src="/go-live-logo.png" alt="GO LIVE" /></header>
          <section className="card narrow" aria-labelledby="login-title">
            <span className="eyebrow">Acesso aos usuários cadastrados</span>
            <h1 id="login-title">Entrar no Go Live</h1>
            <p>Use seu e-mail ou @userTag. As contas são criadas pelo admin master.</p>
            <form onSubmit={login}>
              <label>E-mail ou @userTag<input autoComplete="username" required value={identifier} onChange={(e) => setIdentifier(e.target.value)} /></label>
              <label>Senha<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
              <button disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
            </form>
          </section>
        </>
      ) : (
        <>
          <div className={`nav-column ${mobileMainOpen ? 'mobile-hidden' : ''}`}>
          <ServerRail guilds={guilds} selectedId={selectedGuildId} hasUnread={guildHasUnread} dmUnread={dmUnread} onSelect={openGuild} onAdd={() => setGuildDialog({ kind: 'add-server' })} />
          <aside className="chat-sidebar" aria-label={selectedGuild ? `Canais de ${selectedGuild.name}` : 'Conversas'}>
            {selectedGuildId ? (selectedGuild ? (
              <GuildSidebar guild={selectedGuild} me={user.id} onVoiceAction={voiceAction} selectedChannelId={selectedChannel?.id ?? null} unread={channelUnread} voice={voiceByChannel} connectedVoiceId={activeVoice?.channelId ?? null} speaking={speakingIds} onSelectChannel={selectChannel} onAction={guildAction} onEditChannel={(channel) => setGuildDialog({ kind: 'channel', channel })} />
            ) : <p className="sidebar-empty">Carregando servidor…</p>) : (<>
            <div className="sidebar-search">
              <button className="icon-button" type="button" aria-label="Abrir perfil" title="Abrir perfil" onClick={() => setPanel(panel === 'profile' ? 'chat' : 'profile')}><img src="/figma-chat/menu.svg" alt="" /></button>
              <label className="search-box"><img src="/figma-chat/search.svg" alt="" /><span className="sr-only">Buscar contatos</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar" /></label>
            </div>
            <div className="sidebar-label"><span>Contatos</span><span>{contacts.length}</span></div>
            <div className="contact-list">
              {filteredContacts.length ? filteredContacts.map((contact) => (
                <button key={contact.id} type="button" className={`contact-item ${selectedContactId === contact.id && panel === 'chat' ? 'selected' : ''}`} onClick={() => { setSelectedContactId(contact.id); setPanel('chat') }}>
                  {contact.avatar ? <img className="contact-avatar" src={avatarSource(contact.avatar)} alt="" /> : <span className="contact-avatar contact-placeholder">{contact.username.slice(0, 1).toUpperCase()}</span>}
                  <span className="contact-text">
                    <span className="contact-line"><strong>{contact.username}</strong>{conversations[contact.id] && <time className="contact-time" dateTime={conversations[contact.id].lastMessage.createdAt}>{previewTime(conversations[contact.id].lastMessage.createdAt)}</time>}</span>
                    <span className="contact-line">
                      <small className="contact-preview">{conversations[contact.id]?.lastMessage.senderId === user.id && !conversations[contact.id].lastMessage.deletedAt && !conversations[contact.id].lastMessage.call && <ReadTicks message={conversations[contact.id].lastMessage} />}{conversations[contact.id] ? <>{conversations[contact.id].lastMessage.senderId === user.id && !conversations[contact.id].lastMessage.call && 'Você: '}{conversations[contact.id].lastMessage.call && <span className={`preview-call ${callSummary(conversations[contact.id].lastMessage.call!, conversations[contact.id].lastMessage.senderId === user.id).missed ? 'missed' : ''}`}><CallIcon path={conversations[contact.id].lastMessage.call!.media === 'video' ? callIcons.video : callIcons.phone} size={15} /></span>}{conversations[contact.id].lastMessage.attachment && (conversations[contact.id].lastMessage.attachment!.kind === 'image' ? <PhotoIcon /> : <FileIcon />)}{previewText(conversations[contact.id].lastMessage, user.id)}</> : `@${contact.userTag}`}</small>
                      {conversations[contact.id]?.unread ? <span className="unread-badge" aria-label={`${conversations[contact.id].unread} não lidas`}>{conversations[contact.id].unread > 99 ? '99+' : conversations[contact.id].unread}</span> : <span className={`presence-dot ${contact.status}`} aria-label={contact.status} />}
                    </span>
                  </span>
                </button>
              )) : <p className="sidebar-empty">{search ? 'Nenhum contato encontrado.' : 'Ainda não há outros usuários ativos.'}</p>}
            </div>
            </>)}
            <div ref={setCallMiniEl} />
            <div className="sidebar-footer">
              <button className="account-shortcut" type="button" onClick={() => setPanel('profile')}>
                <span className="small-avatar-wrap">{user.avatar ? <img className="small-avatar" src={avatarSource(user.avatar)} alt="" /> : <span className="small-avatar contact-placeholder">{user.username.slice(0, 1).toUpperCase()}</span>}<span className={`own-presence ${status}`} aria-label={`Seu status: ${status}`} /></span>
                <span><strong>{user.username}</strong><small>@{user.userTag}</small></span>
              </button>
              {user.role === 'master' && <button className="admin-shortcut" type="button" onClick={() => setPanel('admin')}>Admin</button>}
              <button className={`footer-gear ${panel === 'profile' ? 'active' : ''}`} type="button" onClick={() => setPanel(panel === 'profile' ? 'chat' : 'profile')} aria-label="Configurações do perfil" title="Configurações do perfil">
                <CallIcon path="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" size={20} />
              </button>
            </div>
          </aside>
          </div>
          <section className={`chat-main ${mobileMainOpen ? 'mobile-open' : ''}`}
            onDragEnter={(e) => { if (!dragHasFiles(e) || !conv || panel !== 'chat') return; e.preventDefault(); dragDepth.current += 1; setDropActive(true) }}
            onDragOver={(e) => { if (dragHasFiles(e) && conv && panel === 'chat') { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } }}
            onDragLeave={(e) => { if (!dragHasFiles(e)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDropActive(false) }}
            onDrop={dropFile}>
            {panel === 'chat' ? (
              <>
                {isVoiceView && selectedChannel && selectedGuild ? (
                  <>
                    <header className="conversation-header channel-header">
                      <button className="mobile-back" type="button" onClick={() => setMobileChannelOpen(false)} aria-label="Voltar aos canais">‹</button>
                      <span className="channel-header-hash" aria-hidden="true"><CallIcon path="M11 5 6 9H2v6h4l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" size={22} /></span>
                      <div className="conversation-identity"><strong>{selectedChannel.name}</strong><small>{(voiceByChannel[selectedChannel.id] ?? []).length} no canal de voz</small></div>
                    </header>
                    {activeVoice?.channelId === selectedChannel.id ? <div className="call-dock voice-dock" ref={setVoiceDockEl} /> : (
                      <div className="voice-join">
                        <span className="voice-join-icon"><CallIcon path="M11 5 6 9H2v6h4l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" size={34} /></span>
                        <h1>{selectedChannel.name}</h1>
                        <p>{(voiceByChannel[selectedChannel.id] ?? []).length ? `${(voiceByChannel[selectedChannel.id] ?? []).map((v) => memberById.get(v.userId)?.username ?? 'Membro').join(', ')} ${(voiceByChannel[selectedChannel.id] ?? []).length === 1 ? 'está' : 'estão'} conversando.` : 'Ninguém está aqui agora.'}</p>
                        <button type="button" className="primary-button" onClick={() => joinVoice(selectedChannel)} disabled={voiceBusy}>{voiceBusy ? 'Entrando…' : 'Entrar no canal de voz'}</button>
                      </div>
                    )}
                  </>
                ) : conv ? (
                  <>
                    {isChannel && selectedChannel && selectedGuild ? (
                      <header className="conversation-header channel-header">
                        <button className="mobile-back" type="button" onClick={() => setMobileChannelOpen(false)} aria-label="Voltar aos canais">‹</button>
                        <span className="channel-header-hash" aria-hidden="true"><CallIcon path="M5 9h14M5 15h14M10 3 8 21M16 3l-2 18" size={22} /></span>
                        <div className="conversation-identity"><strong>{selectedChannel.name}</strong>{(selectedChannel.topic || !connected) && <small>{connected ? selectedChannel.topic : 'Reconectando…'}</small>}</div>
                        <button className={`icon-button header-action members-toggle ${showMembers ? 'active' : ''}`} type="button" onClick={() => setShowMembers((v) => !v)} aria-pressed={showMembers} aria-label={showMembers ? 'Ocultar membros' : 'Mostrar membros'} title={showMembers ? 'Ocultar membros' : 'Mostrar membros'}><CallIcon path="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" size={22} /></button>
                      </header>
                    ) : selectedContact && (
                    <header className="conversation-header">
                      <button className="mobile-back" type="button" onClick={() => setSelectedContactId(null)} aria-label="Voltar aos contatos">‹</button>
                      {selectedContact.avatar ? <img className="header-avatar" src={avatarSource(selectedContact.avatar)} alt="" /> : <span className="header-avatar contact-placeholder">{selectedContact.username.slice(0, 1).toUpperCase()}</span>}
                      <div className="conversation-identity"><strong>{selectedContact.username}</strong><small>{connected ? <>@{selectedContact.userTag} · {selectedContact.status === 'online' ? 'online' : selectedContact.status === 'busy' ? 'ocupado' : selectedContact.status === 'away' ? 'ausente' : 'offline'}</> : 'Reconectando…'}</small></div>
                      <button className="icon-button header-action" type="button" onClick={() => notify('success', 'Busca de mensagens chega na próxima etapa.')} aria-label="Buscar mensagens" title="Buscar mensagens"><img src="/figma-chat/search-header.svg" alt="" /></button>
                      <button className="icon-button header-action" type="button" onClick={() => startCall('audio')} disabled={callBusy || !!activeCall} aria-label={`Ligar para ${selectedContact.username}`} title="Chamada de voz"><img src="/figma-chat/call.svg" alt="" /></button>
                      <button className="icon-button header-action video-action" type="button" onClick={() => startCall('video')} disabled={callBusy || !!activeCall} aria-label={`Chamada de vídeo com ${selectedContact.username}`} title="Chamada de vídeo"><CallIcon path={callIcons.video} size={22} /></button>
                      <button className="icon-button header-action" type="button" onClick={() => setPanel('profile')} aria-label="Mais opções" title="Mais opções"><img src="/figma-chat/more.svg" alt="" /></button>
                    </header>
                    )}
                    {activeCall && selectedContact && [activeCall.call.callerId, activeCall.call.calleeId].includes(selectedContact.id) && <div className="call-dock" ref={setCallDockEl} />}
                    <div className="conversation-canvas" ref={canvasRef} onScroll={(e) => { const el = e.currentTarget; stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
                      {!openThread?.loaded ? <p className="thread-status">Carregando mensagens…</p> : !openThread.messages.length ? (
                        isChannel ? (
                          <div className="empty-conversation channel-welcome"><span className="empty-mark">#</span><h1>Boas-vindas a #{selectedChannel?.name}</h1><p>Este é o começo do canal{selectedChannel?.topic ? ` — ${selectedChannel.topic}` : ''}.</p></div>
                        ) : <div className="empty-conversation"><span className="empty-mark">✦</span><h1>Conversa com {conv.label}</h1><p>Nenhuma mensagem ainda. Diga olá!</p></div>
                      ) : (
                        <ol className={`message-list ${isChannel ? 'is-channel' : ''}`} aria-label={isChannel ? `Mensagens em ${conv.label}` : `Mensagens com ${conv.label}`}>
                          {openThread.hasMore && <li className="load-older"><button type="button" disabled={loadingOlder} onClick={loadOlder}>{loadingOlder ? 'Carregando…' : 'Carregar mensagens anteriores'}</button></li>}
                          {openThread.messages.map((m, index) => {
                            const mine = m.senderId === user.id
                            const previous = openThread.messages[index - 1]
                            const newDay = !previous || new Date(previous.createdAt).toDateString() !== new Date(m.createdAt).toDateString()
                            return (
                              <li key={m.id} className="message-row-wrap">
                                {newDay && <div className="day-separator"><span>{dayLabel(m.createdAt)}</span></div>}
                                {isChannel && !mine && (!previous || previous.senderId !== m.senderId || newDay) && (() => {
                                  const author = memberById.get(m.senderId)
                                  const name = author?.username ?? contacts.find((c) => c.id === m.senderId)?.username ?? 'Ex-membro'
                                  const avatar = author?.avatar ?? contacts.find((c) => c.id === m.senderId)?.avatar ?? ''
                                  return (
                                    <div className="message-author">
                                      {avatar ? <img className="author-avatar" src={avatarSource(avatar)} alt="" /> : <span className="author-avatar contact-placeholder">{name.slice(0, 1).toUpperCase()}</span>}
                                      <strong>{name}</strong>
                                    </div>
                                  )
                                })()}
                                <div className={`message-row ${mine ? 'mine' : 'theirs'} ${previous && previous.senderId === m.senderId && !newDay ? 'grouped' : ''} ${menu?.id === m.id ? 'menu-open' : ''} ${editing?.message.id === m.id ? 'being-edited' : ''}`}>
                                  {m.call ? (() => {
                                    const summary = callSummary(m.call, mine)
                                    return (
                                      <div className={`bubble call-bubble ${summary.missed ? 'missed' : ''}`}>
                                        <span className="call-bubble-icon"><CallIcon path={summary.missed ? callIcons.missed : m.call.media === 'video' ? callIcons.video : callIcons.phone} size={20} /></span>
                                        <span className="call-bubble-text"><strong>{summary.missed ? (m.call.media === 'video' ? 'Chamada de vídeo perdida' : 'Chamada de voz perdida') : summary.kind}</strong><small>{summary.missed ? timeFormat.format(new Date(m.createdAt)) : `${summary.detail} · ${timeFormat.format(new Date(m.createdAt))}`}</small></span>
                                        {m.call.status !== 'ringing' && m.call.status !== 'active' && <button type="button" className="call-bubble-again" onClick={() => startCall(m.call!.media)} disabled={callBusy || !!activeCall} aria-label="Ligar de novo" title="Ligar de novo"><CallIcon path={m.call.media === 'video' ? callIcons.video : callIcons.phone} /></button>}
                                      </div>
                                    )
                                  })() : m.deletedAt ? (
                                    <div className="bubble deleted">
                                      <p><MenuIcon path={iconPaths.ban} />{mine ? 'Você apagou esta mensagem' : 'Mensagem apagada'}</p>
                                      <span className="bubble-meta"><time dateTime={m.createdAt}>{timeFormat.format(new Date(m.createdAt))}</time></span>
                                    </div>
                                  ) : (
                                  <div className={`bubble ${m.attachment?.kind === 'image' ? 'has-image' : ''} ${m.attachment?.kind === 'image' && !m.body ? 'image-only' : ''} ${m.attachment?.kind === 'file' ? 'has-file' : ''}`}
                                    onContextMenu={(e) => { if ((e.target as Element).closest('a, .bubble-image')) return; e.preventDefault(); openMenu(m, e.currentTarget) }}>
                                    <button type="button" className="bubble-menu-button" aria-label="Opções da mensagem" aria-haspopup="menu" aria-expanded={menu?.id === m.id} onClick={(e) => openMenu(m, e.currentTarget)}><MenuIcon path={iconPaths.chevron} /></button>
                                    {menu?.id === m.id && (
                                      <div className={`message-menu ${menu.up ? 'up' : ''}`} role="menu">
                                        {mine && changeTimeLeft(m, now) > 0 && <button type="button" role="menuitem" onClick={() => startEdit(m)}><MenuIcon path={iconPaths.edit} />{m.attachment ? (m.body ? 'Editar legenda' : 'Adicionar legenda') : 'Editar'}</button>}
                                        {m.body && <button type="button" role="menuitem" onClick={() => copyMessage(m)}><MenuIcon path={iconPaths.copy} />Copiar texto</button>}
                                        {((mine && changeTimeLeft(m, now) > 0) || canModerate) && <button type="button" role="menuitem" className="danger" onClick={() => { setMenu(null); setConfirmDelete(m) }}><MenuIcon path={iconPaths.trash} />{mine ? 'Apagar' : 'Apagar (moderação)'}</button>}
                                        {mine && <span className="message-menu-note">{changeTimeLeft(m, now) > 0 ? `Editar e apagar: mais ${Math.max(1, Math.ceil(changeTimeLeft(m, now) / 60000))} min` : 'Editar e apagar só nos primeiros 5 minutos'}</span>}
                                        {!mine && !m.body && <span className="message-menu-empty">Sem ações disponíveis</span>}
                                      </div>
                                    )}
                                    {m.attachment?.kind === 'file' && (
                                      <div className="file-card">
                                        <a className="file-card-main" href={`${apiBase}${m.attachment.url}${m.attachment.contentType === 'application/pdf' ? '' : '?download=1'}`} target="_blank" rel="noopener" title={m.attachment.contentType === 'application/pdf' ? 'Abrir PDF em nova aba' : 'Baixar arquivo'}>
                                          <FileBadge name={m.attachment.name} />
                                          <span className="file-card-text"><strong>{m.attachment.name}</strong><small>{formatBytes(m.attachment.size)} · {fileExtension(m.attachment.name).toUpperCase() || 'Arquivo'}</small></span>
                                        </a>
                                        <a className="file-card-download" href={`${apiBase}${m.attachment.url}?download=1`} aria-label={`Baixar ${m.attachment.name}`} title="Baixar"><DownloadIcon /></a>
                                      </div>
                                    )}
                                    {m.attachment?.kind === 'image' && (
                                      <button type="button" className="bubble-image" style={bubbleImageSize(m.attachment)} onClick={() => setLightbox(m)} aria-label="Abrir imagem em tela cheia">
                                        <img src={`${apiBase}${m.attachment.url}`} alt={m.body || 'Imagem enviada'} loading="lazy" width={m.attachment.width} height={m.attachment.height} />
                                      </button>
                                    )}
                                    {m.body && <p>{m.body}</p>}
                                    <span className="bubble-meta">{m.editedAt && <span className="edited-mark" title={`Editada às ${timeFormat.format(new Date(m.editedAt))}`}>editada</span>}<time dateTime={m.createdAt}>{timeFormat.format(new Date(m.createdAt))}</time>{mine && !isChannel && <ReadTicks message={m} />}</span>
                                  </div>
                                  )}
                                </div>
                              </li>
                            )
                          })}
                        </ol>
                      )}
                    </div>
                    <div className="composer-area">
                      {isEditing && editing && (
                        <div className="edit-banner" aria-live="polite">
                          <MenuIcon path={iconPaths.edit} />
                          <span><strong>{editing.message.attachment ? 'Editando legenda' : 'Editando mensagem'}{changeTimeLeft(editing.message, now) > 0 && changeTimeLeft(editing.message, now) < 60000 && <em className="edit-deadline"> · menos de 1 min</em>}</strong><small>{editing.message.body || (editing.message.attachment?.kind === 'image' ? 'Foto sem legenda' : editing.message.attachment?.name)}</small></span>
                          <button type="button" onClick={cancelEdit} disabled={sending} aria-label="Cancelar edição" title="Cancelar (Esc)"><MenuIcon path={iconPaths.close} /></button>
                        </div>
                      )}
                      {!isEditing && pending?.contactId === conv.key && (
                        <div className="image-preview" aria-label={pending.kind === 'image' ? 'Imagem pronta para enviar' : 'Arquivo pronto para enviar'}>
                          <div className={`image-preview-thumb ${pending.kind === 'file' ? 'is-file' : ''}`}>
                            {pending.preview ? <img src={pending.preview} alt="Prévia da imagem" /> : <FileBadge name={pending.file.name} />}
                            {uploadProgress !== null && <div className="upload-progress" role="progressbar" aria-label="Enviando arquivo" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(uploadProgress * 100)}><span style={{ width: `${Math.round(uploadProgress * 100)}%` }} /></div>}
                          </div>
                          <div className="image-preview-info">
                            <strong>{pending.file.name || 'Imagem colada'}</strong>
                            <small>{uploadProgress !== null ? `Enviando… ${Math.round(uploadProgress * 100)}%` : `${formatBytes(pending.file.size)} · Enter envia, Esc cancela`}</small>
                          </div>
                          <button type="button" className="image-preview-remove" onClick={discardPending} disabled={sending} aria-label="Remover anexo" title="Remover anexo">×</button>
                        </div>
                      )}
                      {!canSend ? (
                        <div className="composer composer-locked" role="note">
                          <CallIcon path="M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4" size={20} />
                          <span>Você não tem permissão para enviar mensagens em {conv.label}.</span>
                        </div>
                      ) : (
                      <form className="composer" onSubmit={sendMessage}>
                        {canAttach && <button type="button" className="attach-button" onClick={() => fileInputRef.current?.click()} disabled={sending || isEditing} aria-label="Anexar arquivo do computador" title="Anexar imagem ou arquivo (ou cole com Ctrl+V / arraste)">
                          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5 12.4 20a5.5 5.5 0 0 1-7.8-7.8l8.9-8.9a3.7 3.7 0 0 1 5.2 5.2l-8.9 8.9a1.8 1.8 0 0 1-2.6-2.6l8.2-8.2" /></svg>
                        </button>}
                        <input ref={fileInputRef} type="file" hidden accept={attachmentAccept} onChange={(e) => { attachFile(e.target.files?.[0]); e.target.value = '' }} />
                        <label className="sr-only" htmlFor="composer-input">{isChannel ? `Mensagem em ${conv.label}` : `Mensagem para ${conv.label}`}</label>
                        <textarea id="composer-input" ref={composerRef} rows={1} maxLength={maxMessageLength} placeholder={isEditing ? (editing?.message.attachment ? 'Legenda' : 'Mensagem') : pending?.contactId === conv.key ? 'Adicionar legenda' : isChannel ? `Conversar em ${conv.label}` : 'Mensagem'} value={composerValue} onKeyDown={composerKeyDown} onChange={(e) => isEditing ? setEditDraft(e.target.value) : setDrafts((all) => ({ ...all, [conv.key]: e.target.value }))} />
                        <button type="submit" disabled={sending || (isEditing ? !editDraft.trim() && !editing?.message.attachment : !draft.trim() && pending?.contactId !== conv.key)} aria-label={isEditing ? 'Salvar edição' : 'Enviar mensagem'} title={isEditing ? 'Salvar (Enter)' : 'Enviar (Enter)'}>{isEditing ? <svg className="save-edit-icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg> : <img src="/figma-chat/send.svg" alt="" />}</button>
                      </form>
                      )}
                    </div>
                    {dropActive && <div className="drop-overlay" aria-hidden="true"><div><strong>Solte o arquivo aqui</strong><span>Imagens até 10 MB · PDF, documentos e compactados até 25 MB</span></div></div>}
                  </>
                ) : (
                  <div className="welcome-view"><img src="/go-live-icon.png" alt="" /><h1>GO LIVE</h1><p>{selectedGuildId ? 'Carregando o servidor…' : 'Selecione um contato para abrir a conversa.'}</p><span>Mensagens, arquivos, chamadas de voz e vídeo e compartilhamento de tela.</span></div>
                )}
              </>
            ) : (
              <div className="settings-view">
                <header className="settings-header">
                  <button className="icon-button settings-back" type="button" onClick={() => setPanel('chat')} aria-label="Voltar ao chat" title="Voltar ao chat">
                    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18 9 12l6-6" /></svg>
                  </button>
                  <h1>{panel === 'admin' ? 'Administração' : 'Meu perfil'}</h1>
                </header>
                {panel === 'profile' ? <div className="profile-page">
                  <section className="profile-hero">
                    <button type="button" className={`profile-avatar ${dragging ? 'dragging' : ''} ${avatarUploading ? 'uploading' : ''}`} onClick={() => avatarInputRef.current?.click()} disabled={avatarUploading}
                      onDragOver={(e) => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={dropAvatar} aria-label="Alterar foto de perfil" title="Clique ou arraste uma imagem para trocar a foto">
                      {user.avatar ? <img src={avatarSource(user.avatar)} alt="" /> : <span className="profile-avatar-initial">{user.username.slice(0, 1).toUpperCase()}</span>}
                      <span className="profile-avatar-overlay">
                        {avatarUploading ? <span className="spinner" /> : <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" /><circle cx="12" cy="13.5" r="3.5" /></svg>}
                      </span>
                      <span className={`profile-presence ${status}`} aria-hidden="true" />
                    </button>
                    <input ref={avatarInputRef} type="file" hidden accept=".png,.jpg,.jpeg,image/png,image/jpeg" onChange={selectAvatar} />
                    <h2>{user.username}</h2>
                    <p className="profile-handle">@{user.userTag}</p>
                    {user.role === 'master' && <span className="role-chip">Admin master</span>}
                    <small className="profile-hint">Clique na foto ou arraste uma imagem · PNG ou JPEG até 4 MB</small>
                  </section>

                  <section className="settings-group" aria-labelledby="status-title">
                    <h3 id="status-title">Status</h3>
                    <div className="status-options" role="radiogroup" aria-label="Status de presença">
                      {([['online', 'Online', 'Disponível para conversar'], ['away', 'Ausente', 'Volto já'], ['busy', 'Ocupado', 'Não incomodar'], ['offline', 'Invisível', 'Aparece offline para todos']] as const).map(([value, label, hint]) => (
                        <button key={value} type="button" role="radio" aria-checked={status === value} className={`status-option ${status === value ? 'active' : ''}`} onClick={() => changeStatus(value)} disabled={statusSaving && status !== value}>
                          <span className={`presence-dot ${value}`} aria-hidden="true" />
                          <span><strong>{label}</strong><small>{hint}</small></span>
                          {status === value && <svg className="status-check" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>}
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="settings-group" aria-labelledby="theme-title">
                    <h3 id="theme-title">Aparência</h3>
                    <div className="theme-options" role="radiogroup" aria-label="Tema">
                      {([['light', 'Claro', 'M12 4V2M12 22v-2M4.9 4.9 3.5 3.5M20.5 20.5l-1.4-1.4M4 12H2M22 12h-2M4.9 19.1l-1.4 1.4M20.5 3.5l-1.4 1.4M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z'], ['dark', 'Escuro', 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z'], ['system', 'Automático', 'M3 4h18v12H3zM8 20h8M12 16v4']] as const).map(([value, label, icon]) => (
                        <button key={value} type="button" role="radio" aria-checked={themePref === value} className={`theme-option ${themePref === value ? 'active' : ''}`} onClick={() => setThemePref(value)}>
                          <span className={`theme-swatch ${value}`} aria-hidden="true"><CallIcon path={icon} size={18} /></span>
                          <strong>{label}</strong>
                          {value === 'system' && <small>Segue o sistema</small>}
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="settings-group" aria-labelledby="account-title">
                    <h3 id="account-title">Conta</h3>
                    <div className="settings-list">
                      <div className="settings-row"><span className="settings-row-label">E-mail</span><span className="settings-row-value">{user.email}</span></div>
                      <div className="settings-row"><span className="settings-row-label">Usuário</span><span className="settings-row-value">@{user.userTag}</span></div>
                      <div className={`settings-row password-row ${passwordOpen ? 'open' : ''}`}>
                        <span className="settings-row-label">Senha</span>
                        {!passwordOpen && <button type="button" className="row-action" onClick={() => setPasswordOpen(true)}>Alterar</button>}
                      </div>
                      {passwordOpen && (
                        <form className="password-form" onSubmit={changePassword}>
                          <label>Senha atual<input type={showPasswords ? 'text' : 'password'} autoComplete="current-password" required autoFocus value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} /></label>
                          <label>Nova senha<input type={showPasswords ? 'text' : 'password'} autoComplete="new-password" minLength={12} required value={nextPassword} onChange={(e) => setNextPassword(e.target.value)} /></label>
                          <label>Confirmar nova senha<input type={showPasswords ? 'text' : 'password'} autoComplete="new-password" minLength={12} required value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} aria-invalid={!!confirmPassword && confirmPassword !== nextPassword} /></label>
                          <div className="password-meta">
                            <span className={nextPassword.length >= 12 ? 'ok' : ''}>{nextPassword.length >= 12 ? '✓' : '•'} Pelo menos 12 caracteres</span>
                            <span className={confirmPassword && confirmPassword === nextPassword ? 'ok' : confirmPassword ? 'bad' : ''}>{confirmPassword && confirmPassword === nextPassword ? '✓' : '•'} As senhas conferem</span>
                          </div>
                          <label className="inline-check"><input type="checkbox" checked={showPasswords} onChange={(e) => setShowPasswords(e.target.checked)} /> Mostrar senhas</label>
                          <p className="password-note">Depois de alterar, você sai de todos os dispositivos e entra de novo.</p>
                          <div className="form-actions">
                            <button type="button" className="ghost-button" onClick={closePasswordForm} disabled={busy}>Cancelar</button>
                            <button type="submit" className="primary-button" disabled={busy || nextPassword.length < 12 || nextPassword !== confirmPassword || !currentPassword}>{busy ? 'Salvando…' : 'Salvar nova senha'}</button>
                          </div>
                        </form>
                      )}
                    </div>
                  </section>

                  <section className="settings-group">
                    <div className="settings-list">
                      {user.role === 'master' && (
                        <button type="button" className="settings-row settings-link" onClick={() => setPanel('admin')}>
                          <span className="settings-row-label">Administração</span><span className="settings-row-value">Usuários e acessos</span>
                          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
                        </button>
                      )}
                      <button type="button" className="settings-row settings-link danger" onClick={logout}>
                        <span className="settings-row-label">Sair da conta</span>
                        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="m10 16-4-4 4-4" /><path d="M6 12h10" /></svg>
                      </button>
                    </div>
                  </section>
                </div> : <section className="card admin">
                  <span className="eyebrow">Admin master</span><h2>Cadastrar usuário</h2>
                  <form onSubmit={createUser}>
                    <label>Nome<input required minLength={2} maxLength={80} value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} /></label>
                    <label>E-mail<input required type="email" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} /></label>
                    <label>UserTag<input required placeholder="ana" pattern="@?[a-zA-Z0-9_]{3,32}" value={newUser.userTag} onChange={(e) => setNewUser({ ...newUser, userTag: e.target.value })} /></label>
                    <label>Senha inicial<input required type="password" minLength={12} autoComplete="new-password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} /></label>
                    <button disabled={busy}>Criar usuário</button>
                  </form>
                  <h2>Usuários</h2>
                  <ul className="user-list">{users.map((u) => <li key={u.id}><span><strong>{u.username}</strong><small>@{u.userTag} · {u.accountStatus === 'active' ? 'Ativo' : 'Bloqueado'}</small></span>{u.role !== 'master' && <button className="secondary" type="button" onClick={() => toggleUser(u)}>{u.accountStatus === 'active' ? 'Bloquear' : 'Ativar'}</button>}</li>)}</ul>
                </section>}
              </div>
            )}
          </section>
          {selectedGuild && isChannel && showMembers && panel === 'chat' && <MemberList guild={selectedGuild} me={user.id} statusOf={statusOf} onAction={memberAction} />}
        </>
      )}
      {user && guildDialog && (() => {
        const close = () => setGuildDialog(null)
        switch (guildDialog.kind) {
          case 'add-server': return <AddServerDialog onClose={close} onCreated={joinedGuild} onJoinCode={(code) => setGuildDialog({ kind: 'invite-preview', code })} notify={notify} />
          case 'invite-preview': return <InvitePreviewDialog code={guildDialog.code} onClose={close} onJoined={joinedGuild} notify={notify} />
          case 'confirm': return <ConfirmDialog title={guildDialog.title} text={guildDialog.text} action={guildDialog.action} onConfirm={guildDialog.run} onClose={close} />
        }
        if (!selectedGuild) return null
        switch (guildDialog.kind) {
          case 'invite': return <InviteDialog guild={selectedGuild} onClose={close} notify={notify} />
          case 'add-members': return <AddMembersDialog guild={selectedGuild} contacts={contacts.map((c) => ({ ...c, avatar: c.avatar }))} onClose={close} notify={notify} />
          case 'settings': return <ServerSettingsDialog guild={selectedGuild} me={user.id} initialTab={guildDialog.tab} onClose={close} onDeleted={() => { close(); openGuild(null); loadGuilds(); notify('success', 'Servidor excluído.') }} notify={notify} />
          case 'channel': return guildDialog.channel
            ? <ChannelSettingsDialog guild={selectedGuild} channel={guildDialog.channel} onClose={close} onDeleted={() => { close(); void loadGuild(selectedGuild.id); notify('success', 'Canal excluído.') }} notify={notify} />
            : <ChannelDialog guild={selectedGuild} channel={guildDialog.channel} initialKind={guildDialog.voice ? 'voice' : 'text'} onClose={close} notify={notify}
            onSaved={(saved) => {
              close(); void loadGuild(selectedGuild.id)
              if (saved && saved.kind === 'text') setChannelByGuild((all) => ({ ...all, [selectedGuild.id]: saved.id }))
              notify('success', saved ? (guildDialog.channel ? 'Canal atualizado.' : `${saved.kind === 'voice' ? 'Canal de voz' : '#'}${saved.kind === 'voice' ? ` ${saved.name}` : saved.name} criado.`) : 'Canal excluído.')
            }} />
        }
        return null
      })()}
      <Suspense fallback={null}>
      {user && incomingCall && !activeCall && (() => {
        const peer = contacts.find((c) => c.id === incomingCall.callerId)
        return <IncomingCall call={incomingCall} peer={{ username: peer?.username ?? 'Contato', avatar: peer?.avatar ? avatarSource(peer.avatar) : '' }} onAccept={acceptCall} onDecline={declineCall} busy={callBusy} />
      })()}
      {user && activeCall && (() => {
        const peerId = activeCall.call.callerId === user.id ? activeCall.call.calleeId : activeCall.call.callerId
        const peer = contacts.find((c) => c.id === peerId)
        const docked = panel === 'chat' && selectedContactId === peerId
        return <CallScreen key={activeCall.call.id} join={activeCall} me={{ id: user.id, username: user.username, avatar: user.avatar ? avatarSource(user.avatar) : '' }} peer={{ id: peerId, username: peer?.username ?? 'Contato', avatar: peer?.avatar ? avatarSource(peer.avatar) : '' }} startVideo={activeCall.startVideo}
          docked={docked} dockEl={callDockEl} miniEl={callMiniEl} onOpen={() => { setSelectedContactId(peerId); setPanel('chat') }} onEnd={endCall} notify={notify} />
      })()}
      </Suspense>
      {user && activeVoice && (() => {
        const g = guildDetails[activeVoice.guildId]
        const channel = g?.channels.find((c) => c.id === activeVoice.channelId)
        const members = new Map((g?.members ?? []).map((m) => [m.userId, m]))
        const docked = panel === 'chat' && selectedGuildId === activeVoice.guildId && selectedChannel?.id === activeVoice.channelId
        return (
          <Suspense fallback={null}>
            <VoiceScreen key={`${activeVoice.channelId}:${activeVoice.token}`} join={activeVoice} channelName={channel?.name ?? 'Canal de voz'} guildName={g?.name ?? ''}
              me={{ id: user.id, username: user.username, avatar: user.avatar ? avatarSource(user.avatar) : '' }}
              person={(id) => { const m = members.get(id); return { id, username: m?.username ?? 'Membro', avatar: m?.avatar ? avatarSource(m.avatar) : '' } }}
              canSpeak={has(g?.channelPermissions[activeVoice.channelId] ?? 0, P.speak)} canVideo={has(g?.channelPermissions[activeVoice.channelId] ?? 0, P.video)}
              serverMuted={!!voiceByChannel[activeVoice.channelId]?.find((v) => v.userId === user.id)?.serverMuted}
              docked={docked} dockEl={voiceDockEl} miniEl={callMiniEl} onOpen={openVoiceView} onLeave={leaveVoice} onSpeaking={setSpeakingIds} onState={reportVoiceState} notify={notify} />
          </Suspense>
        )
      })()}
      {confirmDelete && (
        <div className="app-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget && !deleting) setConfirmDelete(null) }}>
          <div className="app-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-desc">
            <h2 id="delete-title">Apagar mensagem?</h2>
            <p id="delete-desc">{confirmDelete.channelId ? (confirmDelete.senderId === user?.id ? 'Ela será apagada para todos no canal.' : `Você está apagando uma mensagem de ${selectedGuild?.members.find((m) => m.userId === confirmDelete.senderId)?.username ?? 'outro membro'} para todos no canal.`) : `Ela será apagada para você e para ${contacts.find((c) => c.id === confirmDelete.recipientId)?.username ?? 'o contato'}.`}{confirmDelete.attachment ? ' O anexo também será removido.' : ''} Isso não pode ser desfeito.</p>
            {(confirmDelete.body || confirmDelete.attachment) && <blockquote>{confirmDelete.body || confirmDelete.attachment?.name}</blockquote>}
            <div className="form-actions">
              <button ref={deleteCancelRef} type="button" className="ghost-button" onClick={() => setConfirmDelete(null)} disabled={deleting}>Cancelar</button>
              <button type="button" className="danger-button" onClick={deleteMessage} disabled={deleting}>{deleting ? 'Apagando…' : 'Apagar para todos'}</button>
            </div>
          </div>
        </div>
      )}
      {lightbox?.attachment?.kind === 'image' && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label="Imagem em tela cheia" onClick={(e) => { if (e.target === e.currentTarget) setLightbox(null) }}>
          <header className="lightbox-bar">
            <span><strong>{lightbox.senderId === user?.id ? 'Você' : contacts.find((c) => c.id === lightbox.senderId)?.username ?? 'Contato'}</strong><small>{dayLabel(lightbox.createdAt)} às {timeFormat.format(new Date(lightbox.createdAt))}</small></span>
            <a className="lightbox-action" href={`${apiBase}${lightbox.attachment.url}?download=1`} title="Baixar imagem">Baixar</a>
            <button ref={lightboxCloseRef} type="button" className="lightbox-action" onClick={() => setLightbox(null)} aria-label="Fechar imagem" title="Fechar (Esc)">×</button>
          </header>
          <img src={`${apiBase}${lightbox.attachment.url}`} alt={lightbox.body || 'Imagem enviada'} onClick={(e) => e.stopPropagation()} />
          {lightbox.body && <p className="lightbox-caption">{lightbox.body}</p>}
        </div>
      )}
      {toast && <div className="toast toast-top toast-end app-toast"><div className={`alert ${toast.kind === 'error' ? 'alert-error' : 'alert-success'} app-toast-alert`} role={toast.kind === 'error' ? 'alert' : 'status'}><span>{toast.message}</span><button type="button" className="app-toast-close" aria-label="Fechar notificação" onClick={() => setToast(null)}>×</button></div></div>}
    </main>
  )
}

export default App
