export type GuildRole = 'owner' | 'admin' | 'member'
export type GuildSummary = { id: string; name: string; icon: string; ownerId: string; role: GuildRole; createdAt: string; unread: number }
export type Channel = { id: string; guildId: string; name: string; kind: 'text' | 'voice'; topic: string; position: number }
export type Member = { userId: string; username: string; userTag: string; avatar: string; status: 'online' | 'away' | 'busy' | 'offline'; role: GuildRole; joinedAt: string }
export type VoiceMember = { userId: string; muted: boolean; deafened: boolean; video: boolean; screen: boolean; joinedAt: string }
export type GuildDetail = Omit<GuildSummary, 'unread'> & { channels: Channel[]; members: Member[]; unread: Record<string, number>; voice: Record<string, VoiceMember[]> }
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
