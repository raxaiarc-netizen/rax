import React, { useCallback } from 'react'
import { Folder, FolderOpen, Plus, X, Terminal } from '@phosphor-icons/react'
import { useSessionStore } from '../../stores/sessionStore'

export function ProjectView() {
  const tab = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const setBaseDirectory = useSessionStore((s) => s.setBaseDirectory)
  const addDirectory = useSessionStore((s) => s.addDirectory)
  const removeDirectory = useSessionStore((s) => s.removeDirectory)
  const staticInfo = useSessionStore((s) => s.staticInfo)

  const handleChooseFolder = useCallback(async () => {
    const dir = await window.rax.selectDirectory()
    if (dir) setBaseDirectory(dir)
  }, [setBaseDirectory])

  const handleAddExtra = useCallback(async () => {
    const dir = await window.rax.selectDirectory()
    if (dir) addDirectory(dir)
  }, [addDirectory])

  const handleOpenInTerminal = useCallback(() => {
    if (!tab) return
    window.rax.openInTerminal(tab.claudeSessionId, tab.workingDirectory).catch(() => {})
  }, [tab])

  const baseDir = tab?.hasChosenDirectory
    ? tab.workingDirectory
    : (staticInfo?.homePath || tab?.workingDirectory || '~')

  return (
    <div className="fs-page">
      <div className="fs-page-header">
        <div>
          <div className="fs-page-title">Project</div>
          <div className="fs-page-subtitle">Working directory and additional folders for the active chat.</div>
        </div>
      </div>

      <div className="fs-page-body">
        <div className="fs-settings-section">
          <div className="fs-settings-section-title">Working directory</div>
          <div className="fs-settings-section-desc">
            The folder Rax reads and edits during this session.
          </div>
          <div className="fs-folder-row">
            <FolderOpen size={14} />
            <span style={{
              flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {baseDir}
            </span>
            <button className="fs-button" onClick={handleChooseFolder}>
              <Folder size={12} /> Choose…
            </button>
            {tab?.hasChosenDirectory && (
              <button className="fs-button" onClick={handleOpenInTerminal} title="Open in Terminal.app">
                <Terminal size={12} /> Terminal
              </button>
            )}
          </div>
        </div>

        <div className="fs-settings-section">
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <div>
              <div className="fs-settings-section-title">Additional directories</div>
              <div className="fs-settings-section-desc">
                Extra folders Claude can read and edit (passed via <code style={{
                  fontFamily: 'var(--fs-font-mono)', fontSize: 11,
                  background: 'var(--fs-surface-hover)', padding: '1px 5px', borderRadius: 3,
                  border: '1px solid var(--fs-border)',
                }}>--add-dir</code>).
              </div>
            </div>
            <button className="fs-button" onClick={handleAddExtra}>
              <Plus size={12} weight="bold" /> Add folder
            </button>
          </div>

          {(tab?.additionalDirs || []).length === 0 ? (
            <div className="fs-empty-card">No additional directories yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {tab!.additionalDirs.map((d) => (
                <div key={d} className="fs-folder-row">
                  <Folder size={13} />
                  <span style={{
                    flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {d}
                  </span>
                  <button
                    className="fs-icon-btn"
                    onClick={() => removeDirectory(d)}
                    title="Remove"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
