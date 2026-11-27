import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react'
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

const apiBase = `http://localhost:${import.meta.env.VITE_PORT || '8081'}`
const avatarSource = (path: string) => path.startsWith('/api/avatars/') ? `${apiBase}${path}` : path

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

  function clearSession() {
    setUser(null); setUsers([]); setContacts([]); setPanel('chat')
  }

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
      } else {
        setContacts((list) => [...list, { id: target.id, avatar: target.avatar, username: target.username, userTag: target.userTag, status: target.status }].sort((a, b) => a.username.localeCompare(b.username)))
      }
      notify('success', `@${target.userTag}: ${next === 'active' ? 'ativo' : 'bloqueado'}.`)
    } catch (err) { notify('error', (err as Error).message) }
  }

  const filteredContacts = contacts
    .filter((contact) => `${contact.username} ${contact.userTag}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))

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
          <aside className={`chat-sidebar ${panel !== 'chat' ? 'mobile-hidden' : ''}`} aria-label="Contatos">
            <div className="sidebar-search">
              <button className="icon-button" type="button" aria-label="Abrir perfil" title="Abrir perfil" onClick={() => setPanel(panel === 'profile' ? 'chat' : 'profile')}><img src="/figma-chat/menu.svg" alt="" /></button>
              <label className="search-box"><img src="/figma-chat/search.svg" alt="" /><span className="sr-only">Buscar contatos</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar" /></label>
            </div>
            <div className="sidebar-label"><span>Contatos</span><span>{contacts.length}</span></div>
            <div className="contact-list">
              {filteredContacts.length ? filteredContacts.map((contact) => (
                <div key={contact.id} className="contact-item">
                  {contact.avatar ? <img className="contact-avatar" src={avatarSource(contact.avatar)} alt="" /> : <span className="contact-avatar contact-placeholder">{contact.username.slice(0, 1).toUpperCase()}</span>}
                  <span className="contact-text">
                    <span className="contact-line"><strong>{contact.username}</strong></span>
                    <span className="contact-line">
                      <small>@{contact.userTag}</small>
                      <span className={`presence-dot ${contact.status}`} aria-label={contact.status} />
                    </span>
                  </span>
                </div>
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
          <section className={`chat-main ${panel !== 'chat' ? 'mobile-open' : ''}`}>
            {panel === 'chat' ? (
              <div className="welcome-view"><img src="/go-live-icon.png" alt="" /><h1>GO LIVE</h1><p>Sua conta está pronta.</p><span>O chat de texto, a voz e o compartilhamento de tela serão adicionados nas próximas etapas.</span></div>
            ) : (
              <div className="settings-view">
                <header className="settings-header">
                  <button className="icon-button settings-back" type="button" onClick={() => setPanel('chat')} aria-label="Voltar" title="Voltar">
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
      {toast && <div className="toast toast-top toast-end app-toast"><div className={`alert ${toast.kind === 'error' ? 'alert-error' : 'alert-success'} app-toast-alert`} role={toast.kind === 'error' ? 'alert' : 'status'}><span>{toast.message}</span><button type="button" className="app-toast-close" aria-label="Fechar notificação" onClick={() => setToast(null)}>×</button></div></div>}
    </main>
  )
}

export default App
