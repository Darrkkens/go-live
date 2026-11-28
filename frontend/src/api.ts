export const apiBase = `http://localhost:${import.meta.env.VITE_PORT || '8081'}`

export const avatarSource = (path: string) => path.startsWith('/api/avatars/') ? `${apiBase}${path}` : path

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
