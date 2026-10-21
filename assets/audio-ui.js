/* global window, document, fetch, setInterval, clearInterval, localStorage */
/**
 * System-audio recording widget.
 *
 * Plain browser script injected into the shell's index page. It is a remote
 * control for the host routes under /dsh-audio: the browser cannot capture
 * system playback itself.
 */
;(function () {
  if (window.__dshAudioUi) return
  window.__dshAudioUi = 1

  var API = '/dsh-audio'
  var POLL_MS = 1000
  var STORAGE_KEY = 'dshAudioWidget.position'

  var state = {
    open: false,
    running: false,
    seconds: 0,
    bytes: 0,
    available: true,
    direction: '',
    files: [],
    error: '',
    busy: false,
    editingDir: false,
    pickerKind: null,
    perRecordingFolder: true,
    lastFile: null,
  }

  // ---------- styles ----------
  var CSS = [
    '#dsh-audio-root{position:fixed;right:20px;bottom:20px;z-index:2147483000;font-family:-apple-system,"SF Pro Text","PingFang SC","Segoe UI",system-ui,sans-serif;font-size:13px;color:#1d1d1f;-webkit-font-smoothing:antialiased}',
    '@media (prefers-color-scheme:dark){#dsh-audio-root{color:#f5f5f7}}',
    '.daw-pill{display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:999px;border:1px solid rgba(0,0,0,.08);background:rgba(255,255,255,.82);backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);box-shadow:0 2px 6px rgba(0,0,0,.06),0 12px 32px rgba(0,0,0,.10);cursor:pointer;user-select:none;transition:transform .18s cubic-bezier(.4,0,.2,1),box-shadow .18s cubic-bezier(.4,0,.2,1)}',
    '@media (prefers-color-scheme:dark){.daw-pill{background:rgba(30,30,32,.82);border-color:rgba(255,255,255,.10);box-shadow:0 2px 6px rgba(0,0,0,.3),0 12px 32px rgba(0,0,0,.4)}}',
    '.daw-pill:hover{transform:translateY(-1px);box-shadow:0 4px 10px rgba(0,0,0,.08),0 16px 40px rgba(0,0,0,.14)}',
    '.daw-dot{width:9px;height:9px;border-radius:50%;background:#c7c7cc;flex:none}',
    '.daw-dot.on{background:#ff3b30;animation:dawPulse 1.4s ease-in-out infinite}',
    '@keyframes dawPulse{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(255,59,48,.5)}50%{opacity:.65;box-shadow:0 0 0 6px rgba(255,59,48,0)}}',
    '.daw-pillText{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.daw-panel{position:absolute;right:0;bottom:52px;width:344px;max-height:min(70vh,560px);display:flex;flex-direction:column;border-radius:16px;border:1px solid rgba(0,0,0,.08);background:rgba(255,255,255,.92);backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);box-shadow:0 8px 24px rgba(0,0,0,.10),0 24px 64px rgba(0,0,0,.16);overflow:hidden;animation:dawIn .2s cubic-bezier(.4,0,.2,1)}',
    '@media (prefers-color-scheme:dark){.daw-panel{background:rgba(28,28,30,.94);border-color:rgba(255,255,255,.10)}}',
    '@keyframes dawIn{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}',
    '@media (prefers-reduced-motion:reduce){.daw-panel,.daw-pill{animation:none;transition:none}}',
    '.daw-head{padding:14px 16px 10px;border-bottom:1px solid rgba(0,0,0,.06);flex:none}',
    '@media (prefers-color-scheme:dark){.daw-head{border-color:rgba(255,255,255,.08)}}',
    '.daw-title{font-size:14px;font-weight:600;display:flex;align-items:center;justify-content:space-between;gap:8px}',
    '.daw-close{border:0;background:transparent;color:#8e8e93;font-size:16px;line-height:1;cursor:pointer;padding:2px 4px;border-radius:6px}',
    '.daw-close:hover{background:rgba(0,0,0,.06)}',
    '.daw-body{padding:14px 16px;overflow-y:auto;display:flex;flex-direction:column;gap:14px}',
    '.daw-timer{font-size:30px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.02em;line-height:1.1}',
    '.daw-sub{font-size:12px;color:#6e6e73;margin-top:4px}',
    '@media (prefers-color-scheme:dark){.daw-sub{color:#a1a1a6}}',
    '.daw-btn{width:100%;height:38px;border-radius:10px;border:1px solid transparent;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .16s cubic-bezier(.4,0,.2,1)}',
    '.daw-btn:disabled{opacity:.45;cursor:default}',
    '.daw-btn.rec{background:#ff3b30;color:#fff}',
    '.daw-btn.rec:hover:not(:disabled){background:#e0342a}',
    '.daw-btn.stop{background:#1d1d1f;color:#fff}',
    '@media (prefers-color-scheme:dark){.daw-btn.stop{background:#f5f5f7;color:#1d1d1f}}',
    '.daw-btn.stop:hover:not(:disabled){opacity:.86}',
    '.daw-field{display:flex;flex-direction:column;gap:6px}',
    '.daw-label{font-size:12px;font-weight:600;color:#6e6e73;text-transform:uppercase;letter-spacing:.03em}',
    '@media (prefers-color-scheme:dark){.daw-label{color:#a1a1a6}}',
    '.daw-dirRow{display:flex;gap:6px}',
    '.daw-input{flex:1;min-width:0;height:32px;border-radius:8px;border:1px solid rgba(0,0,0,.12);background:rgba(0,0,0,.03);padding:0 10px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:inherit}',
    '@media (prefers-color-scheme:dark){.daw-input{border-color:rgba(255,255,255,.14);background:rgba(255,255,255,.06)}}',
    '.daw-input:focus{outline:none;border-color:#0071e3;box-shadow:0 0 0 3px rgba(0,113,227,.2)}',
    '.daw-mini{height:32px;padding:0 12px;border-radius:8px;border:1px solid rgba(0,0,0,.12);background:transparent;font-size:12px;font-weight:600;cursor:pointer;color:inherit;font-family:inherit;white-space:nowrap}',
    '.daw-mini:hover:not(:disabled){background:rgba(0,0,0,.05)}',
    '@media (prefers-color-scheme:dark){.daw-mini{border-color:rgba(255,255,255,.14)}.daw-mini:hover:not(:disabled){background:rgba(255,255,255,.08)}}',
    '.daw-mini:disabled{opacity:.45;cursor:default}',
    '.daw-toggle{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;font-size:12px;color:#1d1d1f}',
    '@media (prefers-color-scheme:dark){.daw-toggle{color:#f5f5f7}}',
    '.daw-toggle input{width:14px;height:14px;margin:0;accent-color:#0071e3;cursor:pointer}',
    '.daw-toggleHint{font-size:11px;color:#8e8e93;padding-left:22px;margin-top:2px}',
    '.daw-files{display:flex;flex-direction:column;gap:4px;max-height:180px;overflow-y:auto}',
    '.daw-file{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;background:rgba(0,0,0,.03);font-size:12px}',
    '@media (prefers-color-scheme:dark){.daw-file{background:rgba(255,255,255,.05)}}',
    '.daw-fileName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
    '.daw-fileMeta{color:#8e8e93;flex:none;font-variant-numeric:tabular-nums}',
    '.daw-tag{flex:none;font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;background:rgba(52,199,89,.16);color:#248a3d}',
    '@media (prefers-color-scheme:dark){.daw-tag{background:rgba(48,209,88,.2);color:#30d158}}',
    '.daw-tagSilent{background:rgba(142,142,147,.18);color:#6e6e73}',
    '@media (prefers-color-scheme:dark){.daw-tagSilent{background:rgba(161,161,166,.22);color:#a1a1a6}}',
    '.daw-err{padding:8px 10px;border-radius:8px;background:rgba(255,59,48,.1);color:#c9271e;font-size:12px;line-height:1.45;word-break:break-word}',
    '@media (prefers-color-scheme:dark){.daw-err{background:rgba(255,69,58,.14);color:#ff6961}}',
    '.daw-empty{color:#8e8e93;font-size:12px;padding:4px 0}',
    '.daw-meta{font-size:11px;color:#8e8e93;font-variant-numeric:tabular-nums}',
  ].join('\n')

  function injectCss() {
    if (document.getElementById('dsh-audio-style')) return
    var el = document.createElement('style')
    el.id = 'dsh-audio-style'
    el.textContent = CSS
    ;(document.head || document.documentElement).appendChild(el)
  }

  // ---------- helpers ----------
  function h(tag, cls, text) {
    var node = document.createElement(tag)
    if (cls) node.className = cls
    if (text != null) node.textContent = String(text)
    return node
  }

  function fmtClock(seconds) {
    var s = Math.max(0, Math.floor(seconds))
    var m = Math.floor(s / 60)
    var r = s % 60
    return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r
  }

  function fmtBytes(n) {
    if (!n) return '0 B'
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'
    return (n / 1024 / 1024).toFixed(1) + ' MB'
  }

  function api(pathname, body) {
    var opts = { cache: 'no-store' }
    if (body !== undefined) {
      opts.method = 'POST'
      opts.headers = { 'Content-Type': 'application/json' }
      opts.body = JSON.stringify(body)
    }
    return fetch(API + pathname, opts).then(function (r) {
      return r.json().then(
        function (data) {
          if (!r.ok || data.ok === false) throw new Error(data.error || 'HTTP ' + r.status)
          return data
        },
        function () {
          throw new Error('HTTP ' + r.status)
        }
      )
    })
  }

  // ---------- render ----------
  var root, pillDot, pillText, panel

  function build() {
    root = h('div')
    root.id = 'dsh-audio-root'

    var pill = h('div', 'daw-pill')
    pillDot = h('span', 'daw-dot')
    pillText = h('span', 'daw-pillText', '录系统声音')
    pill.appendChild(pillDot)
    pill.appendChild(pillText)
    pill.addEventListener('click', function () {
      state.open = !state.open
      paint()
      if (state.open) refresh()
    })

    panel = h('div', 'daw-panel')
    panel.style.display = 'none'

    root.appendChild(panel)
    root.appendChild(pill)
    document.body.appendChild(root)

    restorePosition(root)
    makeDraggable(pill, root)
  }

  function restorePosition(el) {
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
      if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
        el.style.left = saved.left + 'px'
        el.style.top = saved.top + 'px'
        el.style.right = 'auto'
        el.style.bottom = 'auto'
      }
    } catch (e) {
      /* ignore */
    }
  }

  function makeDraggable(handle, el) {
    var dragging = false
    var startX = 0
    var startY = 0
    var originLeft = 0
    var originTop = 0
    var moved = false

    handle.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return
      var rect = el.getBoundingClientRect()
      dragging = true
      moved = false
      startX = ev.clientX
      startY = ev.clientY
      originLeft = rect.left
      originTop = rect.top
      handle.setPointerCapture(ev.pointerId)
    })

    handle.addEventListener('pointermove', function (ev) {
      if (!dragging) return
      var dx = ev.clientX - startX
      var dy = ev.clientY - startY
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true
      var left = Math.min(window.innerWidth - 60, Math.max(0, originLeft + dx))
      var top = Math.min(window.innerHeight - 40, Math.max(0, originTop + dy))
      el.style.left = left + 'px'
      el.style.top = top + 'px'
      el.style.right = 'auto'
      el.style.bottom = 'auto'
    })

    handle.addEventListener('pointerup', function (ev) {
      if (!dragging) return
      dragging = false
      try {
        handle.releasePointerCapture(ev.pointerId)
      } catch (e) {
        /* ignore */
      }
      if (moved) {
        try {
          var rect = el.getBoundingClientRect()
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ left: rect.left, top: rect.top }))
        } catch (e) {
          /* ignore */
        }
      }
    })
  }

  function paint() {
    pillDot.className = 'daw-dot' + (state.running ? ' on' : '')
    pillText.textContent = state.running ? fmtClock(state.seconds) : '录系统声音'
    panel.style.display = state.open ? 'flex' : 'none'
    if (!state.open) return
    renderPanel()
  }

  function renderPanel() {
    panel.textContent = ''

    var head = h('div', 'daw-head')
    var title = h('div', 'daw-title')
    title.appendChild(h('span', null, '系统声音录制'))
    var close = h('button', 'daw-close', '\u00d7')
    close.title = '收起'
    close.addEventListener('click', function () {
      state.open = false
      paint()
    })
    title.appendChild(close)
    head.appendChild(title)
    panel.appendChild(head)

    var body = h('div', 'daw-body')

    // timer
    var timer = h('div', 'daw-timer', fmtClock(state.seconds))
    body.appendChild(timer)
    var sub = h('div', 'daw-sub')
    if (state.running) {
      sub.textContent = '正在录制 · ' + fmtBytes(state.bytes)
    } else if (state.lastFile) {
      sub.textContent = '上次：' + state.lastFile.name + ' · ' + fmtBytes(state.lastFile.bytes)
    } else {
      sub.textContent = state.available ? '就绪' : '采集程序缺失'
    }
    body.appendChild(sub)

    // record button
    var btn = h('button', 'daw-btn ' + (state.running ? 'stop' : 'rec'), state.running ? '结束录制' : '开始录制')
    btn.disabled = !state.available || state.busy
    btn.addEventListener('click', function () {
      btn.disabled = true
      state.error = ''
      var action = state.running ? api('/stop.json', {}) : api('/start.json', { maxSeconds: 3600 })
      action
        .then(function () {
          return refresh()
        })
        .catch(function (err) {
          state.error = err.message
          paint()
        })
    })
    body.appendChild(btn)

    // storage directory
    var field = h('div', 'daw-field')
    field.appendChild(h('div', 'daw-label', '存放位置'))

    var row = h('div', 'daw-dirRow')
    if (state.editingDir) {
      // Manual entry is the fallback, not the primary path: the host normally
      // supplies an OS folder chooser (see pickerKind below).
      var input = h('input', 'daw-input')
      input.type = 'text'
      input.value = state.direction
      input.spellcheck = false
      row.appendChild(input)

      var save = h('button', 'daw-mini', '保存')
      save.addEventListener('click', function () {
        var next = input.value.trim()
        if (!next) return
        save.disabled = true
        api('/dir.json', { dir: next })
          .then(function (data) {
            state.direction = data.direction
            state.editingDir = false
            state.error = ''
            return refresh()
          })
          .catch(function (err) {
            state.error = err.message
            save.disabled = false
            paint()
          })
      })
      row.appendChild(save)

      var cancel = h('button', 'daw-mini', '取消')
      cancel.addEventListener('click', function () {
        state.editingDir = false
        paint()
      })
      row.appendChild(cancel)
    } else {
      var display = h('input', 'daw-input')
      display.type = 'text'
      display.value = state.direction || '(未设置)'
      display.readOnly = true
      row.appendChild(display)

      // Primary action: ask the host to open its own chooser. The picker seam
      // is optional, so a composition without a backend hides this button.
      if (state.pickerKind === 'native') {
        var pick = h('button', 'daw-mini', '选择…')
        pick.addEventListener('click', function () {
          pick.disabled = true
          pick.textContent = '…'
          api('/pick.json', {})
            .then(function (data) {
              if (data.canceled) {
                pick.disabled = false
                pick.textContent = '选择…'
                return null
              }
              state.direction = data.direction || state.direction
              state.error = ''
              return refresh()
            })
            .catch(function (err) {
              state.error = err.message
              pick.disabled = false
              pick.textContent = '选择…'
              paint()
            })
        })
        row.appendChild(pick)
      }

      // Keyboard-free entry stays available, tucked behind a smaller control.
      var edit = h('button', 'daw-mini', state.pickerKind === 'native' ? '粘贴' : '更改')
      edit.title = '手动输入路径'
      edit.addEventListener('click', function () {
        state.editingDir = true
        paint()
      })
      row.appendChild(edit)
    }
    field.appendChild(row)

    if (state.pickerKind === 'browse') {
      field.appendChild(h('div', 'daw-meta', '此宿主使用应用内目录浏览；可手动输入路径。'))
    }
    body.appendChild(field)

    // per-recording subfolder toggle
    var toggleRow = h('label', 'daw-toggle')
    var checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = state.perRecordingFolder !== false
    checkbox.disabled = state.running
    checkbox.addEventListener('change', function () {
      var next = checkbox.checked
      checkbox.disabled = true
      api('/settings.json', { perRecordingFolder: next })
        .then(function (data) {
          state.perRecordingFolder = data.perRecordingFolder
          state.error = ''
          // refresh() repaints the panel, which rebuilds this control from the
          // new state — so re-enabling here only matters if the repaint is
          // skipped, but leaving it disabled would strand the user.
          checkbox.disabled = false
          return refresh()
        })
        .catch(function (err) {
          // Put the box back where it was so the UI never lies about the state.
          checkbox.checked = !next
          state.error = err.message
          checkbox.disabled = false
          paint()
        })
    })
    toggleRow.appendChild(checkbox)
    toggleRow.appendChild(document.createTextNode('每次录音新建独立文件夹'))
    body.appendChild(toggleRow)

    if (state.running) {
      body.appendChild(h('div', 'daw-toggleHint', '录制中无法更改'))
    }

    // files
    var filesLabel = h('div', 'daw-label', '已录文件')
    body.appendChild(filesLabel)

    var list = h('div', 'daw-files')
    if (!state.files.length) {
      list.appendChild(h('div', 'daw-empty', '这个目录里还没有录音'))
    } else {
      state.files.slice(0, 12).forEach(function (file) {
        var item = h('div', 'daw-file')
        // Grouped recordings all share the filename system-audio.wav, so the
        // folder is the only thing that tells them apart.
        var nameEl = h('span', 'daw-fileName', file.folder || file.name)
        if (file.silent) nameEl.style.opacity = '.55'
        item.appendChild(nameEl)
        if (file.silent) {
          // The file is a valid WAV, just empty — say so rather than letting the
          // user open it and conclude the recording is broken.
          item.appendChild(h('span', 'daw-tag daw-tagSilent', '无声'))
        } else if (file.transcript) {
          item.appendChild(h('span', 'daw-tag', '转写'))
        }
        item.appendChild(h('span', 'daw-fileMeta', fmtBytes(file.bytes)))
        item.title = file.silent ? file.path + '（录制期间没有检测到声音）' : file.path
        list.appendChild(item)
      })
    }
    body.appendChild(list)

    if (state.error) body.appendChild(h('div', 'daw-err', state.error))
    if (state.busy) body.appendChild(h('div', 'daw-meta', '正在转写…'))

    panel.appendChild(body)
  }

  // ---------- polling ----------
  var timer = null
  var inFlight = false
  var pickerProbed = false

  // The host may mount the picker backend slightly after the widget boots, so a
  // null answer is retried once per panel open rather than cached forever.
  function probePicker() {
    if (pickerProbed && state.pickerKind) return Promise.resolve()
    return api('/picker.json')
      .then(function (data) {
        state.pickerKind = data.kind || null
        pickerProbed = true
      })
      .catch(function () {
        state.pickerKind = null
      })
  }

  function refresh() {
    if (inFlight) return Promise.resolve()
    inFlight = true
    return Promise.all([api('/status.json'), probePicker()])
      .then(function (results) {
        var data = results[0]
        state.available = data.status.available
        state.running = data.status.running
        state.seconds = data.status.seconds
        state.bytes = data.status.bytes
        state.lastFile = data.status.last || null
        state.direction = data.direction || ''
        state.files = data.files || []
        state.busy = !!data.busy
        if (typeof data.perRecordingFolder === 'boolean') {
          state.perRecordingFolder = data.perRecordingFolder
        }
        // A successful poll clears a stale failure. Without this a single
        // transient error sticks to the panel until the page is reloaded,
        // which makes a healthy host look broken.
        state.error = ''
        paint()
      })
      .catch(function (err) {
        state.error = err.message
        paint()
      })
      .then(function () {
        inFlight = false
      })
  }

  function startPolling() {
    if (timer) return
    timer = setInterval(function () {
      if (state.open || state.running) refresh()
    }, POLL_MS)
  }

  // ---------- boot ----------
  function boot() {
    injectCss()
    build()
    refresh().then(startPolling, startPolling)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true })
  } else {
    boot()
  }
})()
