import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  MagnifyingGlass, ArrowClockwise, SpinnerGap, Check, Plus, GithubLogo,
  X, ArrowRight, Sparkle, ArrowSquareOut,
} from '@phosphor-icons/react'
import { useSessionStore } from '../../stores/sessionStore'
import type { CatalogPlugin, PluginStatus } from '../../../shared/types'

const SIGIL_TONES = ['amber', 'blue', 'green', 'rose', 'violet'] as const
type SigilTone = typeof SIGIL_TONES[number]

const SIGIL_TINTS: Record<SigilTone, string> = {
  amber:  'var(--fs-pastel-amber-bg)',
  blue:   'var(--fs-pastel-blue-bg)',
  green:  'var(--fs-pastel-green-bg)',
  rose:   'var(--fs-pastel-rose-bg)',
  violet: 'var(--fs-pastel-violet-bg)',
}

function hash(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0
  return Math.abs(h)
}

function pickSigilTone(id: string): SigilTone {
  return SIGIL_TONES[hash(id) % SIGIL_TONES.length]
}

function pluginInitials(name: string): string {
  const parts = name.trim().split(/[\s\-_./]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return (name.replace(/[^a-z0-9]/gi, '').slice(0, 2) || '??').toUpperCase()
}

function pad(n: number): string { return String(n).padStart(3, '0') }

export function PluginsView() {
  const catalog = useSessionStore((s) => s.marketplaceCatalog)
  const loading = useSessionStore((s) => s.marketplaceLoading)
  const error = useSessionStore((s) => s.marketplaceError)
  const pluginStates = useSessionStore((s) => s.marketplacePluginStates)
  const search = useSessionStore((s) => s.marketplaceSearch)
  const filter = useSessionStore((s) => s.marketplaceFilter)
  const setSearch = useSessionStore((s) => s.setMarketplaceSearch)
  const setFilter = useSessionStore((s) => s.setMarketplaceFilter)
  const loadMarketplace = useSessionStore((s) => s.loadMarketplace)
  const installPlugin = useSessionStore((s) => s.installMarketplacePlugin)
  const uninstallPlugin = useSessionStore((s) => s.uninstallMarketplacePlugin)

  const [localSearch, setLocalSearch] = useState(search)
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (catalog.length === 0 && !loading) loadMarketplace()
  }, [catalog.length, loading, loadMarketplace])

  useEffect(() => {
    const t = setTimeout(() => setSearch(localSearch), 200)
    return () => clearTimeout(t)
  }, [localSearch, setSearch])

  // ⌘K focuses the search field (doubles as a Raycast-style affordance).
  // Esc closes the detail sheet when one is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      if (e.key === 'Escape' && selectedPluginId) {
        e.preventDefault()
        setSelectedPluginId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedPluginId])

  // Tag rail: tags ordered by frequency, capped, plus a synthetic Installed entry.
  const installedCount = useMemo(
    () => Object.values(pluginStates).filter((s) => s === 'installed').length,
    [pluginStates],
  )
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of catalog) for (const t of (p.tags || [])) m.set(t, (m.get(t) || 0) + 1)
    return m
  }, [catalog])
  const railEntries = useMemo(() => {
    const tags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ key: name, label: name, count, kind: 'tag' as const }))
    return [
      { key: 'All', label: 'All', count: catalog.length, kind: 'all' as const },
      ...tags,
      { key: 'Installed', label: 'Installed', count: installedCount, kind: 'installed' as const },
    ]
  }, [tagCounts, catalog.length, installedCount])

  const lower = (search || '').toLowerCase()
  const filtered = useMemo(() => {
    return catalog.filter((p) => {
      const tags = Array.isArray(p.tags) ? p.tags : []
      const matchSearch = !lower
        || (p.name || '').toLowerCase().includes(lower)
        || (p.description || '').toLowerCase().includes(lower)
        || tags.some((t) => String(t).toLowerCase().includes(lower))
        || (p.author || '').toLowerCase().includes(lower)
      const matchFilter =
        filter === 'All' ||
        (filter === 'Installed' && pluginStates[p.id] === 'installed') ||
        tags.includes(filter)
      return matchSearch && matchFilter
    })
  }, [catalog, lower, filter, pluginStates])

  const showFeatured = !lower && filter === 'All' && catalog.length >= 2 && !loading
  const featured = useMemo(() => (showFeatured ? catalog.slice(0, 2) : []), [showFeatured, catalog])
  const featuredIds = new Set(featured.map((p) => p.id))
  const gridList = useMemo(
    () => filtered.filter((p) => !featuredIds.has(p.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, showFeatured, catalog],
  )

  const clearAll = () => {
    setLocalSearch('')
    setSearch('')
    setFilter('All')
  }

  return (
    <div className="fs-page fs-plugins-page">
      <div className="fs-page-body">
        <div className="fs-plugins-frame">
          <div className="fs-plugins-hero">
            <div className="fs-plugins-hero-left">
              <div className="fs-plugins-eyebrow">
                <span className="fs-plugins-eyebrow-dot" />
                Marketplace · Edition {pad(catalog.length || 0)}
              </div>
              <h1 className="fs-plugins-bigtitle">
                Plugins, <em>skills,</em><br />and tools.
              </h1>
              <p className="fs-plugins-leadcopy">
                Curated extensions for Rax. Browse skills authored by Anthropic and the community,
                install with a single click, and uninstall just as fast.
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 22 }}>
              <div className="fs-plugins-stats">
                <div className="fs-plugins-stat">
                  <div className="fs-plugins-stat-num">{catalog.length}</div>
                  <div className="fs-plugins-stat-label">Available</div>
                </div>
                <div className="fs-plugins-stat-divider" />
                <div className="fs-plugins-stat">
                  <div className="fs-plugins-stat-num is-accent">{installedCount}</div>
                  <div className="fs-plugins-stat-label">Installed</div>
                </div>
              </div>
              <button
                type="button"
                className="fs-plugins-hero-refresh"
                onClick={() => loadMarketplace(true)}
                disabled={loading}
                title="Refresh catalog"
                aria-label="Refresh catalog"
              >
                {loading ? <SpinnerGap size={14} className="fs-pulse" /> : <ArrowClockwise size={14} />}
              </button>
            </div>
          </div>

          {error && (
            <div className="fs-plugins-error" role="alert">
              <span className="fs-plugins-error-glyph">!</span>
              <span>{error}</span>
            </div>
          )}

          <div className="fs-plugins-controls">
            <div className="fs-plugins-rail" role="tablist" aria-label="Plugin categories">
              {railEntries.map((entry) => {
                const active = filter === entry.key
                return (
                  <button
                    key={entry.key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`fs-rail-chip ${active ? 'is-active' : ''}`}
                    onClick={() => setFilter(entry.key)}
                  >
                    {entry.kind === 'installed' && <span className="fs-rail-chip-installed-dot" aria-hidden />}
                    <span>{entry.label}</span>
                    <span className="fs-rail-chip-count">{entry.count}</span>
                  </button>
                )
              })}
            </div>
            <div className="fs-plugins-search-row">
              <div className="fs-search-field">
                <MagnifyingGlass size={14} weight="bold" style={{ color: 'var(--fs-text-tertiary)', flexShrink: 0 }} />
                <input
                  ref={searchRef}
                  value={localSearch}
                  onChange={(e) => setLocalSearch(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape' && localSearch) { e.preventDefault(); setLocalSearch('') } }}
                  placeholder="Search plugins by name, tag, or description"
                  aria-label="Search plugins"
                />
                {localSearch ? (
                  <button
                    type="button"
                    className="fs-search-clear"
                    onClick={() => { setLocalSearch(''); searchRef.current?.focus() }}
                    aria-label="Clear search"
                  >
                    <X size={11} weight="bold" />
                  </button>
                ) : (
                  <span className="fs-search-kbd" aria-hidden>⌘K</span>
                )}
              </div>
            </div>
          </div>

          {loading && catalog.length === 0 ? (
            <SkeletonGrid />
          ) : filtered.length === 0 ? (
            <EmptyState onReset={clearAll} hasFilter={filter !== 'All' || !!lower} />
          ) : (
            <>
              {showFeatured && featured.length > 0 && (
                <div className="fs-plugins-featured" aria-label="Editor's picks">
                  {featured.map((p, i) => (
                    <FeatureCard
                      key={p.id}
                      plugin={p}
                      index={i + 1}
                      status={pluginStates[p.id] || 'not_installed'}
                      onInstall={() => installPlugin(p)}
                      onUninstall={() => uninstallPlugin(p)}
                      onOpen={() => setSelectedPluginId(p.id)}
                    />
                  ))}
                </div>
              )}

              <div className="fs-section-rule" aria-hidden>
                <div className="fs-section-rule-label">
                  {filter === 'All' && !lower
                    ? (showFeatured ? 'All plugins' : 'Catalog')
                    : (lower ? 'Results' : filter)}
                </div>
                <div className="fs-section-rule-line" />
                <div className="fs-section-rule-count">{pad(gridList.length)}</div>
              </div>

              <div className="fs-plugins-grid">
                {gridList.map((p, i) => (
                  <PluginCard
                    key={p.id}
                    plugin={p}
                    index={i + 1}
                    sortIndex={i}
                    status={pluginStates[p.id] || 'not_installed'}
                    onInstall={() => installPlugin(p)}
                    onUninstall={() => uninstallPlugin(p)}
                    onOpen={() => setSelectedPluginId(p.id)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {selectedPluginId && (() => {
        const sel = catalog.find((p) => p.id === selectedPluginId)
        if (!sel) return null
        return (
          <PluginSheet
            plugin={sel}
            status={pluginStates[sel.id] || 'not_installed'}
            onClose={() => setSelectedPluginId(null)}
            onInstall={() => installPlugin(sel)}
            onUninstall={() => uninstallPlugin(sel)}
          />
        )
      })()}
    </div>
  )
}

function CtaButton({
  status, onInstall, onUninstall,
}: { status: PluginStatus; onInstall: () => void; onUninstall: () => void }) {
  if (status === 'installed') {
    return (
      <button
        type="button"
        className="fs-plugin-cta is-installed"
        onClick={(e) => { e.stopPropagation(); onUninstall() }}
        title="Click to uninstall"
      >
        <Check size={11} weight="bold" />
        <span className="fs-plugin-cta-installed-text">Installed</span>
        <span className="fs-plugin-cta-uninstall-text">Uninstall</span>
      </button>
    )
  }
  if (status === 'installing') {
    return (
      <button type="button" className="fs-plugin-cta" disabled>
        <SpinnerGap size={11} className="fs-pulse" /> Installing
      </button>
    )
  }
  if (status === 'failed') {
    return (
      <button
        type="button"
        className="fs-plugin-cta is-failed"
        onClick={(e) => { e.stopPropagation(); onInstall() }}
      >
        Retry
      </button>
    )
  }
  return (
    <button
      type="button"
      className="fs-plugin-cta is-primary"
      onClick={(e) => { e.stopPropagation(); onInstall() }}
    >
      <Plus size={11} weight="bold" /> Install
    </button>
  )
}

function PluginCard({
  plugin, index, sortIndex, status, onInstall, onUninstall, onOpen,
}: {
  plugin: CatalogPlugin
  index: number
  sortIndex: number
  status: PluginStatus
  onInstall: () => void
  onUninstall: () => void
  onOpen: () => void
}) {
  const tone = pickSigilTone(plugin.id)
  const initials = pluginInitials(plugin.name)
  const tags = (plugin.tags || []).slice(0, 3)

  return (
    <article
      className="fs-plugin-card"
      style={{ '--i': sortIndex } as React.CSSProperties}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() }
      }}
      aria-label={`View ${plugin.name} details`}
    >
      <div className="fs-plugin-num">№ {pad(index)}</div>
      <div className="fs-plugin-head">
        <div className={`fs-plugin-sigil fs-plugin-sigil--${tone}`} aria-hidden>
          <span>{initials}</span>
        </div>
        <div className="fs-plugin-id-block">
          <div className="fs-plugin-name" title={plugin.name}>{plugin.name}</div>
          <div className="fs-plugin-meta" title={plugin.repo}>
            <GithubLogo size={11} weight="fill" />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{plugin.repo}</span>
            {plugin.version ? <span style={{ opacity: 0.55 }}>· v{plugin.version}</span> : null}
          </div>
        </div>
      </div>
      <p className="fs-plugin-desc">{plugin.description || 'No description provided.'}</p>
      <div className="fs-plugin-foot">
        {tags.map((tag) => <span key={tag} className="fs-tag">{tag}</span>)}
        <CtaButton status={status} onInstall={onInstall} onUninstall={onUninstall} />
      </div>
    </article>
  )
}

function FeatureCard({
  plugin, index, status, onInstall, onUninstall, onOpen,
}: {
  plugin: CatalogPlugin
  index: number
  status: PluginStatus
  onInstall: () => void
  onUninstall: () => void
  onOpen: () => void
}) {
  const tone = pickSigilTone(plugin.id)
  const initials = pluginInitials(plugin.name)
  const tags = (plugin.tags || []).slice(0, 3)

  return (
    <article
      className="fs-plugin-feature"
      style={{ '--feature-tint': SIGIL_TINTS[tone] } as React.CSSProperties}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() }
      }}
      aria-label={`View ${plugin.name} details`}
    >
      <div className="fs-plugin-feature-ribbon">
        <Sparkle size={11} weight="fill" />
        <span>Editor's pick</span>
        <span className="fs-plugin-feature-ribbon-num">№ {pad(index)}</span>
      </div>
      <div className="fs-plugin-feature-head">
        <div className={`fs-plugin-sigil fs-plugin-sigil--${tone}`} aria-hidden>
          <span>{initials}</span>
        </div>
        <div className="fs-plugin-feature-id">
          <h2 className="fs-plugin-feature-title">{plugin.name}</h2>
          <div className="fs-plugin-feature-meta">
            <GithubLogo size={11} weight="fill" />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{plugin.repo}</span>
            {plugin.version ? <span style={{ opacity: 0.55 }}>· v{plugin.version}</span> : null}
          </div>
        </div>
      </div>
      <p className="fs-plugin-feature-desc">{plugin.description || 'No description provided.'}</p>
      <div className="fs-plugin-feature-foot">
        {tags.map((tag) => <span key={tag} className="fs-tag">{tag}</span>)}
        <CtaButton status={status} onInstall={onInstall} onUninstall={onUninstall} />
      </div>
    </article>
  )
}

function SkeletonGrid() {
  return (
    <div className="fs-plugins-grid" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="fs-plugin-skeleton" style={{ '--i': i } as React.CSSProperties}>
          <div className="fs-skeleton-row">
            <div className="fs-skeleton-block sigil" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fs-skeleton-block line-title" />
              <div className="fs-skeleton-block line-meta" />
            </div>
          </div>
          <div className="fs-skeleton-block line-body" />
          <div className="fs-skeleton-block line-body short" />
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <div className="fs-skeleton-block line-tag" />
            <div className="fs-skeleton-block line-tag" />
          </div>
        </div>
      ))}
    </div>
  )
}

function EmptyState({ onReset, hasFilter }: { onReset: () => void; hasFilter: boolean }) {
  return (
    <div className="fs-plugin-empty">
      <div className="fs-plugin-empty-glyph">?</div>
      <div className="fs-plugin-empty-title">Nothing matches.</div>
      <div className="fs-plugin-empty-body">
        {hasFilter
          ? 'Try a different category, or clear filters to see the full marketplace.'
          : 'The catalog is empty right now. Try refreshing — the marketplace may still be loading.'}
      </div>
      {hasFilter && (
        <div className="fs-plugin-empty-actions">
          <button type="button" className="fs-button" onClick={onReset}>
            <ArrowRight size={12} weight="bold" /> Clear filters
          </button>
        </div>
      )}
    </div>
  )
}

function PluginSheet({
  plugin, status, onClose, onInstall, onUninstall,
}: {
  plugin: CatalogPlugin
  status: PluginStatus
  onClose: () => void
  onInstall: () => void
  onUninstall: () => void
}) {
  const tone = pickSigilTone(plugin.id)
  const initials = pluginInitials(plugin.name)
  const tags = plugin.tags || []
  const repoUrl = plugin.repo ? `https://github.com/${plugin.repo}` : null
  const stopAll = (e: React.MouseEvent) => { e.stopPropagation() }

  return (
    <div
      className="fs-plugin-sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`${plugin.name} details`}
      onClick={onClose}
    >
      <div
        className="fs-plugin-sheet"
        style={{ '--feature-tint': SIGIL_TINTS[tone] } as React.CSSProperties}
        onClick={stopAll}
      >
        <button
          type="button"
          className="fs-plugin-sheet-close"
          onClick={onClose}
          aria-label="Close"
        >
          <X size={13} weight="bold" />
        </button>

        <div className="fs-plugin-sheet-scroll">
          <div className="fs-plugin-sheet-ribbon">
            <Sparkle size={11} weight="fill" />
            <span>{plugin.isSkillMd ? 'Skill' : 'Plugin'}</span>
            {plugin.category && <span className="fs-plugin-sheet-ribbon-num">· {plugin.category}</span>}
          </div>

          <div className="fs-plugin-sheet-head">
            <div className={`fs-plugin-sigil fs-plugin-sigil--${tone}`} aria-hidden>
              <span>{initials}</span>
            </div>
            <div className="fs-plugin-sheet-head-id">
              <h2 className="fs-plugin-sheet-title">{plugin.name}</h2>
              <div className="fs-plugin-sheet-meta">
                <GithubLogo size={12} weight="fill" />
                <span>{plugin.repo}</span>
                {plugin.version && <span style={{ opacity: 0.6 }}>· v{plugin.version}</span>}
                {plugin.author && <span style={{ opacity: 0.6 }}>· {plugin.author}</span>}
              </div>
            </div>
          </div>

          <div className="fs-plugin-sheet-section">
            <div className="fs-plugin-sheet-section-label">Description</div>
            <div className="fs-plugin-sheet-desc">
              {plugin.description || 'No description provided.'}
            </div>
          </div>

          {tags.length > 0 && (
            <div className="fs-plugin-sheet-section">
              <div className="fs-plugin-sheet-section-label">Tags</div>
              <div className="fs-plugin-sheet-tags">
                {tags.map((t) => <span key={t} className="fs-tag">{t}</span>)}
              </div>
            </div>
          )}

          <div className="fs-plugin-sheet-section">
            <div className="fs-plugin-sheet-section-label">Details</div>
            <div className="fs-plugin-sheet-rows">
              <div className="fs-plugin-sheet-row-key">Marketplace</div>
              <div className="fs-plugin-sheet-row-val">{plugin.marketplace}</div>
              <div className="fs-plugin-sheet-row-key">Install name</div>
              <div className="fs-plugin-sheet-row-val">{plugin.installName}</div>
              <div className="fs-plugin-sheet-row-key">Source path</div>
              <div className="fs-plugin-sheet-row-val">{plugin.sourcePath || '—'}</div>
              <div className="fs-plugin-sheet-row-key">Type</div>
              <div className="fs-plugin-sheet-row-val">
                {plugin.isSkillMd ? 'SKILL.md (direct install)' : 'CLI plugin (bundle install)'}
              </div>
            </div>
          </div>
        </div>

        <div className="fs-plugin-sheet-foot">
          <CtaButton status={status} onInstall={onInstall} onUninstall={onUninstall} />
          {repoUrl && (
            <a
              className="fs-plugin-sheet-link"
              href={repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={stopAll}
            >
              <ArrowSquareOut size={12} weight="bold" />
              GitHub
            </a>
          )}
        </div>
      </div>
    </div>
  )
}
