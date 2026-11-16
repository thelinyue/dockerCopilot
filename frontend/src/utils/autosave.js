import { changedFields } from './settings.js'

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// 每组只保留最新输入，请求串行；已确认值只用于当前编辑，不进入查询缓存。
export function createAutosave({ initial, save, onSaved }) {
  let saved = initial
  let running = null
  let disposed = false
  let didSave = false
  const edits = new Map()
  const focused = new Set()
  const composing = new Set()
  const listeners = new Set()
  const changes = entry => entry.uncertain ? { ...entry.values } : changedFields(entry.accepted, entry.values)
  const pending = entry => Object.keys(changes(entry)).length > 0
  const cleanup = (group, entry) => {
    if (!entry.inFlight && !pending(entry) && !focused.has(group) && !composing.has(group)) {
      clearTimeout(entry.timer)
      edits.delete(group)
    }
  }
  const snapshot = () => ({
    form: saved && Object.assign({}, saved, ...Array.from(edits.values(), entry => entry.values)),
    dirty: Array.from(edits.values()).some(entry => entry.inFlight || pending(entry)),
    saving: !!running,
    didSave,
    errors: Array.from(edits, ([group, entry]) => ({ group, message: entry.error })).filter(error => error.message),
  })
  const emit = () => { if (!disposed) listeners.forEach(listener => listener(snapshot())) }

  const drain = () => {
    if (running || disposed) return running
    // 先登记 Promise，再开始请求，连续事件与 flush 会等待同一条保存队列。
    running = Promise.resolve().then(async () => {
      while (!disposed) {
        const next = Array.from(edits).find(([group, entry]) => entry.ready && !composing.has(group))
        if (!next) break
        const [group, entry] = next
        entry.ready = false
        const patch = changes(entry)
        if (!Object.keys(patch).length) { cleanup(group, entry); continue }
        const submitted = { ...entry.values }
        entry.inFlight = true
        emit()
        try {
          const publicValue = await save(patch, group)
          if (disposed) return
          saved = publicValue
          entry.uncertain = false
          Object.assign(entry.accepted, submitted)
          entry.error = ''
          didSave = true
          onSaved?.(group)
        } catch (error) {
          if (disposed) return
          // 断网或超时可能发生在服务端已写入之后；即使改回原值，也必须再次确认写入。
          if (error.uncertain) entry.uncertain = true
          // 旧请求失败不能把后来已经修改的输入标成失败，也不能无限重试同一值。
          if (same(entry.values, submitted)) entry.error = error.message || '保存设置失败，请重试。'
        } finally {
          entry.inFlight = false
        }
        cleanup(group, entry)
        emit()
      }
    }).finally(() => {
      running = null
      emit()
    })
    emit()
    return running
  }
  const ready = (group, entry) => {
    clearTimeout(entry.timer)
    entry.timer = null
    if (composing.has(group)) return
    entry.ready = true
    drain()
  }
  const controller = {
    snapshot,
    subscribe(listener) {
      // 开发环境 StrictMode 会重新挂载 effect，需要恢复同一个控制器的订阅。
      disposed = false
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    sync(value) {
      saved = value
      emit()
    },
    change(group, values, delay = 0) {
      if (disposed || !saved) return
      let entry = edits.get(group)
      if (!entry) {
        entry = { values: {}, accepted: {}, ready: false, inFlight: false, error: '', timer: null }
        edits.set(group, entry)
      }
      for (const key of Object.keys(values)) {
        if (!(key in entry.accepted)) entry.accepted[key] = saved[key]
      }
      Object.assign(entry.values, values)
      entry.error = ''
      entry.ready = false
      clearTimeout(entry.timer)
      if (!entry.inFlight && !pending(entry)) cleanup(group, entry)
      else if (!composing.has(group)) {
        if (delay) entry.timer = setTimeout(() => ready(group, entry), delay)
        else ready(group, entry)
      }
      emit()
    },
    focus(group) { focused.add(group) },
    blur(group) {
      focused.delete(group)
      const entry = edits.get(group)
      if (entry) cleanup(group, entry)
      emit()
      return controller.flush(group)
    },
    compose(group, active) {
      const entry = edits.get(group)
      if (active) {
        composing.add(group)
        if (entry) { clearTimeout(entry.timer); entry.ready = false }
      } else {
        composing.delete(group)
        if (entry && pending(entry)) entry.timer = setTimeout(() => ready(group, entry), 500)
      }
    },
    async flush(group) {
      for (const [key, entry] of edits) {
        if (group !== undefined && key !== group) continue
        clearTimeout(entry.timer)
        if (!entry.error && !composing.has(key)) entry.ready = true
      }
      await drain()
      return !Array.from(edits).some(([key, entry]) => (group === undefined || key === group) && (entry.inFlight || pending(entry)))
    },
    retry(group) {
      for (const [key, entry] of edits) {
        if ((group === undefined || key === group) && entry.error) {
          entry.error = ''
          ready(key, entry)
        }
      }
      emit()
      return drain()
    },
    dispose() {
      disposed = true
      edits.forEach(entry => clearTimeout(entry.timer))
      edits.clear()
      focused.clear()
      composing.clear()
      listeners.clear()
    },
  }
  return controller
}
