import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent, type KeyboardEvent } from 'react'
import './App.css'

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
type Message = { id: number; senderId: string; recipientId: string; body: string; attachment: Attachment | null; createdAt: string; readAt: string | null }
type PendingAttachment = { contactId: string; file: File; kind: 'image' | 'file'; preview: string | null }
type Conversation = { contactId: string; lastMessage: Message; unread: number }
type Thread = { messages: Message[]; hasMore: boolean; loaded: boolean }
type RealtimeEvent = { type: 'message'; message: Message } | { type: 'read'; readerId: string; readAt: string } | { type: 'presence'; userId: string; status: User['status'] }

const apiBase = `http://localhost:${import.meta.env.VITE_PORT || '8081'}`
const realtimeUrl = `${apiBase.replace(/^http/, 'ws')}/api/ws`
const pageSize = 50
const maxMessageLength = 4000
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

function previewText(m: Message) {
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

function uploadAttachment(contactId: string, file: File, caption: string, onProgress: (fraction: number) => void) {
  return new Promise<Message>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${apiBase}/api/conversations/${contactId}/attachments`)
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
const avatarSource = (path: string) => path.startsWith('/api/avatars/') ? `${apiBase}${path}` : path

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    const result = await response.json().catch(() => ({}))
    throw new Error(result.error || `Erro HTTP ${response.status}`)
  }
  return response.status === 204 ? undefined as T : response.json()
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
  const selectedRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    userIdRef.current = user?.id ?? null
    selectedRef.current = panel === 'chat' ? selectedContactId : null
  })

  function notify(kind: Toast['kind'], message: string) {
    setToast({ kind, message })
  }

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

  const loadConversations = useCallback(() => {
    request<Conversation[]>('/api/conversations')
      .then((list) => setConversations(Object.fromEntries(list.map((c) => [c.contactId, c]))))
      .catch((err: Error) => notify('error', err.message))
  }, [])

  const loadThread = useCallback(async (contactId: string) => {
    try {
      const list = await request<Message[]>(`/api/conversations/${contactId}/messages?limit=${pageSize}`)
      setThreads((all) => {
        const previous = all[contactId]
        return { ...all, [contactId]: { messages: mergeMessages(previous?.messages ?? [], list), hasMore: previous?.loaded ? previous.hasMore : list.length === pageSize, loaded: true } }
      })
    } catch (err) { notify('error', (err as Error).message) }
  }, [])

  const receive = useCallback((message: Message) => {
    const me = userIdRef.current
    if (!me) return
    const contactId = message.senderId === me ? message.recipientId : message.senderId
    setThreads((all) => all[contactId] ? { ...all, [contactId]: { ...all[contactId], messages: mergeMessages(all[contactId].messages, [message]) } } : all)
    setConversations((all) => {
      const current = all[contactId]
      if (current && current.lastMessage.id >= message.id) return all
      const isNewIncoming = message.senderId === contactId && !message.readAt
      return { ...all, [contactId]: { contactId, lastMessage: message, unread: (current?.unread ?? 0) + (isNewIncoming ? 1 : 0) } }
    })
  }, [])

  useEffect(() => {
    if (!user?.id) return
    loadConversations()
    let socket: WebSocket | null = null
    let retry = 0
    let timer: number | undefined
    let stopped = false
    const connect = () => {
      socket = new WebSocket(realtimeUrl)
      socket.onopen = () => {
        setConnected(true)
        if (retry > 0) {
          loadConversations()
          request<Contact[]>('/api/contacts').then(setContacts).catch(() => {})
          if (selectedRef.current) void loadThread(selectedRef.current)
        }
        retry = 0
      }
      socket.onmessage = (event) => {
        let data: RealtimeEvent
        try { data = JSON.parse(event.data) } catch { return }
        if (data.type === 'message') receive(data.message)
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
  }, [user?.id, loadConversations, loadThread, receive])

  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useEffect(() => {
    if (!selectedContactId || panel !== 'chat') return
    stickToBottom.current = true
    if (!threads[selectedContactId]?.loaded) void loadThread(selectedContactId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedContactId, panel, loadThread])

  const openThread = selectedContactId && panel === 'chat' ? threads[selectedContactId] : undefined
  const hasUnreadOpen = !!selectedContactId && !!openThread?.messages.some((m) => m.senderId === selectedContactId && !m.readAt)

  useEffect(() => {
    if (!selectedContactId || !hasUnreadOpen || !visible) return
    const contactId = selectedContactId
    const now = new Date().toISOString()
    setThreads((all) => all[contactId] ? { ...all, [contactId]: { ...all[contactId], messages: all[contactId].messages.map((m) => m.senderId === contactId && !m.readAt ? { ...m, readAt: now } : m) } } : all)
    setConversations((all) => all[contactId] ? { ...all, [contactId]: { ...all[contactId], unread: 0 } } : all)
    request<void>(`/api/conversations/${contactId}/read`, { method: 'POST' }).catch(() => {})
  }, [selectedContactId, hasUnreadOpen, visible])

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
    if (!selectedContactId || !openThread?.messages.length) return
    const contactId = selectedContactId
    setLoadingOlder(true)
    try {
      const list = await request<Message[]>(`/api/conversations/${contactId}/messages?limit=${pageSize}&before=${openThread.messages[0].id}`)
      olderAnchor.current = canvasRef.current ? canvasRef.current.scrollHeight - canvasRef.current.scrollTop : null
      setThreads((all) => ({ ...all, [contactId]: { messages: mergeMessages(all[contactId]?.messages ?? [], list), hasMore: list.length === pageSize, loaded: true } }))
    } catch (err) { notify('error', (err as Error).message) }
    finally { setLoadingOlder(false) }
  }

  function attachFile(file?: File | null) {
    if (!file || !selectedContactId) return
    const isImage = imageTypes.includes(file.type)
    if (!isImage && !documentExtensions.includes(fileExtension(file.name))) {
      notify('error', 'Tipo de arquivo não permitido. Envie imagens, PDF, documentos do Office/LibreOffice, TXT, CSV, MD, ZIP, RAR ou 7z.'); return
    }
    if (isImage && file.size > maxImageBytes) { notify('error', 'A imagem deve ter até 10 MB.'); return }
    if (file.size > maxFileBytes) { notify('error', 'O arquivo deve ter até 25 MB.'); return }
    if (file.size === 0) { notify('error', 'O arquivo está vazio.'); return }
    setPending((current) => {
      if (current?.preview) URL.revokeObjectURL(current.preview)
      return { contactId: selectedContactId, file, kind: isImage ? 'image' : 'file', preview: isImage ? URL.createObjectURL(file) : null }
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
    if (!selectedContactId || panel !== 'chat') return
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
    if (!selectedContactId || panel !== 'chat') return
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

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault()
    if (!selectedContactId || sending) return
    const contactId = selectedContactId
    if (pending?.contactId === contactId) { await sendPending(contactId, pending); return }
    const body = (drafts[contactId] ?? '').trim()
    if (!body) return
    if (body.length > maxMessageLength) { notify('error', `A mensagem pode ter até ${maxMessageLength} caracteres.`); return }
    setSending(true)
    try {
      const message = await request<Message>(`/api/conversations/${contactId}/messages`, { method: 'POST', body: JSON.stringify({ body }) })
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
    } else if (event.key === 'Escape' && pending && !sending) {
      discardPending()
    }
  }

  function clearSession() {
    setUser(null); setUsers([]); setContacts([]); setSelectedContactId(null); setPanel('chat')
    setConversations({}); setThreads({}); setDrafts({}); discardPending(); setLightbox(null)
  }

  useLayoutEffect(() => {
    const field = composerRef.current
    if (!field) return
    field.style.height = 'auto'
    field.style.height = `${Math.min(field.scrollHeight, 140)}px`
  }, [drafts, selectedContactId])

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

  const selectedContact = contacts.find((contact) => contact.id === selectedContactId)
  const filteredContacts = contacts
    .filter((contact) => `${contact.username} ${contact.userTag}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    .sort((a, b) => (conversations[b.id]?.lastMessage.id ?? 0) - (conversations[a.id]?.lastMessage.id ?? 0))
  const draft = selectedContactId ? drafts[selectedContactId] ?? '' : ''

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
          <aside className={`chat-sidebar ${selectedContact && panel === 'chat' || panel !== 'chat' ? 'mobile-hidden' : ''}`} aria-label="Conversas">
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
                      <small className="contact-preview">{conversations[contact.id]?.lastMessage.senderId === user.id && <ReadTicks message={conversations[contact.id].lastMessage} />}{conversations[contact.id] ? <>{conversations[contact.id].lastMessage.senderId === user.id && 'Você: '}{conversations[contact.id].lastMessage.attachment && (conversations[contact.id].lastMessage.attachment!.kind === 'image' ? <PhotoIcon /> : <FileIcon />)}{previewText(conversations[contact.id].lastMessage)}</> : `@${contact.userTag}`}</small>
                      {conversations[contact.id]?.unread ? <span className="unread-badge" aria-label={`${conversations[contact.id].unread} não lidas`}>{conversations[contact.id].unread > 99 ? '99+' : conversations[contact.id].unread}</span> : <span className={`presence-dot ${contact.status}`} aria-label={contact.status} />}
                    </span>
                  </span>
                </button>
              )) : <p className="sidebar-empty">{search ? 'Nenhum contato encontrado.' : 'Ainda não há outros usuários ativos.'}</p>}
            </div>
            <div className="sidebar-footer">
              <button className="account-shortcut" type="button" onClick={() => setPanel('profile')}>
                <span className="small-avatar-wrap">{user.avatar ? <img className="small-avatar" src={avatarSource(user.avatar)} alt="" /> : <span className="small-avatar contact-placeholder">{user.username.slice(0, 1).toUpperCase()}</span>}<span className={`own-presence ${status}`} aria-label={`Seu status: ${status}`} /></span>
                <span><strong>{user.username}</strong><small>@{user.userTag}</small></span>
              </button>
              {user.role === 'master' && <button className="admin-shortcut" type="button" onClick={() => setPanel('admin')}>Admin</button>}
            </div>
          </aside>
          <section className={`chat-main ${selectedContact && panel === 'chat' || panel !== 'chat' ? 'mobile-open' : ''}`}
            onDragEnter={(e) => { if (!dragHasFiles(e) || !selectedContact || panel !== 'chat') return; e.preventDefault(); dragDepth.current += 1; setDropActive(true) }}
            onDragOver={(e) => { if (dragHasFiles(e) && selectedContact && panel === 'chat') { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } }}
            onDragLeave={(e) => { if (!dragHasFiles(e)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDropActive(false) }}
            onDrop={dropFile}>
            {panel === 'chat' ? (
              <>
                {selectedContact ? (
                  <>
                    <header className="conversation-header">
                      <button className="mobile-back" type="button" onClick={() => setSelectedContactId(null)} aria-label="Voltar aos contatos">‹</button>
                      {selectedContact.avatar ? <img className="header-avatar" src={avatarSource(selectedContact.avatar)} alt="" /> : <span className="header-avatar contact-placeholder">{selectedContact.username.slice(0, 1).toUpperCase()}</span>}
                      <div className="conversation-identity"><strong>{selectedContact.username}</strong><small>{connected ? <>@{selectedContact.userTag} · {selectedContact.status === 'online' ? 'online' : selectedContact.status === 'busy' ? 'ocupado' : selectedContact.status === 'away' ? 'ausente' : 'offline'}</> : 'Reconectando…'}</small></div>
                      <button className="icon-button header-action" type="button" onClick={() => notify('success', 'Busca de mensagens chega na próxima etapa.')} aria-label="Buscar mensagens" title="Buscar mensagens"><img src="/figma-chat/search-header.svg" alt="" /></button>
                      <button className="icon-button header-action" type="button" onClick={() => notify('success', 'Chamadas de voz chegam em uma próxima etapa.')} aria-label="Iniciar chamada" title="Chamada em breve"><img src="/figma-chat/call.svg" alt="" /></button>
                      <button className="icon-button header-action" type="button" onClick={() => setPanel('profile')} aria-label="Mais opções" title="Mais opções"><img src="/figma-chat/more.svg" alt="" /></button>
                    </header>
                    <div className="conversation-canvas" ref={canvasRef} onScroll={(e) => { const el = e.currentTarget; stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
                      {!openThread?.loaded ? <p className="thread-status">Carregando mensagens…</p> : !openThread.messages.length ? (
                        <div className="empty-conversation"><span className="empty-mark">✦</span><h1>Conversa com {selectedContact.username}</h1><p>Nenhuma mensagem ainda. Diga olá!</p></div>
                      ) : (
                        <ol className="message-list" aria-label={`Mensagens com ${selectedContact.username}`}>
                          {openThread.hasMore && <li className="load-older"><button type="button" disabled={loadingOlder} onClick={loadOlder}>{loadingOlder ? 'Carregando…' : 'Carregar mensagens anteriores'}</button></li>}
                          {openThread.messages.map((m, index) => {
                            const mine = m.senderId === user.id
                            const previous = openThread.messages[index - 1]
                            const newDay = !previous || new Date(previous.createdAt).toDateString() !== new Date(m.createdAt).toDateString()
                            return (
                              <li key={m.id} className="message-row-wrap">
                                {newDay && <div className="day-separator"><span>{dayLabel(m.createdAt)}</span></div>}
                                <div className={`message-row ${mine ? 'mine' : 'theirs'} ${previous && previous.senderId === m.senderId && !newDay ? 'grouped' : ''}`}>
                                  <div className={`bubble ${m.attachment?.kind === 'image' ? 'has-image' : ''} ${m.attachment?.kind === 'image' && !m.body ? 'image-only' : ''} ${m.attachment?.kind === 'file' ? 'has-file' : ''}`}>
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
                                    <span className="bubble-meta"><time dateTime={m.createdAt}>{timeFormat.format(new Date(m.createdAt))}</time>{mine && <ReadTicks message={m} />}</span>
                                  </div>
                                </div>
                              </li>
                            )
                          })}
                        </ol>
                      )}
                    </div>
                    <div className="composer-area">
                      {pending?.contactId === selectedContact.id && (
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
                      <form className="composer" onSubmit={sendMessage}>
                        <button type="button" className="attach-button" onClick={() => fileInputRef.current?.click()} disabled={sending} aria-label="Anexar arquivo do computador" title="Anexar imagem ou arquivo (ou cole com Ctrl+V / arraste)">
                          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5 12.4 20a5.5 5.5 0 0 1-7.8-7.8l8.9-8.9a3.7 3.7 0 0 1 5.2 5.2l-8.9 8.9a1.8 1.8 0 0 1-2.6-2.6l8.2-8.2" /></svg>
                        </button>
                        <input ref={fileInputRef} type="file" hidden accept={attachmentAccept} onChange={(e) => { attachFile(e.target.files?.[0]); e.target.value = '' }} />
                        <label className="sr-only" htmlFor="composer-input">Mensagem para {selectedContact.username}</label>
                        <textarea id="composer-input" ref={composerRef} rows={1} maxLength={maxMessageLength} placeholder={pending?.contactId === selectedContact.id ? 'Adicionar legenda' : 'Mensagem'} value={draft} onKeyDown={composerKeyDown} onChange={(e) => setDrafts((all) => ({ ...all, [selectedContact.id]: e.target.value }))} />
                        <button type="submit" disabled={sending || (!draft.trim() && pending?.contactId !== selectedContact.id)} aria-label="Enviar mensagem" title="Enviar (Enter)"><img src="/figma-chat/send.svg" alt="" /></button>
                      </form>
                    </div>
                    {dropActive && <div className="drop-overlay" aria-hidden="true"><div><strong>Solte o arquivo aqui</strong><span>Imagens até 10 MB · PDF, documentos e compactados até 25 MB</span></div></div>}
                  </>
                ) : (
                  <div className="welcome-view"><img src="/go-live-icon.png" alt="" /><h1>GO LIVE</h1><p>Selecione um contato para abrir a conversa.</p><span>Voz e compartilhamento de tela serão adicionados nas próximas etapas.</span></div>
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
        </>
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
