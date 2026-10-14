import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
export default function FloatingDialog({
  title,
  label,
  children,
  footer,
  onClose,
  wide = false,
  modal = true,
  className = '',
  closeLabel = '关闭浮窗',
}: {
  title: string;
  label?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
  modal?: boolean;
  className?: string;
  closeLabel?: string;
}) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const dialog = useRef<HTMLElement>(null),
    close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    dialog.current?.querySelector<HTMLElement>('button')?.focus();
    const keys = (e: KeyboardEvent) => {
      const modals = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      const dialogs = modals.length ? modals : document.querySelectorAll('[role="dialog"]');
      if (dialogs.item(dialogs.length - 1) !== dialog.current) return;
      if (!modal && !dialog.current?.contains(document.activeElement)) return;
      if (e.key === 'Escape') close.current();
      if (e.key !== 'Tab' || !modal) return;
      const items = Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary',
        ) || [],
      );
      const first = items[0],
        last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', keys);
    return () => {
      document.removeEventListener('keydown', keys);
      previous?.focus();
    };
  }, [modal]);
  return (
    <div className={modal ? 'floating-backdrop' : 'floating-layer'}>
      <section
        ref={dialog}
        className={`${modal ? (wide ? 'detail-floating' : 'scope-floating') : 'review-floating'} ${className}`}
        style={!modal && position ? { ...position, right: 'auto', bottom: 'auto' } : undefined}
        role="dialog"
        aria-modal={modal ? true : undefined}
        aria-label={label || title}
      >
        <div className="drawer-header"
          onPointerDown={(e) => {
            if (modal || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
            const rect = dialog.current!.getBoundingClientRect();
            drag.current = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            const rect = dialog.current!.getBoundingClientRect(), start = drag.current;
            setPosition({ left: Math.max(8, Math.min(window.innerWidth - rect.width - 8, start.left + e.clientX - start.x)),
              top: Math.max(8, Math.min(window.innerHeight - rect.height - 8, start.top + e.clientY - start.y)) });
          }}
          onPointerUp={() => { drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }}>
          <div>
            <h2>{title}</h2>
          </div>
          <button className="icon-button" aria-label={closeLabel} title={closeLabel} onClick={onClose}>
            <X size={19} />
          </button>
        </div>
        <div className="drawer-content">{children}</div>
        {footer && <div className="drawer-footer">{footer}</div>}
      </section>
    </div>
  );
}
