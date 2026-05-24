import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'

const HEALTH_POLL_INTERVAL_MS = 2500

/**
 * Health reconciliation loop: periodically compares running tabs
 * against backend health and unsticks UI when external CLI/session
 * changes happen.
 *
 * Only polls while there's at least one running/connecting tab — subscribes
 * to the store to start/stop the timer on state transitions so we don't burn
 * an IPC + getState() round-trip every 1.5s when the app is idle.
 */
export function useHealthReconciliation() {
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null

    const poll = async () => {
      const { tabs } = useSessionStore.getState()
      const runningTabs = tabs.filter(
        (t) => (t.status === 'running' || t.status === 'connecting') && t.activeRequestId
      )
      if (runningTabs.length === 0) return

      try {
        const health = await window.rax.tabHealth()
        if (!health?.tabs || !Array.isArray(health.tabs)) return

        const stateByTab = new Map(
          health.tabs.map((h) => [h.tabId, h])
        )

        // Build updated tabs, tracking whether anything actually changed
        const { tabs: currentTabs } = useSessionStore.getState()
        let changed = false
        const newTabs = currentTabs.map((t) => {
          if (t.status !== 'running' && t.status !== 'connecting') return t

          const healthEntry = stateByTab.get(t.id)
          if (!healthEntry) return t

          // Backend says dead but UI thinks it's running → unstick
          if (healthEntry.status === 'dead') {
            changed = true
            return { ...t, status: 'dead' as const, currentActivity: 'Session ended', activeRequestId: null }
          }

          // Backend says idle but UI thinks it's running → unstick
          if (healthEntry.status === 'idle' && !healthEntry.alive) {
            changed = true
            return { ...t, status: 'completed' as const, currentActivity: '', activeRequestId: null }
          }

          // Backend says failed → unstick
          if (healthEntry.status === 'failed') {
            changed = true
            return { ...t, status: 'failed' as const, currentActivity: '', activeRequestId: null }
          }

          return t
        })

        // Only write state when something actually changed
        if (changed) {
          useSessionStore.setState({ tabs: newTabs })
        }
      } catch {
        // Ignore transient health check errors
      }
    }

    const hasRunning = (): boolean => {
      const { tabs } = useSessionStore.getState()
      return tabs.some(
        (t) => (t.status === 'running' || t.status === 'connecting') && t.activeRequestId
      )
    }
    const ensureRunning = () => {
      if (!timer && hasRunning()) {
        timer = setInterval(poll, HEALTH_POLL_INTERVAL_MS)
      } else if (timer && !hasRunning()) {
        clearInterval(timer)
        timer = null
      }
    }
    ensureRunning()
    const unsub = useSessionStore.subscribe(ensureRunning)

    return () => {
      unsub()
      if (timer) clearInterval(timer)
    }
  }, [])
}
