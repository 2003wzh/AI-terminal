import { Archive, ArchiveRestore, MoreHorizontal, Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface TaskHistoryActionsProps {
  title: string
  archived: boolean
  disabled: boolean
  onArchiveChange: (archived: boolean) => void
  onDelete: () => void
}

interface MenuPosition {
  left: number
  top: number
}

const MENU_WIDTH = 176
const MENU_HEIGHT = 82
const VIEWPORT_PADDING = 8
const MENU_GAP = 6

export default function TaskHistoryActions({
  title,
  archived,
  disabled,
  onArchiveChange,
  onDelete,
}: TaskHistoryActionsProps) {
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<MenuPosition | null>(null)

  useEffect(() => {
    if (disabled) setPosition(null)
  }, [disabled])

  useEffect(() => {
    if (!position) return

    const closeFromOutside = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setPosition(null)
    }
    const closeFromKeyboard = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setPosition(null)
      window.setTimeout(() => triggerRef.current?.focus(), 0)
    }
    const closeAfterViewportChange = (): void => setPosition(null)

    document.addEventListener('pointerdown', closeFromOutside, true)
    document.addEventListener('keydown', closeFromKeyboard)
    window.addEventListener('resize', closeAfterViewportChange)
    window.addEventListener('scroll', closeAfterViewportChange, true)
    return () => {
      document.removeEventListener('pointerdown', closeFromOutside, true)
      document.removeEventListener('keydown', closeFromKeyboard)
      window.removeEventListener('resize', closeAfterViewportChange)
      window.removeEventListener('scroll', closeAfterViewportChange, true)
    }
  }, [position])

  const toggleMenu = (): void => {
    if (disabled) return
    if (position) {
      setPosition(null)
      return
    }
    const bounds = triggerRef.current?.getBoundingClientRect()
    if (!bounds) return
    const left = Math.min(
      window.innerWidth - MENU_WIDTH - VIEWPORT_PADDING,
      Math.max(VIEWPORT_PADDING, bounds.right - MENU_WIDTH),
    )
    const fitsBelow = bounds.bottom + MENU_GAP + MENU_HEIGHT <= window.innerHeight - VIEWPORT_PADDING
    const top = fitsBelow
      ? bounds.bottom + MENU_GAP
      : Math.max(VIEWPORT_PADDING, bounds.top - MENU_GAP - MENU_HEIGHT)
    setPosition({ left, top })
  }

  const runAction = (action: () => void): void => {
    setPosition(null)
    action()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="task-row-actions-trigger"
        aria-label={`管理会话：${title}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(position)}
        aria-controls={position ? menuId : undefined}
        title="更多操作"
        disabled={disabled}
        onClick={toggleMenu}
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </button>
      {position && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          className="task-history-menu"
          role="menu"
          aria-label={`会话操作：${title}`}
          style={position}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => runAction(() => onArchiveChange(!archived))}
          >
            {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            <span>{archived ? '移出归档' : '归档会话'}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => runAction(onDelete)}
          >
            <Trash2 size={14} />
            <span>删除会话</span>
          </button>
        </div>,
        document.body,
      )}
    </>
  )
}
