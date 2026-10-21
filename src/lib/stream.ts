"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type StreamEvent } from "./api";

/**
 * Options for the SSE stream hook.
 */
export interface UseStreamOptions {
  /** The wallet address to stream updates for. */
  address: string | null;
  /** Whether the address is a subscriber or merchant. */
  role: "subscriber" | "merchant";
  /** Called when a stream event is received. */
  onEvent: (event: StreamEvent) => void;
  /** Whether the stream should be active. */
  enabled?: boolean;
}

/**
 * Manages an SSE connection to the backend with automatic reconnection
 * and tab visibility handling.
 *
 * - Opens the stream when `enabled` is true and `address` is set
 * - Reconnects with exponential backoff on disconnect
 * - Closes the stream when the tab is hidden
 * - Does nothing when the API is not configured (contract-only mode)
 */
export function useStream({
  address,
  role,
  onEvent,
  enabled = true,
}: UseStreamOptions): { connected: boolean; error: string | null } {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const visibilityListenerRef = useRef<((event: Event) => void) | null>(null);

  // Refs for callbacks that call each other (avoid circular deps)
  const openRef = useRef<(() => void) | null>(null);
  const scheduleReconnectRef = useRef<(() => void) | null>(null);

  // Clean up on unmount or when address/role/enabled changes
  const close = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
      setConnected(false);
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    reconnectAttemptRef.current = 0;
    const listener = visibilityListenerRef.current;
    if (listener) {
      document.removeEventListener("visibilitychange", listener);
      visibilityListenerRef.current = null;
    }
  }, []);

  // Handle visibility change: close stream when tab is hidden, reopen when visible
  const handleVisibilityChange = useCallback((_event: Event) => {
    void _event; // suppress unused warning
    if (document.visibilityState === "hidden") {
      close();
    } else if (enabled && address && api.isConfigured() && !eventSourceRef.current) {
      // Reopen when tab becomes visible again
      openRef.current?.();
    }
  }, [address, enabled, close]);

  // Schedule a reconnect with exponential backoff
  const scheduleReconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) return; // already scheduled

    const attempt = reconnectAttemptRef.current;
    const delayMs = Math.min(250 * 2 ** attempt, 10_000); // 250ms, 500ms, 1s, 2s... max 10s
    const jitter = Math.random() * delayMs;
    const totalDelay = delayMs + jitter;

    reconnectTimeoutRef.current = setTimeout(() => {
      reconnectTimeoutRef.current = null;
      reconnectAttemptRef.current += 1;
      openRef.current?.();
    }, totalDelay);
  }, []);

  // The two callback refs are mirrored in effects, not written during render
  // (react-hooks/refs). Every consumer — the timers, the EventSource handlers
  // and the open/close effect at the bottom of this hook — runs after effects
  // flush, and these effects are declared before that one, so mount order is
  // unchanged.
  useEffect(() => {
    scheduleReconnectRef.current = scheduleReconnect;
  }, [scheduleReconnect]);

  // Open the SSE connection
  const openConnection = useCallback(() => {
    if (!address || !enabled || !api.isConfigured()) return;

    const es = api.stream(address, role);
    if (!es) {
      setError("EventSource not available");
      return;
    }

    eventSourceRef.current = es;

    es.onopen = () => {
      setConnected(true);
      setError(null);
      reconnectAttemptRef.current = 0;
    };

    es.onmessage = (evt) => {
      try {
        const event = JSON.parse(evt.data) as StreamEvent;
        onEvent(event);
      } catch {
        // Ignore malformed messages
      }
    };

    es.onerror = () => {
      // EventSource fires onerror for both connection errors and when the
      // server closes the connection. We treat both as a disconnect and
      // schedule a reconnect unless the stream was intentionally closed.
      if (eventSourceRef.current === es) {
        setConnected(false);
        es.close();
        eventSourceRef.current = null;

        if (enabled && address && api.isConfigured()) {
          scheduleReconnectRef.current?.();
        }
      }
    };
  }, [address, role, enabled, onEvent]);
  useEffect(() => {
    openRef.current = openConnection;
  }, [openConnection]);

  // Open/close based on enabled, address, and API configuration
  useEffect(() => {
    if (enabled && address && api.isConfigured()) {
      openRef.current?.();

      // Listen for visibility changes
      visibilityListenerRef.current = handleVisibilityChange;
      document.addEventListener("visibilitychange", handleVisibilityChange);
    } else {
      close();
    }

    return () => {
      close();
      const listener = visibilityListenerRef.current;
      if (listener) {
        document.removeEventListener("visibilitychange", listener);
      }
    };
  }, [address, role, enabled, close, handleVisibilityChange]);

  return { connected, error };
}