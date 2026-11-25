// Custom server: one field takes a URL, a start command, an mcpServers block or `mcp add` lines, read
// with the desktop's parser for the host's platform; a URL can carry headers, kept as names once saved.
import { useMemo, useRef, useState } from 'react'
import { Plus } from 'lucide-react-native'
import { parseMcpServersPaste } from '../../../src/shared/bot-tool-paste'
import { freeBotToolName, type BotToolServer } from '../../../src/shared/bot-tools'
import { botToolDraftInput, draftFromServer } from '../../../src/shared/bots/bot-tool-draft'
import { createNonSecureContextUuid as createUuid } from '../../../src/shared/identifiers/non-secure-context-uuid'
import { useOptionalHostProtocolGates } from '../components/host-connection/host-protocol-gates-context'
import { ListRow, SectionHeader } from '../components/list/ListGroup'
import { TextField } from '../components/composer-input/TextField'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useBackClaim } from '../navigation/use-back-claim'
import { SettingsNote, SettingsSection } from '../settings/settings-screen-frame'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { MobileBotToolValuePage } from '../bots/tools/MobileBotToolValuePage'
import { mcpServerAdd, type PhoneMcpServer } from './mcp-server-operations'

/** A catalog app's address, its name, and headers it needs filled in (GitHub's token). */
export type McpCustomPreset = {
  source: string
  name: string
  headers: readonly { key: string; value: string }[]
}

type Header = { id: string; key: string; value: string }
/** A server the paste names, under the name the host will keep, and the name it was pasted with. */
type Pasted = { server: BotToolServer; pasted: string }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function MobileMcpCustomServerPage(props: {
  client: RpcClient | null
  hostName: string
  /** The host's server names: a pasted name that's taken gets a free one, as on the desktop. */
  taken: ReadonlySet<string>
  preset?: McpCustomPreset
  online: boolean
  onCancel: () => void
  onAdded: (server: PhoneMcpServer) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const platform = useOptionalHostProtocolGates()?.hostPlatform ?? 'linux'
  const [source, setSource] = useState(props.preset?.source ?? '')
  const [headers, setHeaders] = useState<Header[]>(() =>
    (props.preset?.headers ?? []).map((header) => ({ id: createUuid(), ...header }))
  )
  // The headers page, then one header on it (null index: a new one).
  const [editing, setEditing] = useState<{ index: number | null } | 'list' | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useBackClaim(() => {
    if (editing !== null && editing !== 'list') {
      setEditing('list')
    } else if (editing === 'list') {
      setEditing(null)
    } else if (!saving) {
      props.onCancel()
    }
    return true
  })
  const typed = source.trim()
  const { preset, taken } = props
  // The pasted names a failed Add got through before it stopped; a new paste starts over.
  const added = useRef(new Set<string>())
  const addedFor = useRef(typed)
  if (addedFor.current !== typed) {
    addedFor.current = typed
    added.current = new Set()
  }
  // The servers the paste names, under the names the host will keep; a problem shows on Add.
  const read = useMemo((): { servers: Pasted[] } | { problem: string } | null => {
    if (!typed) {
      return null
    }
    try {
      const parsed = parseMcpServersPaste(typed, platform, t)
      const names = new Set(taken)
      const servers = parsed.map((server) => {
        const name = freeBotToolName(
          parsed.length === 1 && preset ? preset.name : server.name,
          names
        )
        names.add(name)
        return { server: { ...server, name }, pasted: server.name }
      })
      return { servers }
    } catch (caught) {
      return { problem: messageOf(caught) }
    }
  }, [typed, platform, t, taken, preset])
  const pastes = read && 'servers' in read ? read.servers : []
  const servers = pastes.map((entry) => entry.server)
  const one = servers.length === 1 ? servers[0] : null
  // A paste's own headers stay; one set on this page replaces the pasted one of the same name.
  const pastedHeaders = one && 'url' in one ? Object.keys(one.headers ?? {}) : []
  const url = one !== null && 'url' in one
  const sent = url ? headers.filter((header) => header.key.trim()) : []
  // A preset's header still at its preset value ("Bearer ") has no token in it yet.
  const unfilled = (header: Header) =>
    header.value.trim() === '' ||
    preset?.headers.some((given) => given.key === header.key && given.value === header.value) ===
      true
  const missing = sent.find(unfilled)
  const add = () => {
    if (!props.client || !typed || saving || !props.online || missing) {
      return
    }
    if (read && 'problem' in read) {
      setError(read.problem)
      return
    }
    const client = props.client
    setSaving(true)
    setError(null)
    void (async () => {
      let first: PhoneMcpServer | null = null
      for (const { server, pasted } of pastes) {
        // Added by an earlier try that failed further on: the host has it already.
        if (added.current.has(pasted)) {
          continue
        }
        const input = botToolDraftInput(draftFromServer(server))
        const own = sent.map(({ key, value }) => ({ key: key.trim(), value }))
        const config =
          'url' in input && own.length > 0
            ? {
                ...input,
                headers: [
                  ...input.headers.filter((header) => !own.some((mine) => mine.key === header.key)),
                  ...own
                ]
              }
            : input
        const reply = await mcpServerAdd.request(client, { config }, { failWhenDisconnected: true })
        const saved = mcpServerAdd.interpret(reply).server
        added.current.add(pasted)
        first ??= saved
      }
      return first
    })()
      .then((saved) => saved && props.onAdded(saved))
      .catch((caught: unknown) => {
        setSaving(false)
        setError(messageOf(caught))
      })
  }
  const back = {
    label: t('mcpServers.customServer', 'Custom server'),
    onPress: () => setEditing(null)
  }
  if (editing !== null && editing !== 'list') {
    const index = editing.index
    const row = index === null ? null : headers[index]
    return (
      <MobileBotToolValuePage
        title={t('mcpServers.header', 'Header')}
        initial={[row?.key ?? '', row?.value ?? '']}
        fields={() => [
          { label: t('mcpServers.headerName', 'Name'), required: true, maxLength: 256 },
          {
            label: t('mcpServers.headerValue', 'Value'),
            secret: true,
            required: true,
            maxLength: 4096
          }
        ]}
        remove={
          index === null
            ? undefined
            : {
                label: t('mcpServers.removeHeader', 'Remove header'),
                onPress: () => {
                  setHeaders(headers.filter((_, at) => at !== index))
                  setEditing('list')
                }
              }
        }
        onCancel={() => setEditing('list')}
        onDone={([key, value]) => {
          const next = { id: row?.id ?? createUuid(), key: key.trim(), value }
          setHeaders(
            index === null ? [...headers, next] : headers.map((h, at) => (at === index ? next : h))
          )
          setEditing('list')
        }}
      />
    )
  }
  if (editing === 'list') {
    return (
      <>
        <SheetHeader title={t('mcpServers.headers', 'Headers')} onBack={back} />
        <SettingsSection first>
          {headers.map((header, index) => (
            <ListRow
              key={header.id}
              title={header.key}
              value={unfilled(header) ? t('mcpServers.headerEmpty', 'Empty') : '••••••'}
              navigates
              onPress={() => setEditing({ index })}
            />
          ))}
          <ListRow
            key="add"
            title={t('mcpServers.addHeader', 'Add header')}
            leading={<Plus size={18} color={colors.textMuted} />}
            onPress={() => setEditing({ index: null })}
          />
        </SettingsSection>
      </>
    )
  }
  return (
    <>
      <SheetHeader
        title={t('mcpServers.customServer', 'Custom server')}
        leading={{ label: t('common.cancel', 'Cancel'), onPress: props.onCancel, disabled: saving }}
        trailing={{
          label: t('mcpServers.addButton', 'Add'),
          onPress: add,
          disabled: !typed || !props.online || missing !== undefined,
          busy: saving
        }}
      />
      <SectionHeader title={t('mcpServers.sourceLabel', 'Server URL or start command')} first />
      <TextField
        monospace
        value={source}
        onChangeText={(next) => {
          setSource(next)
          setError(null)
        }}
        placeholder={t('mcpServers.sourcePlaceholder', 'https://… or npx …')}
        accessibilityLabel={t('mcpServers.sourceLabel', 'Server URL or start command')}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={!props.preset}
        multiline={/^\s*[{"]/.test(source)}
        editable={!saving}
        returnKeyType="done"
        onSubmitEditing={add}
      />
      <SettingsNote error={error !== null}>
        {error ??
          t(
            'mcpServers.sourceNote',
            'Paste a server URL, a start command or an mcpServers config.'
          )}
      </SettingsNote>
      {servers.length > 0 ? (
        <SettingsSection
          title={t('mcpServers.details', 'Details')}
          footer={
            missing ? (
              <SettingsNote>
                {t('mcpServers.headerMissing', 'Fill in {{header}} to add this server.', {
                  header: missing.key
                })}
              </SettingsNote>
            ) : (
              t('mcpServers.trust', 'Only add software you trust.')
            )
          }
        >
          {one ? (
            <ListRow
              key="type"
              title={t('mcpServers.serverType', 'Server type')}
              value={
                url
                  ? t('mcpServers.urlMode', 'Connect to a URL')
                  : t('mcpServers.commandMode', 'Run a command')
              }
            />
          ) : null}
          {one ? (
            <ListRow
              key="name"
              title={t('mcpServers.serverName', 'Server name')}
              value={one.name}
            />
          ) : (
            <ListRow
              key="servers"
              title={t('mcpServers.servers', 'Servers')}
              subtitle={servers.map((server) => server.name).join(', ')}
              subtitleLines={3}
            />
          )}
          {url ? (
            <ListRow
              key="headers"
              title={t('mcpServers.headers', 'Headers')}
              value={
                pastedHeaders.length + sent.length === 0
                  ? t('mcpServers.headersNone', 'None')
                  : [...new Set([...pastedHeaders, ...sent.map((header) => header.key)])].join(', ')
              }
              navigates
              disabled={saving}
              onPress={() => setEditing('list')}
            />
          ) : null}
        </SettingsSection>
      ) : null}
    </>
  )
}
