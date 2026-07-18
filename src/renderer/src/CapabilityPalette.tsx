import {
  Brain,
  Check,
  Command,
  FileCog,
  ListChecks,
  PackageOpen,
  PlugZap,
  Search,
  ScanSearch,
  Sparkles,
  Target,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type {
  CapabilityCatalog,
  CapabilityCommandDescriptor,
  CapabilityCommandId,
  PluginDescriptor,
  SkillDescriptor,
} from '../../shared/contracts'

type PaletteTrigger = '/' | '$' | '@'
type PaletteItem =
  | { kind: 'command'; value: CapabilityCommandDescriptor }
  | { kind: 'skill'; value: SkillDescriptor }
  | { kind: 'plugin'; value: PluginDescriptor }

export interface CapabilityPaletteProps {
  draft: string
  onDraftChange: (value: string) => void
  catalog: CapabilityCatalog
  listId: string
  onCommand: (id: CapabilityCommandId) => void
  onSkill: (skill: SkillDescriptor) => void
  onPlugin: (plugin: PluginDescriptor) => void
  onStateChange?: (state: { expanded: boolean; activeDescendant?: string }) => void
  onDiscover?: (trigger: '$' | '@') => void
  discoveryScopeKey?: string
  discoveryLoading?: boolean
  discoveryLoadingTriggers?: readonly ('$' | '@')[]
  disabled?: boolean
}

const triggerLabels: Record<PaletteTrigger, string> = {
  '/': '命令',
  '$': '技能',
  '@': '插件',
}

function itemIcon(item: PaletteItem) {
  if (item.kind === 'skill') return Sparkles
  if (item.kind === 'plugin') return PlugZap
  switch (item.value.id) {
    case 'plan': return ListChecks
    case 'goal': return Target
    case 'compact': return ScanSearch
    case 'memories': return Brain
    case 'init': return FileCog
    case 'review': return Search
    default: return Command
  }
}

function itemLabel(item: PaletteItem): string {
  if (item.kind === 'skill') return item.value.name
  if (item.kind === 'plugin') return item.value.name
  return item.value.name
}

function itemDescription(item: PaletteItem): string {
  if (item.kind === 'skill') return item.value.description
  if (item.kind === 'plugin') return `${item.value.description}${item.value.enabled ? '' : ' · 未启用'}`
  return item.value.description
}

function readTrigger(draft: string): { trigger: PaletteTrigger; query: string; start: number } | null {
  const match = /(?:^|\s)([/$@])([^\s]*)$/u.exec(draft)
  if (!match || !match[1]) return null
  return {
    trigger: match[1] as PaletteTrigger,
    query: match[2] ?? '',
    start: draft.length - 1 - (match[2]?.length ?? 0),
  }
}

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function itemDisabled(item: PaletteItem): boolean {
  return item.kind === 'plugin' && !item.value.enabled
}

function itemOptionId(listId: string, item: PaletteItem): string {
  return `${listId}-option-${item.kind}-${encodeURIComponent(item.value.id)}`
}

export default function CapabilityPalette({
  draft,
  onDraftChange,
  catalog,
  listId,
  onCommand,
  onSkill,
  onPlugin,
  onStateChange,
  onDiscover,
  discoveryScopeKey = 'user',
  discoveryLoading = false,
  discoveryLoadingTriggers,
  disabled = false,
}: CapabilityPaletteProps) {
  const triggerState = readTrigger(draft)
  const [highlighted, setHighlighted] = useState(0)
  const [dismissedKey, setDismissedKey] = useState('')
  const [mobilePortal, setMobilePortal] = useState(() => window.matchMedia('(max-width: 640px)').matches)
  const listRef = useRef<HTMLDivElement>(null)
  const discoveryRef = useRef<string>('')
  const triggerKey = triggerState ? `${triggerState.trigger}:${triggerState.query}` : ''
  const triggerLoading = triggerState?.trigger === '$' || triggerState?.trigger === '@'
    ? (discoveryLoadingTriggers?.includes(triggerState.trigger) ?? discoveryLoading)
    : false

  const items = useMemo<PaletteItem[]>(() => {
    if (!triggerState) return []
    const query = normalizeSearch(triggerState.query)
    const matches = (label: string, description: string, id: string): boolean => {
      if (!query) return true
      const haystack = `${label} ${description} ${id}`.toLocaleLowerCase()
      return haystack.includes(query)
    }
    if (triggerState.trigger === '/') {
      return catalog.commands
        .filter((entry) => matches(entry.name, entry.description, `${entry.id} ${entry.aliases.join(' ')}`))
        .map((value) => ({ kind: 'command', value }))
    }
    if (triggerState.trigger === '$') {
      return catalog.skills
        .filter((entry) => matches(entry.name, entry.description, entry.id))
        .map((value) => ({ kind: 'skill', value }))
    }
    return catalog.plugins
      .filter((entry) => matches(entry.name, entry.description, entry.id))
      .map((value) => ({ kind: 'plugin', value }))
  }, [catalog, triggerState])

  const selectableIndices = useMemo(
    () => items.flatMap((item, index) => itemDisabled(item) ? [] : [index]),
    [items]
  )
  const effectiveHighlighted = selectableIndices.includes(highlighted)
    ? highlighted
    : (selectableIndices[0] ?? -1)
  const expanded = Boolean(triggerState) && !disabled && dismissedKey !== triggerKey
  const activeDescendant = expanded && !triggerLoading && effectiveHighlighted >= 0
    ? itemOptionId(listId, items[effectiveHighlighted]!)
    : undefined

  useEffect(() => {
    const media = window.matchMedia('(max-width: 640px)')
    const update = (): void => setMobilePortal(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    setHighlighted(0)
    setDismissedKey('')
  }, [triggerState?.trigger, triggerState?.query])

  useEffect(() => {
    if (!triggerState) discoveryRef.current = ''
  }, [triggerState])

  useEffect(() => {
    onStateChange?.({ expanded, ...(activeDescendant ? { activeDescendant } : {}) })
  }, [activeDescendant, expanded, onStateChange])

  useEffect(() => () => {
    onStateChange?.({ expanded: false })
  }, [onStateChange])

  useEffect(() => {
    if (!triggerState || (triggerState.trigger !== '$' && triggerState.trigger !== '@') || !onDiscover) return
    const key = `${discoveryScopeKey}:${triggerState.trigger}:${triggerState.query}`
    if (discoveryRef.current === key) return
    discoveryRef.current = key
    onDiscover(triggerState.trigger)
  }, [discoveryScopeKey, onDiscover, triggerState])

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    active?.scrollIntoView({ block: 'nearest' })
  }, [effectiveHighlighted, items.length])

  useEffect(() => {
    setHighlighted(effectiveHighlighted)
  }, [effectiveHighlighted])

  useEffect(() => {
    if (!triggerState) return
    const dismiss = (): void => setDismissedKey(triggerKey)
    const dismissOutside = (event: globalThis.PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (listRef.current?.contains(target)) return
      if (target instanceof HTMLTextAreaElement && target.dataset.capabilityInput === 'true') return
      dismiss()
    }
    const dismissOnFocusChange = (event: globalThis.FocusEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (target instanceof HTMLTextAreaElement && target.dataset.capabilityInput === 'true') {
        setDismissedKey('')
        return
      }
      if (listRef.current?.contains(target)) return
      dismiss()
    }
    document.addEventListener('pointerdown', dismissOutside, true)
    document.addEventListener('focusin', dismissOnFocusChange, true)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true)
      document.removeEventListener('focusin', dismissOnFocusChange, true)
    }
  }, [triggerKey, triggerState])

  const choose = useCallback((item: PaletteItem): void => {
    if (!triggerState || itemDisabled(item)) return
    const prefix = draft.slice(0, triggerState.start)
    const suffix = draft.slice(triggerState.start + triggerState.trigger.length + triggerState.query.length)
    const token = item.kind === 'command'
      ? `/${item.value.id}`
      : item.kind === 'skill'
        ? `$${item.value.id}`
        : `@${item.value.id}`
    onDraftChange(`${prefix}${token} ${suffix}`)
    if (item.kind === 'command') onCommand(item.value.id)
    else if (item.kind === 'skill') onSkill(item.value)
    else onPlugin(item.value)
  }, [draft, onCommand, onDraftChange, onPlugin, onSkill, triggerState])

  useEffect(() => {
    if (!triggerState || disabled || dismissedKey === triggerKey) return
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (
        !(document.activeElement instanceof HTMLTextAreaElement) ||
        document.activeElement.dataset.capabilityInput !== 'true' ||
        event.isComposing ||
        event.keyCode === 229
      ) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setDismissedKey(triggerKey)
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        event.stopPropagation()
        if (selectableIndices.length > 0) {
          setHighlighted((current) => {
            const position = selectableIndices.indexOf(current)
            return selectableIndices[(position + 1 + selectableIndices.length) % selectableIndices.length]!
          })
        }
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        if (selectableIndices.length > 0) {
          setHighlighted((current) => {
            const position = selectableIndices.indexOf(current)
            const start = position < 0 ? 0 : position
            return selectableIndices[(start - 1 + selectableIndices.length) % selectableIndices.length]!
          })
        }
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        if (!triggerLoading && effectiveHighlighted >= 0) choose(items[effectiveHighlighted]!)
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [choose, disabled, dismissedKey, effectiveHighlighted, items, selectableIndices, triggerKey, triggerLoading, triggerState])

  if (!triggerState || !expanded) return null

  const inputTop = mobilePortal
    ? document.querySelector<HTMLElement>('[data-capability-input="true"]')?.getBoundingClientRect().top
    : undefined
  const mobileBottom = inputTop === undefined ? 76 : Math.max(12, window.innerHeight - inputTop + 10)

  const palette = (
    <div
      className="capability-palette"
      id={listId}
      role="listbox"
      aria-label={`${triggerLabels[triggerState.trigger]}选择`}
      aria-busy={triggerLoading || undefined}
      style={mobilePortal ? { bottom: `${mobileBottom}px` } : undefined}
      ref={listRef}
    >
      <div className="capability-palette-header">
        <span className="capability-palette-trigger">{triggerState.trigger}</span>
        <span>{triggerLabels[triggerState.trigger]}</span>
        <small>{items.length} 项</small>
      </div>
      <div className="capability-palette-list">
        {triggerLoading ? (
          <div className="capability-palette-empty"><ScanSearch size={16} className="capability-palette-spin" />正在加载目录</div>
        ) : items.length === 0 ? (
          <div className="capability-palette-empty"><PackageOpen size={16} />没有匹配的能力</div>
        ) : items.map((item, index) => {
          const Icon = itemIcon(item)
          const disabledItem = itemDisabled(item)
          const selected = !disabledItem && index === effectiveHighlighted
          return (
            <button
              id={itemOptionId(listId, item)}
              type="button"
              role="option"
              aria-selected={selected}
              aria-disabled={disabledItem || undefined}
              tabIndex={-1}
              disabled={disabledItem}
              className={selected ? 'is-highlighted' : ''}
              key={`${item.kind}:${item.value.id}`}
              onMouseEnter={() => { if (!disabledItem) setHighlighted(index) }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(item)}
            >
              <span className="capability-palette-icon"><Icon size={15} /></span>
              <span className="capability-palette-copy">
                <strong>{itemLabel(item)}</strong>
                <small>{itemDescription(item)}</small>
              </span>
              {selected && <Check size={14} className="capability-palette-check" />}
            </button>
          )
        })}
      </div>
      <div className="capability-palette-footer"><span>Enter 选择</span><span>Esc 关闭</span></div>
    </div>
  )

  return mobilePortal ? createPortal(palette, document.body) : palette
}
