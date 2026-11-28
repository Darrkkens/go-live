import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { apiBase, avatarSource, request } from './api'
import { P, channelPermKeys, channelSlug, guildColor, guildInitials, has, memberColor, memberTop, permGroups, permInfo, roleColors, type Channel, type GuildDetail, type GuildSummary, type InvitePreview, type Member, type Notify, type PermKey, type Role, type VoiceMember } from './guildTypes'

function Icon({ path, size = 18 }: { path: string; size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg>
}

const paths = {
  plus: 'M12 5v14M5 12h14',
  hash: 'M5 9h14M5 15h14M10 3 8 21M16 3l-2 18',
  chevron: 'm6 9 6 6 6-6',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  invite: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM19 8v6M22 11h-6',
  userAdd: 'M15 19a6 6 0 0 0-12 0M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM18 8v6M21 11h-6',
  leave: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  crown: 'M3 18h18M4 8l4 4 4-7 4 7 4-4-2 10H6Z',
  shield: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6Z',
  close: 'M6 6l12 12M18 6 6 18',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z',
  link: 'M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  speaker: 'M11 5 6 9H2v6h4l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14',
  micOff: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18',
  deaf: 'M3 14v-2a9 9 0 0 1 18 0v2M21 14v3a2 2 0 0 1-2 2h-1v-6h3M3 14v3a2 2 0 0 0 2 2h1v-6H3M3 3l18 18',
  video: 'M3 7h12v10H3zM15 10l6-3v10l-6-3',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
}

const iconTypes = ['image/png', 'image/jpeg']

/** Uploads a server image (PNG or JPEG up to 4 MB). */
async function uploadGuildIcon(guildId: string, file: File) {
  const data = new FormData()
  data.append('icon', file)
  const res = await fetch(`${apiBase}/api/guilds/${guildId}/icon`, { method: 'POST', credentials: 'include', body: data })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || 'Não foi possível enviar a imagem.')
  return body.icon as string
}

function checkIcon(file: File | undefined, notify: Notify) {
  if (!file) return false
  if (!iconTypes.includes(file.type) || file.size > 4 * 1024 * 1024) { notify('error', 'Escolha uma imagem PNG ou JPEG de até 4 MB.'); return false }
  return true
}

/** Clickable (and droppable) server image with a camera badge, used to pick an icon. */
function IconPicker({ guild, preview, onPick, busy }: { guild: { id: string; name: string; icon: string }; preview: string | null; onPick: (file: File) => void; busy?: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  return (
    <div className="dialog-icon-preview">
      <button type="button" className={`icon-picker ${over ? 'over' : ''}`} onClick={() => input.current?.click()} disabled={busy}
        onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) onPick(f) }}
        aria-label="Escolher imagem do servidor" title="Clique ou arraste uma imagem (PNG ou JPEG até 4 MB)">
        {preview ? <img className="guild-icon" style={{ width: 80, height: 80 }} src={preview} alt="" /> : <GuildIcon guild={guild} size={80} />}
        <span className="icon-picker-badge" aria-hidden="true"><Icon path="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1ZM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" size={14} /></span>
      </button>
      <input ref={input} type="file" hidden accept=".png,.jpg,.jpeg,image/png,image/jpeg" onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = '' }} />
      <small className="icon-picker-hint">{busy ? 'Enviando…' : 'Clique ou arraste uma imagem'}</small>
    </div>
  )
}

export function GuildIcon({ guild, size = 48 }: { guild: { id: string; name: string; icon: string }; size?: number }) {
  return guild.icon
    ? <img className="guild-icon" style={{ width: size, height: size }} src={avatarSource(guild.icon)} alt="" />
    : <span className="guild-icon" style={{ width: size, height: size, background: guildColor(guild.id), fontSize: size * 0.36 }} aria-hidden="true">{guildInitials(guild.name)}</span>
}

/** The vertical server list, like Discord's left rail. */
export function ServerRail({ guilds, selectedId, hasUnread, dmUnread, onSelect, onAdd }: {
  guilds: GuildSummary[]
  selectedId: string | null
  hasUnread: (id: string) => boolean
  dmUnread: number
  onSelect: (id: string | null) => void
  onAdd: () => void
}) {
  return (
    <nav className="server-rail" aria-label="Servidores">
      <div className={`rail-item ${selectedId === null ? 'selected' : ''} ${dmUnread && selectedId !== null ? 'unread' : ''}`}>
        <span className="rail-pill" />
        <button type="button" className="rail-button dm" onClick={() => onSelect(null)} aria-label="Mensagens diretas" aria-current={selectedId === null} title="Mensagens diretas">
          <img src="/go-live-icon.png" alt="" />
        </button>
        {dmUnread > 0 && selectedId !== null && <span className="rail-badge">{dmUnread > 99 ? '99+' : dmUnread}</span>}
      </div>
      <span className="rail-separator" />
      <div className="rail-guilds">
        {guilds.map((g) => (
          <div key={g.id} className={`rail-item ${selectedId === g.id ? 'selected' : ''} ${hasUnread(g.id) ? 'unread' : ''}`}>
            <span className="rail-pill" />
            <button type="button" className="rail-button" onClick={() => onSelect(g.id)} aria-label={`${g.name}${hasUnread(g.id) ? ' (mensagens novas)' : ''}`} aria-current={selectedId === g.id} title={g.name}>
              <GuildIcon guild={g} />
            </button>
          </div>
        ))}
      </div>
      <div className="rail-item">
        <span className="rail-pill" />
        <button type="button" className="rail-button add" onClick={onAdd} aria-label="Criar ou entrar em um servidor" title="Criar ou entrar em um servidor"><Icon path={paths.plus} size={24} /></button>
      </div>
    </nav>
  )
}

export type GuildAction = 'invite' | 'add-members' | 'create-channel' | 'create-voice' | 'settings' | 'leave'

export type VoiceAction = { kind: 'move'; to: string } | { kind: 'mute'; muted: boolean } | { kind: 'disconnect' }

/** Channel list with the server menu, shown instead of the contact list. */
export function GuildSidebar({ guild, me, selectedChannelId, unread, voice, connectedVoiceId, speaking, onSelectChannel, onAction, onEditChannel, onVoiceAction }: {
  guild: GuildDetail
  me: string
  selectedChannelId: string | null
  unread: Record<string, number>
  /** Who is in each voice channel. */
  voice: Record<string, VoiceMember[]>
  connectedVoiceId: string | null
  /** Users speaking in the voice channel you are connected to. */
  speaking: string[]
  onSelectChannel: (id: string) => void
  onAction: (action: GuildAction) => void
  onEditChannel: (channel: Channel) => void
  onVoiceAction: (userId: string, action: VoiceAction) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [voiceMenu, setVoiceMenu] = useState<{ userId: string; channelId: string } | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const perms = guild.permissions
  const canChannels = has(perms, P.manageChannels)
  const canInvite = has(perms, P.createInvite)
  const canAdd = has(perms, P.addMembers)
  const canSettings = guild.role === 'owner' || has(perms, P.manageGuild) || has(perms, P.manageRoles)
  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', close); window.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('keydown', key) }
  }, [menuOpen])
  useEffect(() => {
    if (!voiceMenu) return
    const close = (e: MouseEvent) => { if (!(e.target as Element).closest?.('.voice-menu, .voice-person')) setVoiceMenu(null) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setVoiceMenu(null) }
    document.addEventListener('mousedown', close); window.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('keydown', key) }
  }, [voiceMenu])
  const pick = (action: GuildAction) => { setMenuOpen(false); onAction(action) }
  const textChannels = guild.channels.filter((c) => c.kind === 'text')
  const voiceChannels = guild.channels.filter((c) => c.kind === 'voice')
  const memberById = new Map(guild.members.map((m) => [m.userId, m]))
  const chanPerms = (id: string) => guild.channelPermissions[id] ?? 0
  // Moderation applies to people below you (or yourself, for moving).
  const outranks = (userId: string) => {
    const m = memberById.get(userId)
    return guild.role === 'owner' || (!!m && m.userId !== guild.ownerId && memberTop(guild, m) < guild.myTop)
  }
  const canMoveFrom = (channelId: string, userId: string) => has(chanPerms(channelId), P.moveMembers) && (userId === me || outranks(userId))
  const anyManage = canChannels || canInvite || canAdd || canSettings

  function dropOn(channelId: string, e: React.DragEvent) {
    e.preventDefault(); setDragOver(null)
    const data = e.dataTransfer.getData('application/x-golive-voice')
    if (!data) return
    const { userId, from } = JSON.parse(data) as { userId: string; from: string }
    if (from !== channelId) onVoiceAction(userId, { kind: 'move', to: channelId })
  }

  return (
    <div className="guild-sidebar">
      <div className="guild-header-wrap" ref={menuRef}>
        <button type="button" className={`guild-header ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen((v) => !v)} aria-haspopup="menu" aria-expanded={menuOpen}>
          <span>{guild.name}</span>
          <Icon path={menuOpen ? paths.close : paths.chevron} size={16} />
        </button>
        {menuOpen && (
          <div className="guild-menu" role="menu">
            {canInvite && <button type="button" role="menuitem" className="accent" onClick={() => pick('invite')}><span>Convidar pessoas</span><Icon path={paths.invite} /></button>}
            {canAdd && <button type="button" role="menuitem" onClick={() => pick('add-members')}><span>Adicionar membros</span><Icon path={paths.userAdd} /></button>}
            {canChannels && <button type="button" role="menuitem" onClick={() => pick('create-channel')}><span>Criar canal de texto</span><Icon path={paths.hash} /></button>}
            {canChannels && <button type="button" role="menuitem" onClick={() => pick('create-voice')}><span>Criar canal de voz</span><Icon path={paths.speaker} /></button>}
            {canSettings && <button type="button" role="menuitem" onClick={() => pick('settings')}><span>Configurações do servidor</span><Icon path={paths.gear} /></button>}
            {guild.role !== 'owner' && <button type="button" role="menuitem" className="danger" onClick={() => pick('leave')}><span>Sair do servidor</span><Icon path={paths.leave} /></button>}
            {!anyManage && <span className="guild-menu-note">Seus cargos não permitem gerenciar este servidor.</span>}
          </div>
        )}
      </div>
      <div className="channel-list">
        <div className="channel-group">
          <span>Canais de texto</span>
          {canChannels && <button type="button" onClick={() => onAction('create-channel')} aria-label="Criar canal" title="Criar canal"><Icon path={paths.plus} size={16} /></button>}
        </div>
        {textChannels.map((c) => {
          const count = unread[c.id] ?? 0
          const selected = c.id === selectedChannelId
          const locked = guild.overrides[c.id]?.some((o) => has(o.deny, P.viewChannel))
          return (
            <div key={c.id} className={`channel-item ${selected ? 'selected' : ''} ${count && !selected ? 'unread' : ''}`}>
              <button type="button" className="channel-link" onClick={() => onSelectChannel(c.id)} aria-current={selected} title={c.topic || undefined}>
                <Icon path={paths.hash} size={18} />
                <span className="channel-name">{c.name}</span>
                {locked && <span className="channel-lock" title="Canal privado" aria-label="privado"><Icon path={paths.lock} size={12} /></span>}
                {count > 0 && !selected && <span className="channel-badge" aria-label={`${count} não lidas`}>{count > 99 ? '99+' : count}</span>}
              </button>
              {has(chanPerms(c.id), P.manageChannels) && <button type="button" className="channel-gear" onClick={() => onEditChannel(c)} aria-label={`Editar canal ${c.name}`} title="Editar canal"><Icon path={paths.gear} size={15} /></button>}
            </div>
          )
        })}
        <div className="channel-group voice-group">
          <span>Canais de voz</span>
          {canChannels && <button type="button" onClick={() => onAction('create-voice')} aria-label="Criar canal de voz" title="Criar canal de voz"><Icon path={paths.plus} size={16} /></button>}
        </div>
        {voiceChannels.map((c) => {
          const people = voice[c.id] ?? []
          const selected = c.id === selectedChannelId
          const connected = c.id === connectedVoiceId
          const cp = chanPerms(c.id)
          const full = c.userLimit > 0 && people.length >= c.userLimit
          const locked = guild.overrides[c.id]?.some((o) => has(o.deny, P.viewChannel))
          const noConnect = !has(cp, P.connect)
          return (
            <div key={c.id} className={`voice-channel ${dragOver === c.id ? 'drop-target' : ''}`}
              onDragOver={(e) => { if (e.dataTransfer.types.includes('application/x-golive-voice') && has(cp, P.moveMembers)) { e.preventDefault(); setDragOver(c.id) } }}
              onDragLeave={() => setDragOver((v) => v === c.id ? null : v)} onDrop={(e) => dropOn(c.id, e)}>
              <div className={`channel-item voice ${selected ? 'selected' : ''} ${connected ? 'connected' : ''} ${noConnect ? 'no-connect' : ''}`}>
                <button type="button" className="channel-link" onClick={() => onSelectChannel(c.id)} aria-current={selected}
                  title={noConnect ? 'Você não pode entrar neste canal' : connected ? `Você está em ${c.name}` : full ? `${c.name} está cheio` : `Entrar em ${c.name}`}>
                  <Icon path={noConnect ? paths.lock : paths.speaker} size={18} />
                  <span className="channel-name">{c.name}</span>
                  {locked && !noConnect && <span className="channel-lock" title="Canal privado" aria-label="privado"><Icon path={paths.lock} size={12} /></span>}
                  {c.userLimit > 0
                    ? <span className={`voice-count ${full ? 'full' : ''}`} aria-label={`${people.length} de ${c.userLimit}`}>{String(people.length).padStart(2, '0')}/{String(c.userLimit).padStart(2, '0')}</span>
                    : people.length > 0 && <span className="voice-count" aria-label={`${people.length} conectados`}>{people.length}</span>}
                </button>
                {has(cp, P.manageChannels) && <button type="button" className="channel-gear" onClick={() => onEditChannel(c)} aria-label={`Editar canal ${c.name}`} title="Editar canal"><Icon path={paths.gear} size={15} /></button>}
              </div>
              {people.length > 0 && (
                <ul className="voice-people" aria-label={`Em ${c.name}`}>
                  {people.map((p) => {
                    const m = memberById.get(p.userId)
                    const name = m?.username ?? 'Membro'
                    const color = m ? memberColor(guild, m) : ''
                    const canMove = canMoveFrom(c.id, p.userId)
                    const canMute = has(cp, P.muteMembers) && outranks(p.userId)
                    const canDisconnect = has(cp, P.moveMembers) && (p.userId === me || outranks(p.userId))
                    const hasMenu = canMove || canMute || canDisconnect
                    const open = voiceMenu?.userId === p.userId
                    const targets = voiceChannels.filter((t) => t.id !== c.id && has(chanPerms(t.id), P.moveMembers | P.connect))
                    return (
                      <li key={p.userId} className={`voice-person ${connected && speaking.includes(p.userId) ? 'speaking' : ''} ${hasMenu ? 'has-menu' : ''}`}
                        draggable={canMove && targets.length > 0}
                        onDragStart={(e) => { e.dataTransfer.setData('application/x-golive-voice', JSON.stringify({ userId: p.userId, from: c.id })); e.dataTransfer.effectAllowed = 'move' }}
                        onClick={() => hasMenu && setVoiceMenu(open ? null : { userId: p.userId, channelId: c.id })}
                        onContextMenu={(e) => { if (!hasMenu) return; e.preventDefault(); setVoiceMenu({ userId: p.userId, channelId: c.id }) }}
                        title={canMove && targets.length ? 'Arraste para outro canal de voz para mover' : undefined}>
                        {m?.avatar ? <img className="voice-avatar" src={avatarSource(m.avatar)} alt="" /> : <span className="voice-avatar contact-placeholder">{name.slice(0, 1).toUpperCase()}</span>}
                        <span className="voice-name" style={color ? { color } : undefined}>{name}</span>
                        {p.screen && <span className="voice-live">AO VIVO</span>}
                        {p.video && <span className="voice-flag" title="Câmera ligada"><Icon path={paths.video} size={14} /></span>}
                        {p.serverMuted ? <span className="voice-flag server-muted" title="Silenciado pelo servidor"><Icon path={paths.micOff} size={14} /></span>
                          : p.deafened ? <span className="voice-flag muted" title="Sem som"><Icon path={paths.deaf} size={14} /></span>
                          : p.muted && <span className="voice-flag muted" title="Microfone desligado"><Icon path={paths.micOff} size={14} /></span>}
                        {open && (
                          <div className="voice-menu member-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                            <div className="member-menu-head"><strong>{name}</strong><small>em {c.name}</small></div>
                            {canMove && targets.length > 0 && <>
                              <span className="voice-menu-label">Mover para</span>
                              {targets.map((t) => <button key={t.id} type="button" role="menuitem" onClick={() => { setVoiceMenu(null); onVoiceAction(p.userId, { kind: 'move', to: t.id }) }}><Icon path={paths.speaker} size={16} />{t.name}</button>)}
                            </>}
                            {canMute && <button type="button" role="menuitem" onClick={() => { setVoiceMenu(null); onVoiceAction(p.userId, { kind: 'mute', muted: !p.serverMuted }) }}><Icon path={paths.micOff} size={16} />{p.serverMuted ? 'Remover silêncio do servidor' : 'Silenciar no servidor'}</button>}
                            {canDisconnect && <button type="button" role="menuitem" className="danger" onClick={() => { setVoiceMenu(null); onVoiceAction(p.userId, { kind: 'disconnect' }) }}><Icon path={paths.leave} size={16} />{p.userId === me ? 'Desconectar' : 'Desconectar da voz'}</button>}
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}
        {voiceChannels.length === 0 && <p className="channel-voice-soon">{canChannels ? 'Crie um canal de voz para conversar ao vivo.' : 'Nenhum canal de voz ainda.'}</p>}
      </div>
    </div>
  )
}

export type MemberAction = 'message' | 'roles' | 'kick'

/** Members grouped by presence, like Discord's right column; names use the top role color. */
export function MemberList({ guild, me, statusOf, onAction }: {
  guild: GuildDetail
  me: string
  statusOf: (member: Member) => Member['status']
  onAction: (member: Member, action: MemberAction) => void
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  useEffect(() => {
    if (!openId) return
    const close = (e: MouseEvent) => { if (!(e.target as Element).closest?.('.member-menu, .member-item')) setOpenId(null) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenId(null) }
    document.addEventListener('mousedown', close); window.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('keydown', key) }
  }, [openId])
  const online = guild.members.filter((m) => statusOf(m) !== 'offline')
  const offline = guild.members.filter((m) => statusOf(m) === 'offline')
  const isOwner = guild.role === 'owner'
  const rolesById = new Map(guild.roles.map((r) => [r.id, r]))

  const row = (m: Member) => {
    const status = statusOf(m)
    const below = isOwner || (m.userId !== guild.ownerId && memberTop(guild, m) < guild.myTop)
    const canKick = m.userId !== me && has(guild.permissions, P.kickMembers) && below
    const canRoles = has(guild.permissions, P.manageRoles) && (m.userId === me || below) && m.userId !== guild.ownerId
    const color = memberColor(guild, m)
    const roles = m.roleIds.map((id) => rolesById.get(id)).filter((r): r is Role => !!r).sort((a, b) => b.position - a.position)
    return (
      <li key={m.userId} className="member-row">
        <button type="button" className={`member-item ${status === 'offline' ? 'is-offline' : ''}`} onClick={() => setOpenId(openId === m.userId ? null : m.userId)} aria-haspopup="menu" aria-expanded={openId === m.userId}>
          <span className="member-avatar-wrap">
            {m.avatar ? <img className="member-avatar" src={avatarSource(m.avatar)} alt="" /> : <span className="member-avatar contact-placeholder">{m.username.slice(0, 1).toUpperCase()}</span>}
            <span className={`member-presence ${status}`} aria-label={status} />
          </span>
          <span className="member-name" style={color ? { color } : undefined}>{m.username}{m.userId === me && <small> (você)</small>}</span>
          {m.userId === guild.ownerId && <span className="member-role owner" title="Dono do servidor" aria-label="Dono do servidor"><Icon path={paths.crown} size={14} /></span>}
        </button>
        {openId === m.userId && (
          <div className="member-menu" role="menu">
            <div className="member-menu-head">
              <strong style={color ? { color } : undefined}>{m.username}</strong><small>@{m.userTag}{m.userId === guild.ownerId ? ' · Dono' : ''}</small>
              {roles.length > 0 && <span className="role-chips">{roles.map((r) => <span key={r.id} className="role-chip-small"><span className="role-dot" style={{ background: r.color || '#99a3b1' }} />{r.name}</span>)}</span>}
            </div>
            {m.userId !== me && <button type="button" role="menuitem" onClick={() => { setOpenId(null); onAction(m, 'message') }}><Icon path={paths.chat} size={16} />Mensagem direta</button>}
            {canRoles && <button type="button" role="menuitem" onClick={() => { setOpenId(null); onAction(m, 'roles') }}><Icon path={paths.shield} size={16} />Gerenciar cargos</button>}
            {canKick && <button type="button" role="menuitem" className="danger" onClick={() => { setOpenId(null); onAction(m, 'kick') }}><Icon path={paths.leave} size={16} />Remover do servidor</button>}
          </div>
        )}
      </li>
    )
  }

  return (
    <aside className="member-list" aria-label="Membros do servidor">
      {online.length > 0 && <h3>Online — {online.length}</h3>}
      <ul>{online.map(row)}</ul>
      {offline.length > 0 && <h3>Offline — {offline.length}</h3>}
      <ul>{offline.map(row)}</ul>
    </aside>
  )
}

function Dialog({ title, subtitle, onClose, children, wide }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, button:not(.dialog-close)')?.focus()
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return (
    <div className="app-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={ref} className={`app-modal guild-dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <button type="button" className="dialog-close" onClick={onClose} aria-label="Fechar"><Icon path={paths.close} /></button>
        <h2>{title}</h2>
        {subtitle && <p className="dialog-subtitle">{subtitle}</p>}
        {children}
      </div>
    </div>
  )
}

/** Create a server or join one with an invite link, like Discord's "+" button. */
export function AddServerDialog({ onClose, onCreated, onJoinCode, notify }: { onClose: () => void; onCreated: (id: string) => void; onJoinCode: (code: string) => void; notify: Notify }) {
  const [tab, setTab] = useState<'create' | 'join'>('create')
  const [name, setName] = useState('')
  const [iconFile, setIconFile] = useState<File | null>(null)
  const iconPreview = useMemo(() => iconFile ? URL.createObjectURL(iconFile) : null, [iconFile])
  useEffect(() => () => { if (iconPreview) URL.revokeObjectURL(iconPreview) }, [iconPreview])
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  async function create(e: FormEvent) {
    e.preventDefault(); setBusy(true)
    try {
      const g = await request<{ id: string }>('/api/guilds', { method: 'POST', body: JSON.stringify({ name }) })
      if (iconFile) await uploadGuildIcon(g.id, iconFile).catch((err: Error) => notify('error', `Servidor criado, mas a imagem falhou: ${err.message}`))
      onCreated(g.id)
    } catch (err) { notify('error', (err as Error).message) } finally { setBusy(false) }
  }
  function join(e: FormEvent) {
    e.preventDefault()
    const code = link.trim().split('/').filter(Boolean).pop() ?? ''
    if (!/^[A-Za-z0-9]{6,16}$/.test(code)) { notify('error', 'Cole um link de convite como http://…/convite/AbC123xyZ ou só o código.'); return }
    onJoinCode(code)
  }
  return (
    <Dialog title={tab === 'create' ? 'Criar um servidor' : 'Entrar em um servidor'} subtitle={tab === 'create' ? 'Seu servidor é onde você e seus amigos conversam em canais.' : 'Cole o link de convite que você recebeu.'} onClose={onClose}>
      <div className="dialog-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'create'} className={tab === 'create' ? 'active' : ''} onClick={() => setTab('create')}>Criar</button>
        <button type="button" role="tab" aria-selected={tab === 'join'} className={tab === 'join' ? 'active' : ''} onClick={() => setTab('join')}>Entrar com convite</button>
      </div>
      {tab === 'create' ? (
        <form className="dialog-form" onSubmit={create}>
          <IconPicker guild={{ id: name || 'novo', name: name || 'Novo servidor', icon: '' }} preview={iconPreview} onPick={(f) => { if (checkIcon(f, notify)) setIconFile(f) }} />
          <label>Nome do servidor<input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} minLength={2} required placeholder="Ex.: Time Go Live" /></label>
          <div className="form-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancelar</button><button type="submit" className="primary-button" disabled={busy || name.trim().length < 2}>{busy ? 'Criando…' : 'Criar servidor'}</button></div>
        </form>
      ) : (
        <form className="dialog-form" onSubmit={join}>
          <label>Link ou código do convite<input value={link} onChange={(e) => setLink(e.target.value)} required placeholder="http://localhost:5173/convite/AbC123xyZ" /></label>
          <div className="form-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancelar</button><button type="submit" className="primary-button" disabled={!link.trim()}>Continuar</button></div>
        </form>
      )}
    </Dialog>
  )
}

/** Shows where an invite leads before joining. */
export function InvitePreviewDialog({ code, onClose, onJoined, notify }: { code: string; onClose: () => void; onJoined: (guildId: string) => void; notify: Notify }) {
  const [preview, setPreview] = useState<InvitePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    request<InvitePreview>(`/api/invites/${encodeURIComponent(code)}`).then(setPreview).catch((err: Error) => setError(err.message))
  }, [code])
  async function accept() {
    setBusy(true)
    try {
      const res = await request<{ guildId: string }>(`/api/invites/${encodeURIComponent(code)}/accept`, { method: 'POST' })
      onJoined(res.guildId)
    } catch (err) { notify('error', (err as Error).message) } finally { setBusy(false) }
  }
  return (
    <Dialog title={error ? 'Convite inválido' : 'Você foi convidado'} onClose={onClose}>
      {error ? <p className="dialog-subtitle">{error}</p> : !preview ? <p className="dialog-subtitle">Carregando convite…</p> : (
        <div className="invite-preview">
          <GuildIcon guild={{ id: preview.guildId, name: preview.guildName, icon: preview.guildIcon }} size={72} />
          <strong>{preview.guildName}</strong>
          <span>{preview.memberCount} {preview.memberCount === 1 ? 'membro' : 'membros'}</span>
          <button type="button" className="primary-button wide" onClick={preview.member ? () => onJoined(preview.guildId) : accept} disabled={busy}>{preview.member ? 'Você já participa · Abrir servidor' : busy ? 'Entrando…' : 'Aceitar convite'}</button>
        </div>
      )}
    </Dialog>
  )
}

export function InviteDialog({ guild, onClose, notify }: { guild: GuildDetail; onClose: () => void; notify: Notify }) {
  const [hours, setHours] = useState(168)
  const [maxUses, setMaxUses] = useState(0)
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  async function generate() {
    setBusy(true); setCopied(false)
    try {
      const res = await request<{ url: string }>(`/api/guilds/${guild.id}/invites`, { method: 'POST', body: JSON.stringify({ expiresInHours: hours, maxUses }) })
      setUrl(res.url)
    } catch (err) { notify('error', (err as Error).message) } finally { setBusy(false) }
  }
  // A first link right away, like Discord.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void generate() }, [])
  async function copy() {
    if (!url) return
    try { await navigator.clipboard.writeText(url); setCopied(true) } catch { notify('error', 'Não foi possível copiar. Selecione o link e copie manualmente.') }
  }
  return (
    <Dialog title={`Convidar para ${guild.name}`} subtitle="Envie este link para quem já tem conta no Go Live." onClose={onClose}>
      <div className="invite-link">
        <Icon path={paths.link} />
        <input readOnly value={url ?? 'Gerando…'} onFocus={(e) => e.currentTarget.select()} aria-label="Link de convite" />
        <button type="button" className={`primary-button ${copied ? 'copied' : ''}`} onClick={copy} disabled={!url}>{copied ? 'Copiado!' : 'Copiar'}</button>
      </div>
      <div className="invite-options">
        <label>Expira em<select value={hours} onChange={(e) => setHours(Number(e.target.value))}><option value={1}>1 hora</option><option value={24}>1 dia</option><option value={168}>7 dias</option><option value={720}>30 dias</option><option value={0}>Nunca</option></select></label>
        <label>Número de usos<select value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}><option value={0}>Sem limite</option><option value={1}>1 uso</option><option value={5}>5 usos</option><option value={10}>10 usos</option><option value={25}>25 usos</option></select></label>
        <button type="button" className="ghost-button" onClick={generate} disabled={busy}>{busy ? 'Gerando…' : 'Gerar novo link'}</button>
      </div>
    </Dialog>
  )
}

export function AddMembersDialog({ guild, contacts, onClose, notify }: { guild: GuildDetail; contacts: { id: string; username: string; userTag: string; avatar: string }[]; onClose: () => void; notify: Notify }) {
  const [search, setSearch] = useState('')
  const [added, setAdded] = useState<Set<string>>(new Set())
  const [busyId, setBusyId] = useState<string | null>(null)
  const members = useMemo(() => new Set(guild.members.map((m) => m.userId)), [guild.members])
  // People added in this dialog stay listed as "Adicionado" even after the member list updates.
  const list = contacts.filter((c) => (!members.has(c.id) || added.has(c.id)) && `${c.username} ${c.userTag}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  async function add(id: string) {
    setBusyId(id)
    try {
      await request<void>(`/api/guilds/${guild.id}/members`, { method: 'POST', body: JSON.stringify({ userId: id }) })
      setAdded((s) => new Set(s).add(id))
    } catch (err) { notify('error', (err as Error).message) } finally { setBusyId(null) }
  }
  return (
    <Dialog title={`Adicionar membros a ${guild.name}`} subtitle="Eles entram na hora, sem precisar de convite." onClose={onClose}>
      <label className="dialog-search"><span className="sr-only">Buscar usuários</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nome ou @tag" /></label>
      <ul className="pick-list">
        {list.length ? list.map((c) => (
          <li key={c.id}>
            {c.avatar ? <img className="member-avatar" src={avatarSource(c.avatar)} alt="" /> : <span className="member-avatar contact-placeholder">{c.username.slice(0, 1).toUpperCase()}</span>}
            <span><strong>{c.username}</strong><small>@{c.userTag}</small></span>
            <button type="button" className={added.has(c.id) ? 'ghost-button' : 'primary-button'} onClick={() => add(c.id)} disabled={added.has(c.id) || busyId === c.id}>{added.has(c.id) ? 'Adicionado' : busyId === c.id ? '…' : 'Adicionar'}</button>
          </li>
        )) : <li className="pick-empty">{search ? 'Ninguém encontrado.' : 'Todos os usuários já estão no servidor.'}</li>}
      </ul>
      <div className="form-actions"><button type="button" className="primary-button" onClick={onClose}>Concluir</button></div>
    </Dialog>
  )
}

export function ChannelDialog({ guild, channel, initialKind = 'text', onClose, onSaved, notify }: { guild: GuildDetail; channel: Channel | null; initialKind?: 'text' | 'voice'; onClose: () => void; onSaved: (channel: Channel | null) => void; notify: Notify }) {
  const [kind, setKind] = useState<'text' | 'voice'>(channel?.kind ?? initialKind)
  const [name, setName] = useState(channel?.name ?? '')
  const [topic, setTopic] = useState(channel?.topic ?? '')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const slug = channelSlug(name)
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true)
    try {
      const saved = channel
        ? await request<Channel>(`/api/channels/${channel.id}`, { method: 'PATCH', body: JSON.stringify({ name, topic }) })
        : await request<Channel>(`/api/guilds/${guild.id}/channels`, { method: 'POST', body: JSON.stringify({ name, topic, kind }) })
      onSaved(saved)
    } catch (err) { notify('error', (err as Error).message) } finally { setBusy(false) }
  }
  async function remove() {
    if (!channel) return
    setBusy(true)
    try { await request<void>(`/api/channels/${channel.id}`, { method: 'DELETE' }); onSaved(null) }
    catch (err) { notify('error', (err as Error).message); setConfirming(false) } finally { setBusy(false) }
  }
  return (
    <Dialog title={channel ? `Editar ${channel.kind === 'voice' ? '' : '#'}${channel.name}` : 'Criar canal'} onClose={onClose}>
      <form className="dialog-form" onSubmit={save}>
        {!channel && (
          <div className="kind-options" role="radiogroup" aria-label="Tipo de canal">
            {([['text', 'Texto', 'Mensagens, imagens e arquivos', paths.hash], ['voice', 'Voz', 'Conversar por voz, vídeo e tela', paths.speaker]] as const).map(([value, label, hint, icon]) => (
              <button key={value} type="button" role="radio" aria-checked={kind === value} className={`kind-option ${kind === value ? 'active' : ''}`} onClick={() => setKind(value)}>
                <Icon path={icon} size={22} /><span><strong>{label}</strong><small>{hint}</small></span><span className="kind-radio" aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
        <label>Nome do canal
          <span className="channel-input"><Icon path={kind === 'voice' ? paths.speaker : paths.hash} size={16} /><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required placeholder="novo-canal" /></span>
          {name && slug !== name && <small className="field-hint">Vai ficar {kind === 'voice' ? '' : '#'}{slug || '…'}</small>}
        </label>
        {kind === 'text' && <label>Tópico (opcional)<input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={200} placeholder="Sobre o que é este canal?" /></label>}
        {channel && (confirming ? (
          <div className="danger-zone">
            <span>{channel.kind === 'voice' ? `Excluir ${channel.name}? Quem estiver conectado será desconectado.` : `Excluir #${channel.name} e todas as mensagens dele? Isso não pode ser desfeito.`}</span>
            <div><button type="button" className="ghost-button" onClick={() => setConfirming(false)} disabled={busy}>Cancelar</button><button type="button" className="danger-button" onClick={remove} disabled={busy}>Excluir canal</button></div>
          </div>
        ) : <button type="button" className="link-danger" onClick={() => setConfirming(true)}><Icon path={paths.trash} size={15} />Excluir canal</button>)}
        <div className="form-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancelar</button><button type="submit" className="primary-button" disabled={busy || !slug}>{busy ? 'Salvando…' : channel ? 'Salvar' : 'Criar canal'}</button></div>
      </form>
    </Dialog>
  )
}

export function ConfirmDialog({ title, text, action, onConfirm, onClose }: { title: string; text: string; action: string; onConfirm: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <Dialog title={title} onClose={onClose}>
      <p className="dialog-subtitle">{text}</p>
      <div className="form-actions"><button type="button" className="ghost-button" onClick={onClose} disabled={busy}>Cancelar</button><button type="button" className="danger-button" disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm() } finally { setBusy(false) } }}>{action}</button></div>
    </Dialog>
  )
}


/** A switch-style toggle for one permission. */
function PermToggle({ label, hint, checked, disabled, why, onChange }: { label: string; hint: string; checked: boolean; disabled?: boolean; why?: string; onChange: (v: boolean) => void }) {
  return (
    <label className={`perm-row ${disabled ? 'is-disabled' : ''}`} title={disabled ? why : undefined}>
      <span className="perm-text"><strong>{label}</strong><small>{disabled && why ? why : hint}</small></span>
      <input type="checkbox" role="switch" className="perm-switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

type SettingsTab = 'overview' | 'roles' | 'members'

/** Server settings with tabs, like Discord: overview, roles and members. */
export function ServerSettingsDialog({ guild, me, initialTab, onClose, onDeleted, notify }: { guild: GuildDetail; me: string; initialTab?: SettingsTab; onClose: () => void; onDeleted: () => void; notify: Notify }) {
  const canOverview = guild.role === 'owner' || has(guild.permissions, P.manageGuild)
  const canRoles = has(guild.permissions, P.manageRoles)
  const tabs = ([['overview', 'Visão geral', canOverview], ['roles', 'Cargos', canRoles], ['members', 'Membros', canRoles]] as const).filter(([, , ok]) => ok)
  const [tab, setTab] = useState<SettingsTab>(initialTab && tabs.some(([t]) => t === initialTab) ? initialTab : tabs[0]?.[0] ?? 'overview')
  return (
    <Dialog title="Configurações do servidor" subtitle={guild.name} onClose={onClose} wide>
      <div className="dialog-tabs settings-tabs" role="tablist">
        {tabs.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}
      </div>
      {tab === 'overview' && <OverviewTab guild={guild} onClose={onClose} onDeleted={onDeleted} notify={notify} />}
      {tab === 'roles' && <RolesTab guild={guild} notify={notify} />}
      {tab === 'members' && <MembersTab guild={guild} me={me} notify={notify} />}
    </Dialog>
  )
}

function OverviewTab({ guild, onClose, onDeleted, notify }: { guild: GuildDetail; onClose: () => void; onDeleted: () => void; notify: Notify }) {
  const [name, setName] = useState(guild.name)
  const [busy, setBusy] = useState(false)
  const [iconBusy, setIconBusy] = useState(false)
  const [confirm, setConfirm] = useState('')
  async function changeIcon(file: File) {
    if (!checkIcon(file, notify)) return
    setIconBusy(true)
    try { await uploadGuildIcon(guild.id, file); notify('success', 'Imagem do servidor atualizada.') }
    catch (err) { notify('error', (err as Error).message) } finally { setIconBusy(false) }
  }
  async function removeIcon() {
    setIconBusy(true)
    try { await request<{ icon: string }>(`/api/guilds/${guild.id}/icon`, { method: 'DELETE' }); notify('success', 'Imagem removida.') }
    catch (err) { notify('error', (err as Error).message) } finally { setIconBusy(false) }
  }
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true)
    try { await request<void>(`/api/guilds/${guild.id}`, { method: 'PATCH', body: JSON.stringify({ name }) }); notify('success', 'Servidor atualizado.'); onClose() }
    catch (err) { notify('error', (err as Error).message) } finally { setBusy(false) }
  }
  async function remove() {
    setBusy(true)
    try { await request<void>(`/api/guilds/${guild.id}`, { method: 'DELETE' }); onDeleted() }
    catch (err) { notify('error', (err as Error).message) } finally { setBusy(false) }
  }
  return (
    <>
      <form className="dialog-form" onSubmit={save}>
        <IconPicker guild={{ ...guild, name: name || guild.name }} preview={null} onPick={changeIcon} busy={iconBusy} />
        {guild.icon && <button type="button" className="link-danger centered" onClick={removeIcon} disabled={iconBusy}>Remover imagem</button>}
        <label>Nome do servidor<input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} minLength={2} required /></label>
        <div className="form-actions"><button type="submit" className="primary-button" disabled={busy || name.trim().length < 2 || name.trim() === guild.name}>Salvar</button></div>
      </form>
      {guild.role === 'owner' && (
        <div className="danger-zone">
          <span>Excluir o servidor apaga todos os canais, mensagens e arquivos. Digite <strong>{guild.name}</strong> para confirmar.</span>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-label="Nome do servidor para confirmar" />
          <div><button type="button" className="danger-button" onClick={remove} disabled={busy || confirm.trim() !== guild.name}>Excluir servidor</button></div>
        </div>
      )}
    </>
  )
}

function RolesTab({ guild, notify }: { guild: GuildDetail; notify: Notify }) {
  const roles = [...guild.roles].sort((a, b) => b.position - a.position)
  const [selectedId, setSelectedId] = useState<string | null>(roles[0]?.id ?? null)
  const selected = roles.find((r) => r.id === selectedId) ?? roles[0]
  const [draft, setDraft] = useState<Pick<Role, 'name' | 'color' | 'permissions'> | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => { if (selected) setDraft({ name: selected.name, color: selected.color, permissions: selected.permissions }); setConfirmDelete(false) }, [selected?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const isOwner = guild.role === 'owner'
  const editable = (r: Role) => r.isDefault || isOwner || r.position < guild.myTop
  const counts = new Map(roles.map((r) => [r.id, r.isDefault ? guild.members.length : guild.members.filter((m) => m.roleIds.includes(r.id)).length]))
  const dirty = !!selected && !!draft && (draft.name !== selected.name || draft.color !== selected.color || draft.permissions !== selected.permissions)

  async function create() {
    setBusy(true)
    try {
      const r = await request<Role>(`/api/guilds/${guild.id}/roles`, { method: 'POST', body: JSON.stringify({ name: 'novo cargo', color: roleColors[roles.length % roleColors.length], permissions: 0 }) })
      setSelectedId(r.id)
    } catch (err) { notify('error', (err as Error).message) } finally { setBusy(false) }
  }
  async function save() {
    if (!selected || !draft) return
    setBusy(true)
    try { await request<Role>(`/api/guilds/${guild.id}/roles/${selected.id}`, { method: 'PATCH', body: JSON.stringify(draft) }); notify('success', `Cargo ${draft.name} salvo.`) }
    catch (err) { notify('error', (err as Error).message) } finally { setBusy(false) }
  }
  async function move(up: boolean) {
    if (!selected) return
    try { await request<void>(`/api/guilds/${guild.id}/roles/${selected.id}/move`, { method: 'POST', body: JSON.stringify({ direction: up ? 'up' : 'down' }) }) }
    catch (err) { notify('error', (err as Error).message) }
  }
  async function remove() {
    if (!selected) return
    setBusy(true)
    try { await request<void>(`/api/guilds/${guild.id}/roles/${selected.id}`, { method: 'DELETE' }); setSelectedId(null); notify('success', 'Cargo excluído.') }
    catch (err) { notify('error', (err as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="roles-layout">
      <div className="roles-list">
        <button type="button" className="primary-button roles-create" onClick={create} disabled={busy}><Icon path={paths.plus} size={16} /> Criar cargo</button>
        <p className="roles-hint">Cargos mais altos mandam nos de baixo. Você só edita cargos abaixo do seu.</p>
        <ul>
          {roles.map((r) => (
            <li key={r.id}>
              <button type="button" className={`role-item ${r.id === selected?.id ? 'active' : ''} ${editable(r) ? '' : 'locked'}`} onClick={() => setSelectedId(r.id)}>
                <span className="role-dot" style={{ background: r.color || '#99a3b1' }} />
                <span className="role-name">{r.name}</span>
                <small>{counts.get(r.id)}</small>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {selected && draft && (
        <div className="role-editor">
          {!editable(selected) && <p className="role-locked">Este cargo está acima ou no mesmo nível do seu, então você não pode editá-lo.</p>}
          {!selected.isDefault ? (
            <>
              <label className="role-field">Nome do cargo<input value={draft.name} maxLength={32} disabled={!editable(selected)} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
              <div className="role-field">
                <span>Cor</span>
                <div className="color-swatches">
                  {['', ...roleColors].map((c) => <button key={c || 'none'} type="button" className={`swatch ${draft.color === c ? 'active' : ''}`} style={{ background: c || 'transparent' }} disabled={!editable(selected)} onClick={() => setDraft({ ...draft, color: c })} aria-label={c ? `Cor ${c}` : 'Sem cor'} title={c || 'Sem cor'}>{!c && '∅'}</button>)}
                </div>
              </div>
            </>
          ) : <p className="role-default-note"><strong>@todos</strong> é o cargo de todos os membros. O que ele permite vale para o servidor inteiro, e cada canal pode ajustar.</p>}
          {permGroups.map((group) => (
            <section key={group.title} className="perm-group">
              <h4>{group.title}</h4>
              {group.perms.map((p) => {
                const bit = P[p.key]
                const mine = has(guild.permissions, bit)
                return <PermToggle key={p.key} label={p.label} hint={p.hint} checked={has(draft.permissions, bit)} disabled={!editable(selected) || !mine}
                  why={!mine ? 'Você não pode dar uma permissão que não tem.' : undefined}
                  onChange={(on) => setDraft({ ...draft, permissions: on ? draft.permissions | bit : draft.permissions & ~bit })} />
              })}
            </section>
          ))}
          <div className="role-actions">
            {!selected.isDefault && editable(selected) && (
              <span className="role-move">
                <button type="button" className="ghost-button" onClick={() => move(true)} disabled={busy || selected.position + 1 >= guild.myTop} title="Subir na hierarquia">↑ Subir</button>
                <button type="button" className="ghost-button" onClick={() => move(false)} disabled={busy || selected.position <= 1} title="Descer na hierarquia">↓ Descer</button>
              </span>
            )}
            {!selected.isDefault && editable(selected) && (confirmDelete
              ? <span className="role-confirm">Excluir {selected.name}? <button type="button" className="danger-button" onClick={remove} disabled={busy}>Excluir</button><button type="button" className="ghost-button" onClick={() => setConfirmDelete(false)}>Cancelar</button></span>
              : <button type="button" className="link-danger" onClick={() => setConfirmDelete(true)}><Icon path={paths.trash} size={15} />Excluir cargo</button>)}
            <button type="button" className="primary-button" onClick={save} disabled={busy || !dirty || !editable(selected) || !draft.name.trim()}>{busy ? 'Salvando…' : 'Salvar alterações'}</button>
          </div>
        </div>
      )}
    </div>
  )
}

function MembersTab({ guild, me, notify }: { guild: GuildDetail; me: string; notify: Notify }) {
  const [search, setSearch] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  // Changes show right away; the server's reply (or the realtime reload) confirms them.
  const [local, setLocal] = useState<Record<string, string[]>>({})
  const roles = [...guild.roles].filter((r) => !r.isDefault).sort((a, b) => b.position - a.position)
  const isOwner = guild.role === 'owner'
  const list = guild.members.filter((m) => `${m.username} ${m.userTag}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    .map((m) => local[m.userId] ? { ...m, roleIds: local[m.userId] } : m)
  async function toggle(m: Member, roleId: string, on: boolean) {
    const before = m.roleIds
    const next = on ? [...before, roleId] : before.filter((id) => id !== roleId)
    setLocal((all) => ({ ...all, [m.userId]: next }))
    try { await request<void>(`/api/guilds/${guild.id}/members/${m.userId}/roles`, { method: 'PUT', body: JSON.stringify({ roleIds: next }) }) }
    catch (err) { setLocal((all) => ({ ...all, [m.userId]: before })); notify('error', (err as Error).message) }
  }
  return (
    <div className="members-tab">
      <label className="dialog-search"><span className="sr-only">Buscar membros</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar membros" /></label>
      <ul className="member-roles-list">
        {list.map((m) => {
          const canEdit = m.userId !== guild.ownerId && (isOwner || m.userId === me || memberTop(guild, m) < guild.myTop)
          const color = memberColor(guild, m)
          return (
            <li key={m.userId}>
              <div className="member-roles-row">
                {m.avatar ? <img className="member-avatar" src={avatarSource(m.avatar)} alt="" /> : <span className="member-avatar contact-placeholder">{m.username.slice(0, 1).toUpperCase()}</span>}
                <span className="member-roles-name"><strong style={color ? { color } : undefined}>{m.username}{m.userId === guild.ownerId && <span className="owner-crown" title="Dono"><Icon path={paths.crown} size={14} /></span>}</strong><small>@{m.userTag}</small></span>
                <span className="role-chips">
                  {roles.filter((r) => m.roleIds.includes(r.id)).map((r) => <span key={r.id} className="role-chip-small"><span className="role-dot" style={{ background: r.color || '#99a3b1' }} />{r.name}</span>)}
                </span>
                {canEdit && roles.length > 0 && <button type="button" className="ghost-button" onClick={() => setOpenId(openId === m.userId ? null : m.userId)} aria-expanded={openId === m.userId}>Cargos</button>}
              </div>
              {openId === m.userId && (
                <div className="member-role-picker">
                  {roles.map((r) => {
                    const allowed = isOwner || r.position < guild.myTop
                    return (
                      <label key={r.id} className={allowed ? '' : 'is-disabled'} title={allowed ? undefined : 'Cargo acima ou igual ao seu'}>
                        <input type="checkbox" checked={m.roleIds.includes(r.id)} disabled={!allowed} onChange={(e) => toggle(m, r.id, e.target.checked)} />
                        <span className="role-dot" style={{ background: r.color || '#99a3b1' }} />{r.name}
                      </label>
                    )
                  })}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Channel settings: general (name, topic, voice limit) and per-role permissions. */
export function ChannelSettingsDialog({ guild, channel, onClose, onDeleted, notify }: { guild: GuildDetail; channel: Channel; onClose: () => void; onDeleted: () => void; notify: Notify }) {
  const [tab, setTab] = useState<'general' | 'perms'>('general')
  const canPerms = has(guild.permissions, P.manageRoles)
  return (
    <Dialog title={channel.kind === 'voice' ? `Canal de voz ${channel.name}` : `#${channel.name}`} subtitle="Configurações do canal" onClose={onClose} wide={tab === 'perms'}>
      <div className="dialog-tabs settings-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'general'} className={tab === 'general' ? 'active' : ''} onClick={() => setTab('general')}>Geral</button>
        {canPerms && <button type="button" role="tab" aria-selected={tab === 'perms'} className={tab === 'perms' ? 'active' : ''} onClick={() => setTab('perms')}>Permissões</button>}
      </div>
      {tab === 'general' ? <ChannelGeneral guild={guild} channel={channel} onClose={onClose} onDeleted={onDeleted} notify={notify} /> : <ChannelPerms guild={guild} channel={channel} notify={notify} />}
    </Dialog>
  )
}

function ChannelGeneral({ channel, onClose, onDeleted, notify }: { guild: GuildDetail; channel: Channel; onClose: () => void; onDeleted: () => void; notify: Notify }) {
  const [name, setName] = useState(channel.name)
  const [topic, setTopic] = useState(channel.topic)
  const [limit, setLimit] = useState(channel.userLimit)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const slug = channelSlug(name)
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true)
    try { await request<Channel>(`/api/channels/${channel.id}`, { method: 'PATCH', body: JSON.stringify({ name, topic, userLimit: limit }) }); notify('success', 'Canal atualizado.'); onClose() }
    catch (err) { notify('error', (err as Error).message) } finally { setBusy(false) }
  }
  async function remove() {
    setBusy(true)
    try { await request<void>(`/api/channels/${channel.id}`, { method: 'DELETE' }); onDeleted() }
    catch (err) { notify('error', (err as Error).message); setConfirming(false) } finally { setBusy(false) }
  }
  return (
    <form className="dialog-form" onSubmit={save}>
      <label>Nome do canal
        <span className="channel-input"><Icon path={channel.kind === 'voice' ? paths.speaker : paths.hash} size={16} /><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required /></span>
        {name && slug !== name && <small className="field-hint">Vai ficar {channel.kind === 'voice' ? '' : '#'}{slug || '…'}</small>}
      </label>
      {channel.kind === 'text' && <label>Tópico (opcional)<input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={200} placeholder="Sobre o que é este canal?" /></label>}
      {channel.kind === 'voice' && (
        <label className="limit-field">Limite de usuários <strong>{limit === 0 ? 'Sem limite' : `${limit} ${limit === 1 ? 'pessoa' : 'pessoas'}`}</strong>
          <input type="range" min={0} max={99} value={limit} onChange={(e) => setLimit(Number(e.target.value))} aria-valuetext={limit === 0 ? 'Sem limite' : `${limit} pessoas`} />
          <small className="field-hint">Quem pode mover membros entra mesmo com o canal cheio.</small>
        </label>
      )}
      {confirming ? (
        <div className="danger-zone">
          <span>{channel.kind === 'voice' ? `Excluir ${channel.name}? Quem estiver conectado será desconectado.` : `Excluir #${channel.name} e todas as mensagens dele? Isso não pode ser desfeito.`}</span>
          <div><button type="button" className="ghost-button" onClick={() => setConfirming(false)} disabled={busy}>Cancelar</button><button type="button" className="danger-button" onClick={remove} disabled={busy}>Excluir canal</button></div>
        </div>
      ) : <button type="button" className="link-danger" onClick={() => setConfirming(true)}><Icon path={paths.trash} size={15} />Excluir canal</button>}
      <div className="form-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancelar</button><button type="submit" className="primary-button" disabled={busy || !slug}>{busy ? 'Salvando…' : 'Salvar'}</button></div>
    </form>
  )
}

function ChannelPerms({ guild, channel, notify }: { guild: GuildDetail; channel: Channel; notify: Notify }) {
  const roles = [...guild.roles].sort((a, b) => b.position - a.position)
  const everyone = roles.find((r) => r.isDefault)!
  // Shown right away; the realtime reload of the server replaces it with the saved state.
  const serverOverrides = guild.overrides[channel.id]
  const [overrides, setOverrides] = useState(serverOverrides ?? [])
  useEffect(() => { setOverrides(serverOverrides ?? []) }, [serverOverrides])
  const [roleId, setRoleId] = useState(everyone.id)
  const role = roles.find((r) => r.id === roleId) ?? everyone
  const current = overrides.find((o) => o.roleId === role.id) ?? { roleId: role.id, allow: 0, deny: 0 }
  const isOwner = guild.role === 'owner'
  const editable = (r: Role) => r.isDefault || isOwner || r.position < guild.myTop
  const everyoneOverride = overrides.find((o) => o.roleId === everyone.id)
  const isPrivate = !!everyoneOverride && has(everyoneOverride.deny, P.viewChannel)

  async function put(target: Role, allow: number, deny: number) {
    const before = overrides
    setOverrides((list) => {
      const rest = list.filter((o) => o.roleId !== target.id)
      return allow || deny ? [...rest, { roleId: target.id, allow, deny }] : rest
    })
    try { await request<void>(`/api/channels/${channel.id}/overrides/${target.id}`, { method: 'PUT', body: JSON.stringify({ allow, deny }) }) }
    catch (err) { setOverrides(before); notify('error', (err as Error).message) }
  }
  function set(key: PermKey, state: 'allow' | 'inherit' | 'deny') {
    const bit = P[key]
    const allow = state === 'allow' ? current.allow | bit : current.allow & ~bit
    const deny = state === 'deny' ? current.deny | bit : current.deny & ~bit
    void put(role, allow, deny)
  }
  function setPrivate(on: boolean) {
    const o = everyoneOverride ?? { allow: 0, deny: 0 }
    void put(everyone, o.allow & ~P.viewChannel, on ? o.deny | P.viewChannel : o.deny & ~P.viewChannel)
  }

  return (
    <div className="channel-perms">
      <label className="perm-row private-row">
        <span className="perm-text"><strong>Canal privado</strong><small>Só os cargos liberados abaixo (e administradores) veem e entram em {channel.kind === 'voice' ? channel.name : `#${channel.name}`}.</small></span>
        <input type="checkbox" role="switch" className="perm-switch" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} />
      </label>
      <div className="roles-layout">
        <div className="roles-list">
          <p className="roles-hint">Escolha um cargo para ajustar o que ele pode neste canal.</p>
          <ul>
            {roles.map((r) => {
              const o = overrides.find((x) => x.roleId === r.id)
              return (
                <li key={r.id}>
                  <button type="button" className={`role-item ${r.id === role.id ? 'active' : ''} ${editable(r) ? '' : 'locked'}`} onClick={() => setRoleId(r.id)}>
                    <span className="role-dot" style={{ background: r.color || '#99a3b1' }} />
                    <span className="role-name">{r.name}</span>
                    {o && <small className="override-mark" title="Tem ajustes neste canal">●</small>}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
        <div className="role-editor">
          {!editable(role) && <p className="role-locked">Este cargo está acima ou no mesmo nível do seu.</p>}
          <p className="tri-legend"><span className="tri deny">✕</span> bloquear <span className="tri inherit">/</span> seguir o cargo <span className="tri allow">✓</span> liberar</p>
          {channelPermKeys[channel.kind].map((key) => {
            const bit = P[key]
            const state = has(current.allow, bit) ? 'allow' : has(current.deny, bit) ? 'deny' : 'inherit'
            const info = permInfo(key)
            const mine = has(guild.permissions, bit)
            return (
              <div key={key} className={`tri-row ${!editable(role) || !mine ? 'is-disabled' : ''}`}>
                <span className="perm-text"><strong>{info.label}</strong><small>{info.hint}</small></span>
                <span className="tri-group" role="radiogroup" aria-label={info.label}>
                  {(['deny', 'inherit', 'allow'] as const).map((st) => (
                    <button key={st} type="button" role="radio" aria-checked={state === st} className={`tri ${st} ${state === st ? 'on' : ''}`} disabled={!editable(role) || !mine} onClick={() => set(key, st)}
                      aria-label={st === 'deny' ? 'Bloquear' : st === 'allow' ? 'Liberar' : 'Seguir o cargo'} title={st === 'deny' ? 'Bloquear' : st === 'allow' ? 'Liberar' : 'Seguir o cargo'}>{st === 'deny' ? '✕' : st === 'allow' ? '✓' : '/'}</button>
                  ))}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
