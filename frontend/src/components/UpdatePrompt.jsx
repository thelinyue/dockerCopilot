import React from 'react'
import { Download, RefreshCw } from 'lucide-react'
import { Dialog, Notice } from './ManagementUI.jsx'

export function UpdatePrompt({ isVisible, onClose, backendVersion, remoteVersion, hasBackendUpdate, onUpdateBackend, isUpdating = false, error }) {
  return <Dialog title={hasBackendUpdate ? '有新版本可用' : '版本信息'} open={isVisible} onClose={onClose}>
    <div className="p-5 space-y-3 text-sm">
      <p className="break-words">{backendVersion}{hasBackendUpdate && <span className="text-primary-600 dark:text-primary-400"> → {remoteVersion}</span>}</p>
      <p className="text-gray-500 dark:text-gray-400">{hasBackendUpdate ? '更新完成后服务将重新启动。' : '当前已是最新版本'}</p>
      <Notice>{error}</Notice>
    </div>
    <div className="border-t border-gray-200 dark:border-gray-700 p-4 flex justify-end gap-2">
      <button type="button" className="btn-secondary" onClick={onClose}>稍后</button>
      {hasBackendUpdate && <button type="button" className="btn-primary gap-2 disabled:opacity-50" disabled={isUpdating} onClick={onUpdateBackend}>{isUpdating ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}{isUpdating ? '更新中…' : '立即更新'}</button>}
    </div>
  </Dialog>
}
