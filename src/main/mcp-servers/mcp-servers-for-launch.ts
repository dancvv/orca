// The host list's servers a new session gets, read without writing, and a fingerprint of that set
// so a running session can tell whether an edit to the list touched it.
import { createHash } from 'node:crypto'
import type { BotToolServer } from '../../shared/bot-tools'
import { isMcpServerOnInWorkspace } from '../../shared/mcp-servers/mcp-servers'
import { botToolCredentialFingerprints } from '../bots/bot-tool-credentials'
import { botToolEntries, readBotToolsSnapshot } from '../bots/bot-tools-file'
import { settingsOf } from './mcp-host-list'
import { mcpHostListFolder } from './mcp-host-list-folder'

/**
 * The servers a new session of `agent` gets: those on for the agent and on in the workspace with
 * `key` (null for none). A bot's session (`'any'`) takes them whichever workspaces they're on in.
 * `digests`, by name, change only when that server or its saved values or sign-in do (not when a
 * token refreshes), so a running session can tell which of its servers an edit touched.
 */
export async function mcpServersForLaunch(
  agent: string,
  workspace: { key: string | null } | 'any',
  folder = mcpHostListFolder()
): Promise<{ servers: BotToolServer[]; digests: Record<string, string> }> {
  // Read only: a launch never writes the list, even to give an entry edited outside Orca its id.
  const servers = botToolEntries(await readBotToolsSnapshot(folder)).flatMap(
    ({ server, extras }) => {
      const settings = settingsOf(extras)
      const on =
        !settings.agentsOff.includes(agent) &&
        (workspace === 'any' || isMcpServerOnInWorkspace(settings.workspaces, workspace.key))
      return on ? [server] : []
    }
  )
  const saved = savedValues(
    folder,
    new Set(
      servers.flatMap((server) => ('url' in server && server.credential ? [server.credential] : []))
    )
  )
  const digests = Object.fromEntries(
    servers.map((server) => [
      server.name,
      createHash('sha256')
        .update(JSON.stringify(server))
        .update(
          'url' in server && server.credential
            ? JSON.stringify(saved.get(server.credential) ?? null)
            : ''
        )
        .digest('hex')
    ])
  )
  return { servers, digests }
}

/**
 * Each credential's saved values or sign-in, as the tools revision counts them, from one read of
 * the store. A store Orca can't read never keeps the servers from launching.
 */
function savedValues(folder: string, credentials: ReadonlySet<string>): Map<string, unknown> {
  if (credentials.size === 0) {
    return new Map()
  }
  try {
    return botToolCredentialFingerprints(folder, credentials)
  } catch {
    return new Map([...credentials].map((id) => [id, 'unreadable']))
  }
}
