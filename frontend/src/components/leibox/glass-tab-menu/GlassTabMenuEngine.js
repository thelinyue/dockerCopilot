// Adapted from LeiBox GlassTabMenu. Design reference: solutionb. See NOTICE.md.
function stepSpring(state, delta) {
  // 小步积分让低帧率下的弹簧也能稳定收敛，重定向时保留已有速度。
  for (let i = 0; i < 3; i++) {
    const step = delta / 3
    state.v += ((state.target - state.p) * 400 - state.v * 40) * step
    state.p += state.v * step
  }
}

export function mountGlassTabMenu(panel) {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  const opening = { p: 0, v: 0, target: 0 }
  let frame = 0
  let last = 0

  const draw = () => {
    const progress = Math.min(1, Math.max(0, opening.p))
    panel.style.setProperty('--glass-opacity', String(progress))
    panel.style.setProperty('--glass-offset', `${-8 * (1 - progress)}px`)
    panel.style.setProperty('--glass-scale', String(0.94 + 0.06 * progress))
    panel.dataset.moving = String(Boolean(frame))
  }
  const settle = () => {
    cancelAnimationFrame(frame)
    frame = 0
    last = 0
    opening.p = opening.target
    opening.v = 0
    draw()
  }
  const tick = time => {
    frame = 0
    if (media.matches || document.hidden || (!opening.target && getComputedStyle(panel).display === 'none')) {
      settle()
      return
    }
    const delta = Math.min(0.032, (time - (last || time - 16)) / 1000)
    last = time
    stepSpring(opening, delta)
    if (Math.abs(opening.p - opening.target) < 0.001 && Math.abs(opening.v) < 0.01) {
      settle()
      return
    }
    frame = requestAnimationFrame(tick)
    draw()
  }
  const setOpen = value => {
    opening.target = Number(value)
    if (media.matches || document.hidden) settle()
    else if (!frame) {
      last = 0
      frame = requestAnimationFrame(tick)
    }
  }
  const syncMotion = () => { if (media.matches || document.hidden) settle() }
  media.addEventListener('change', syncMotion)
  document.addEventListener('visibilitychange', syncMotion)
  draw()

  return {
    setOpen,
    destroy() {
      cancelAnimationFrame(frame)
      media.removeEventListener('change', syncMotion)
      document.removeEventListener('visibilitychange', syncMotion)
    },
  }
}

export function mountGlassTabDock(navigation) {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  const position = { p: 0, v: 0, target: 0 }
  const width = { p: 0, v: 0, target: 0 }
  const opening = { p: 0, v: 0, target: 0 }
  const tabs = navigation.querySelector('.glass-nav-tabs')
  const indicator = navigation.querySelector('.glass-nav-selection')
  let expandedHeight = 64
  let initialized = false
  let frame = 0
  let last = 0

  const draw = () => {
    navigation.style.setProperty('--glass-selection-x', `${position.p}px`)
    navigation.style.setProperty('--glass-selection-width', `${width.p}px`)
    const travel = Math.min(1, Math.abs(position.v) / Math.max(width.p * 7, 1))
    navigation.style.setProperty('--glass-nav-travel', String(travel))
    // 与上游 draw() 相同，滑动速度控制选中块的透光度及阴影。
    indicator.style.background = `rgba(255,255,255,${0.98 - 0.95 * travel})`
    indicator.style.boxShadow = `0 ${7 - 3 * travel}px ${17 + 5 * travel}px rgba(82,77,99,${0.15 - 0.07 * travel})`
    const progress = Math.min(1, Math.max(0, opening.p))
    // 导航和当前页面操作共用同一个表面，固定底边向上展开，不增加页面占位。
    navigation.style.setProperty('--glass-open', String(progress))
    navigation.style.setProperty('--glass-panel-height', `${64 + (expandedHeight - 64) * progress}px`)
    navigation.style.setProperty('--glass-tabs-opacity', String(Math.max(0, 1 - progress * 2)))
    navigation.style.setProperty('--glass-menu-opacity', String(Math.max(0, (progress - 0.25) / 0.75)))
    navigation.dataset.moving = String(Boolean(frame))
  }
  const settle = () => {
    cancelAnimationFrame(frame)
    frame = 0
    last = 0
    for (const state of [position, width, opening]) { state.p = state.target; state.v = 0 }
    draw()
  }
  const tick = time => {
    frame = 0
    if (media.matches || document.hidden || !navigation.getClientRects().length) { settle(); return }
    const delta = Math.min(0.032, (time - (last || time - 16)) / 1000)
    last = time
    stepSpring(position, delta)
    stepSpring(width, delta)
    stepSpring(opening, delta)
    if ([position, width].every(state => Math.abs(state.p - state.target) < 0.1 && Math.abs(state.v) < 0.1) && Math.abs(opening.p - opening.target) < 0.001 && Math.abs(opening.v) < 0.01) { settle(); return }
    frame = requestAnimationFrame(tick)
    draw()
  }
  const select = (immediate = false) => {
    const selected = navigation.querySelector('[aria-current="page"]')
    if (!selected || !navigation.getClientRects().length) { settle(); return }
    // 测量真实按钮，适应窄屏、安全区和文字大小，不沿用演示中的固定坐标。
    position.target = selected.offsetLeft
    width.target = selected.offsetWidth
    if (immediate || !initialized || media.matches || document.hidden) settle()
    else if (!frame) { last = 0; frame = requestAnimationFrame(tick) }
    initialized = true
  }
  const measureMenu = () => {
    const menu = navigation.querySelector('.glass-actions-grid')
    const surface = navigation.querySelector('.glass-tab-surface')
    // 仅在展开或尺寸变化时测量，单行页面操作不会留下六宫格的空白，也不逐帧触发布局。
    expandedHeight = menu ? menu.offsetHeight + surface.offsetHeight - surface.clientHeight : 64
  }
  const setOpen = open => {
    measureMenu()
    opening.target = Number(open)
    if (media.matches || document.hidden || !navigation.getClientRects().length) settle()
    else if (!frame) { last = 0; frame = requestAnimationFrame(tick) }
  }
  const resize = new ResizeObserver(() => { measureMenu(); select(true) })
  const syncMotion = () => { if (media.matches || document.hidden) settle() }
  resize.observe(tabs)
  media.addEventListener('change', syncMotion)
  document.addEventListener('visibilitychange', syncMotion)
  select(true)

  return {
    select: () => select(),
    setOpen,
    destroy() {
      cancelAnimationFrame(frame)
      resize.disconnect()
      media.removeEventListener('change', syncMotion)
      document.removeEventListener('visibilitychange', syncMotion)
    },
  }
}
