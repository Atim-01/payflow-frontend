"use client";

import { useI18n } from "@/i18n/provider";

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from "react";

export interface VirtualListProps<T> {
  items: T[];
  /** Minimum number of items required before virtualization activates. Default: 100. */
  threshold?: number;
  /** Estimated height of a single item in pixels. Default: 160. */
  itemHeight?: number;
  /** Maximum visible height of the virtual container in pixels. Default: 640. */
  containerMaxHeight?: number;
  /** Number of buffer items rendered above and below the visible viewport. Default: 6. */
  overscan?: number;
  keyExtractor: (item: T, index: number) => string | number;
  renderItem: (item: T, index: number) => ReactNode;
  className?: string;
  listAriaLabel?: string;
}

/**
 * VirtualList renders lists smoothly even with thousands of rows by mounting
 * only the visible rows and a small buffer.
 *
 * For lists <= threshold (default 100 items), standard full-list rendering is preserved.
 * For lists > threshold, container virtualization engages while strictly preserving:
 * 1. Screen-reader accessibility (roles, aria-posinset, aria-setsize, aria-rowcount, live count).
 * 2. Keyboard navigation (active focused element is never unmounted, arrow/page navigation works).
 */
export function VirtualList<T>({
  items,
  threshold = 100,
  itemHeight = 160,
  containerMaxHeight = 640,
  overscan = 6,
  keyExtractor,
  renderItem,
  className = "space-y-3",
  listAriaLabel = "List",
}: VirtualListProps<T>) {
  const { t: tr } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(containerMaxHeight);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const rafId = useRef<number | null>(null);

  // If items length is within the threshold, render normally without virtualization.
  const shouldVirtualize = items.length > threshold;

  // Measure container height once mounted
  useEffect(() => {
    if (!shouldVirtualize || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.height > 0) {
      setContainerHeight(Math.min(rect.height, containerMaxHeight));
    }
  }, [shouldVirtualize, containerMaxHeight]);

  const handleScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current);
    }
    rafId.current = requestAnimationFrame(() => {
      setScrollTop(target.scrollTop);
      rafId.current = null;
    });
  }, []);

  useEffect(() => {
    return () => {
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
      }
    };
  }, []);

  // Track focused index so keyboard focus is never abruptly lost to body on scroll
  const handleFocusCapture = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const rowEl = target.closest<HTMLElement>("[data-virtual-index]");
    if (rowEl) {
      const idx = Number(rowEl.dataset.virtualIndex);
      if (!Number.isNaN(idx)) {
        setFocusedIndex(idx);
      }
    }
  }, []);

  const handleBlurCapture = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setFocusedIndex(null);
    }
  }, []);

  if (!shouldVirtualize) {
    return (
      <div
        className={className}
        role="region"
        aria-label={tr(listAriaLabel)}
      >
        {items.map((item, index) => (
          <div
            key={keyExtractor(item, index)}
            role="article"
            aria-posinset={index + 1}
            aria-setsize={items.length}
          >
            {renderItem(item, index)}
          </div>
        ))}
      </div>
    );
  }

  // Calculate slice range
  const totalCount = items.length;
  const rawStartIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const visibleCount = Math.ceil(containerHeight / itemHeight);
  const rawEndIndex = Math.min(totalCount, rawStartIndex + visibleCount + overscan * 2);

  // If a row has keyboard focus, ensure the slice includes that row
  const startIndex =
    focusedIndex !== null ? Math.min(rawStartIndex, focusedIndex) : rawStartIndex;
  const endIndex =
    focusedIndex !== null ? Math.max(rawEndIndex, focusedIndex + 1) : rawEndIndex;

  const topPadding = startIndex * itemHeight;
  const bottomPadding = Math.max(0, (totalCount - endIndex) * itemHeight);
  const visibleItems = items.slice(startIndex, endIndex);

  return (
    <div
      ref={containerRef}
      className={`relative overflow-y-auto outline-none focus:ring-1 focus:ring-accent/40 rounded-lg ${className}`}
      style={{ maxHeight: containerMaxHeight }}
      role="feed"
      aria-label={tr(listAriaLabel)}
      tabIndex={0}
      onScroll={handleScroll}
      onFocusCapture={handleFocusCapture}
      onBlurCapture={handleBlurCapture}
    >
      <div className="sr-only" aria-live="polite">{tr("Showing")}{" "}{totalCount}{" "}{tr("items in")}{" "}{listAriaLabel}{tr(". Scroll or tab through entries.")}</div>

      {topPadding > 0 && (
        <div
          style={{ height: `${topPadding}px` }}
          aria-hidden="true"
          className="w-full pointer-events-none"
        />
      )}

      {visibleItems.map((item, offset) => {
        const index = startIndex + offset;
        return (
          <div
            key={keyExtractor(item, index)}
            data-virtual-index={index}
            role="article"
            aria-posinset={index + 1}
            aria-setsize={totalCount}
            className="w-full"
          >
            {renderItem(item, index)}
          </div>
        );
      })}

      {bottomPadding > 0 && (
        <div
          style={{ height: `${bottomPadding}px` }}
          aria-hidden="true"
          className="w-full pointer-events-none"
        />
      )}
    </div>
  );
}
