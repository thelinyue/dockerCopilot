import React, { createContext, useContext, useEffect, useLayoutEffect, useRef } from 'react'

const BackContext = createContext(null)

export function BackNavigationProvider({ route, onNavigate, children }) {
  const layers = useRef([])
  const layerNumber = useRef(0)
  const skip = useRef(0)
  const navigating = useRef(onNavigate)
  navigating.current = onNavigate
  const currentRoute = useRef(route)
  currentRoute.current = route
  useLayoutEffect(() => {
    const state = history.state
    if (JSON.stringify(state?.dcRoute) === JSON.stringify(route)) return
    const next = { dcRoute: route, dcLayer: null }
    if (!state?.dcRoute) history.replaceState(next, '')
    else history.pushState(next, '')
  }, [route.tab, route.section])

  const register = useRef(null)
  if (!register.current) register.current = close => {
    // 此标识只用于页面返回栈，普通 HTTP 的局域网访问也必须可用。
    const key = `${Date.now()}:${++layerNumber.current}`
    const layer = { key, close, popped: false }
    layers.current.push(layer)
    history.pushState({ ...history.state, dcLayer: key }, '')
    return () => {
      layers.current = layers.current.filter(item => item !== layer)
      if (!layer.popped && history.state?.dcLayer === key) {
        skip.current++
        history.back()
      }
    }
  }

  useEffect(() => {
    const pop = async event => {
      if (skip.current) { skip.current--; return }
      const layer = layers.current.at(-1)
      if (layer) {
        layer.popped = true
        const accepted = await layer.close()
        // 脏文件拒绝关闭时恢复这一层；确认对话框仍沿用同一返回栈。
        if (accepted === false && layers.current.includes(layer)) {
          layer.popped = false
          history.pushState({ dcRoute: currentRoute.current, dcLayer: layer.key }, '')
        }
        return
      }
      if (!event.state?.dcRoute) return
      const accepted = await navigating.current(event.state.dcRoute)
      if (accepted === false) history.pushState({ dcRoute: currentRoute.current, dcLayer: null }, '')
    }
    window.addEventListener('popstate', pop)
    return () => window.removeEventListener('popstate', pop)
  }, [])
  return <BackContext.Provider value={register.current}>{children}</BackContext.Provider>
}

export function useBackLayer(active, onBack) {
  const register = useContext(BackContext)
  const close = useRef(onBack)
  close.current = onBack
  useEffect(() => {
    if (active && register) return register(() => close.current ? close.current() : false)
  }, [active, register])
}
