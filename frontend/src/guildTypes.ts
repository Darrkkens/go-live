export type GuildRole = 'owner' | 'admin' | 'member'
export type GuildSummary = { id: string; name: string; icon: string; ownerId: string; role: GuildRole; createdAt: string; unread: number }
export type Channel = { id: string; guildId: string; name: string; kind: 'text' | 'voice'; topic: string; position: number; userLimit: number }
export type Member = { userId: string; username: string; userTag: string; avatar: string; status: 'online' | 'away' | 'busy' | 'offline'; role: GuildRole; roleIds: string[]; joinedAt: string }
export type Role = { id: string; name: string; color: string; position: number; permissions: number; isDefault: boolean }
export type Override = { roleId: string; allow: number; deny: number }
export type VoiceMember = { userId: string; muted: boolean; deafened: boolean; video: boolean; screen: boolean; serverMuted: boolean; joinedAt: string }
export type GuildDetail = Omit<GuildSummary, 'unread'> & {
  channels: Channel[]; members: Member[]; unread: Record<string, number>; voice: Record<string, VoiceMember[]>
  roles: Role[]
  /** Your server-wide permissions, and per visible channel. */
  permissions: number; channelPermissions: Record<string, number>
  overrides: Record<string, Override[]>
  /** Position of your highest role (very large for the owner). */
  myTop: number
}
export type InvitePreview = { code: string; guildId: string; guildName: string; guildIcon: string; memberCount: number; member: boolean }
export type Notify = (kind: 'success' | 'error', message: string) => void

export const roleRank: Record<GuildRole, number> = { owner: 3, admin: 2, member: 1 }
export const roleLabel: Record<GuildRole, string> = { owner: 'Dono', admin: 'Admin', member: 'Membro' }

/** Two letters for a server without an icon, like Discord ("Time Go" -> "TG"). */
export function guildInitials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase()
}

/** A stable color per server so icons are easy to tell apart. */
export function guildColor(id: string) {
  const palette = ['#5b7fd6', '#3f9f8f', '#c0695a', '#8a6bd1', '#c58a2e', '#4b93c7', '#b0578f', '#5f9d4b']
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return palette[h % palette.length]
}

/** Mirrors the server rule: "Bate Papo!" -> "bate-papo". */
export function channelSlug(name: string) {
  return name.toLowerCase().trim().replace(/[^\p{L}\p{N}_\s-]/gu, '').replace(/[\s-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

// Permission bits; must match internal/guilds/perms.go.
export const P = {
  administrator: 1 << 0,
  manageGuild: 1 << 1,
  manageChannels: 1 << 2,
  manageRoles: 1 << 3,
  createInvite: 1 << 4,
  addMembers: 1 << 5,
  kickMembers: 1 << 6,
  manageMessages: 1 << 7,
  viewChannel: 1 << 8,
  sendMessages: 1 << 9,
  attachFiles: 1 << 10,
  connect: 1 << 11,
  speak: 1 << 12,
  video: 1 << 13,
  moveMembers: 1 << 14,
  muteMembers: 1 << 15,
} as const
export type PermKey = keyof typeof P

export const has = (perms: number, p: number) => (perms & p) === p

export type PermInfo = { key: PermKey; label: string; hint: string }
export const permGroups: { title: string; perms: PermInfo[] }[] = [
  { title: 'Gerais', perms: [
    { key: 'administrator', label: 'Administrador', hint: 'Todas as permissões e acesso a todos os canais. Dê com cuidado.' },
    { key: 'manageGuild', label: 'Gerenciar servidor', hint: 'Mudar o nome e a imagem do servidor.' },
    { key: 'manageRoles', label: 'Gerenciar cargos', hint: 'Criar e editar cargos abaixo do seu e dar cargos aos membros.' },
    { key: 'manageChannels', label: 'Gerenciar canais', hint: 'Criar, editar e excluir canais e mudar as permissões deles.' },
  ] },
  { title: 'Membros', perms: [
    { key: 'createInvite', label: 'Criar convite', hint: 'Gerar links de convite para o servidor.' },
    { key: 'addMembers', label: 'Adicionar membros', hint: 'Colocar usuários no servidor direto, sem convite.' },
    { key: 'kickMembers', label: 'Expulsar membros', hint: 'Remover do servidor quem tem um cargo abaixo do seu.' },
  ] },
  { title: 'Canais de texto', perms: [
    { key: 'viewChannel', label: 'Ver canais', hint: 'Ver os canais e ler as mensagens. Sem isso o canal some da lista.' },
    { key: 'sendMessages', label: 'Enviar mensagens', hint: 'Escrever nos canais de texto.' },
    { key: 'attachFiles', label: 'Enviar arquivos', hint: 'Mandar imagens e documentos.' },
    { key: 'manageMessages', label: 'Apagar mensagens dos outros', hint: 'Apagar qualquer mensagem, sem o limite de 5 minutos.' },
  ] },
  { title: 'Canais de voz', perms: [
    { key: 'connect', label: 'Conectar', hint: 'Entrar nos canais de voz.' },
    { key: 'speak', label: 'Falar', hint: 'Usar o microfone. Sem isso a pessoa só escuta.' },
    { key: 'video', label: 'Vídeo e tela', hint: 'Ligar a câmera e compartilhar a tela.' },
    { key: 'moveMembers', label: 'Mover e desconectar membros', hint: 'Arrastar pessoas entre canais de voz, desconectá-las e entrar em canais cheios.' },
    { key: 'muteMembers', label: 'Silenciar membros', hint: 'Silenciar o microfone de alguém no servidor todo.' },
  ] },
]

/** Permissions that a channel can override, by kind. */
export const channelPermKeys: Record<'text' | 'voice', PermKey[]> = {
  text: ['viewChannel', 'sendMessages', 'attachFiles', 'manageMessages', 'manageChannels', 'createInvite'],
  voice: ['viewChannel', 'connect', 'speak', 'video', 'moveMembers', 'muteMembers', 'manageChannels', 'createInvite'],
}

export const permInfo = (key: PermKey) => permGroups.flatMap((g) => g.perms).find((p) => p.key === key)!

/** The member's highest role with a color, for name colors like Discord. */
export function memberColor(guild: GuildDetail, member: Member) {
  return guild.roles.filter((r) => !r.isDefault && r.color && member.roleIds.includes(r.id)).sort((a, b) => b.position - a.position)[0]?.color ?? ''
}

export function memberTop(guild: GuildDetail, member: Member) {
  if (member.userId === guild.ownerId) return 1 << 30
  return Math.max(0, ...guild.roles.filter((r) => member.roleIds.includes(r.id)).map((r) => r.position))
}

export const roleColors = ['#e5484d', '#f76b15', '#f0b232', '#2fb344', '#12a594', '#3776bd', '#6e56cf', '#d6409f', '#8b95a7']
