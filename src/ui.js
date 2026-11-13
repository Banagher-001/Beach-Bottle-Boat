const CONTROL_FORMATS = {
  waveHeight: (v) => Math.round(v) + '%',
  waveSpeed: (v) => v.toFixed(2) + '×',
  waveDensity: (v) => v.toFixed(2) + '×',
  waveDirection: (v) => Math.round(v) + '°',
  waterLevel: (v) => Math.round(v) + '%',
  boatResponse: (v) => Math.round(v) + '%',
  boatDamping: (v) => Math.round(v) + '%',
  wind: (v) => Math.round(v) + '%',
  pixelScale: (v) => v.toFixed(1) + '×',
  sunset: (v) => Math.round(v) + '%',
  brightness: (v) => v.toFixed(2) + '×',
  glassOpacity: (v) => Math.round(v * 100) + '%'
};

const ACTION_HANDLERS = ['reset', 'resetCamera', 'screenshot', 'undoProp', 'resetProps'];

export function createUI({ state, actions = {} }) {
  const sliders = new Map();
  const outputs = new Map();
  const toggles = new Map();
  const qualityButtons = Array.from(document.querySelectorAll('[data-quality]'));
  const presetButtons = Array.from(document.querySelectorAll('[data-preset]'));
  const editButtons = Array.from(document.querySelectorAll('[data-edit]'));
  const pauseButton = document.getElementById('pause-button');
  const pauseLabel = document.getElementById('pause-label');
  const panel = document.getElementById('control-panel');
  const toast = document.getElementById('toast');
  const loader = document.getElementById('loader');
  const loaderBar = document.getElementById('loader-bar');
  const loaderText = document.getElementById('loader-text');
  const loaderError = document.getElementById('loader-error');
  const fpsValue = document.getElementById('fps-value');
  const resolutionValue = document.getElementById('resolution-value');
  const waveReadout = document.getElementById('wave-readout');
  const restoreUI = document.getElementById('restore-ui');
  const editBanner = document.getElementById('edit-banner');

  let toastTimer = null;
  let uiHidden = false;
  let panelCollapsed = false;

  function fillFor(input, value) {
    const min = parseFloat(input.min);
    const max = parseFloat(input.max);
    const ratio = max > min ? (value - min) / (max - min) : 0;
    input.style.setProperty('--fill', (Math.max(0, Math.min(1, ratio)) * 100).toFixed(2) + '%');
  }

  function updateOutput(name, value) {
    const el = outputs.get(name);
    if (!el) return;
    const formatter = CONTROL_FORMATS[name] || ((v) => String(v));
    el.textContent = formatter(value);
  }

  function setControlValue(name, value, notify = false) {
    const input = sliders.get(name);
    if (!input) return;
    const numeric = parseFloat(value);
    if (!Number.isFinite(numeric)) return;
    input.value = String(numeric);
    fillFor(input, numeric);
    updateOutput(name, numeric);
    if (name === 'waveHeight') {
      if (waveReadout) waveReadout.textContent = 'SWELL ' + String(Math.round(numeric)).padStart(2, '0');
    }
    if (notify && actions.onParam) actions.onParam(name, numeric);
  }

  for (const input of document.querySelectorAll('input[data-control]')) {
    const name = input.dataset.control;
    sliders.set(name, input);
    const initial = parseFloat(input.value);
    fillFor(input, initial);
    const out = document.querySelector('[data-output="' + name + '"]');
    if (out) outputs.set(name, out);
    updateOutput(name, initial);
    input.addEventListener('input', () => {
      const value = parseFloat(input.value);
      fillFor(input, value);
      updateOutput(name, value);
      if (name === 'waveHeight' && waveReadout) waveReadout.textContent = 'SWELL ' + String(Math.round(value)).padStart(2, '0');
      actions.onParam?.(name, value);
    });
  }

  for (const toggle of document.querySelectorAll('[data-toggle]')) {
    const name = toggle.dataset.toggle;
    toggles.set(name, toggle);
    const initial = state[name] !== false;
    toggle.setAttribute('aria-pressed', String(initial));
    toggle.addEventListener('click', () => {
      const next = toggle.getAttribute('aria-pressed') !== 'true';
      toggle.setAttribute('aria-pressed', String(next));
      actions.onToggle?.(name, next);
    });
  }

  qualityButtons.forEach((button) => {
    button.addEventListener('click', () => {
      qualityButtons.forEach((b) => b.classList.toggle('active', b === button));
      actions.onQuality?.(button.dataset.quality);
    });
  });

  presetButtons.forEach((button) => {
    button.addEventListener('click', () => {
      setCameraPresetActive(button.dataset.preset, false);
      actions.onCameraPreset?.(button.dataset.preset);
    });
  });

  editButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.dataset.edit;
      if (button.classList.contains('active')) {
        setEditMode(null);
        actions.onEditMode?.(null);
      } else {
        setEditMode(mode);
        actions.onEditMode?.(mode);
      }
    });
  });

  for (const button of document.querySelectorAll('[data-action]')) {
    const action = button.dataset.action;
    button.addEventListener('click', () => {
      if (action === 'togglePanel') {
        togglePanel();
        return;
      }
      if (action === 'toggleUI') {
        setUIHidden(!uiHidden);
        return;
      }
      if (action === 'pause') {
        actions.onPauseToggle?.();
        return;
      }
      if (ACTION_HANDLERS.includes(action)) {
        actions['on' + action.charAt(0).toUpperCase() + action.slice(1)]?.();
      }
    });
  }

  restoreUI?.addEventListener('click', () => setUIHidden(false));

  // Prevent drag gestures from leaking out of sliders into the scene.
  panel?.addEventListener('pointerdown', (e) => e.stopPropagation());
  panel?.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

  function setToggle(name, value) {
    const toggle = toggles.get(name);
    if (toggle) toggle.setAttribute('aria-pressed', String(Boolean(value)));
  }

  function setPaused(paused) {
    if (pauseButton) pauseButton.classList.toggle('paused', paused);
    if (pauseLabel) pauseLabel.textContent = paused ? '继续模拟' : '暂停模拟';
    if (pauseButton) {
      const icon = pauseButton.querySelector('svg');
      if (icon) {
        icon.innerHTML = paused
          ? '<path d="M4 2l8 5-8 5z"/>'
          : '<path d="M3 2h3v10H3zM8 2h3v10H8z"/>';
      }
    }
  }

  function setStats({ fps, width, height, waveHeight }) {
    if (fpsValue) fpsValue.textContent = String(Math.round(fps)).padStart(2, '0') + ' FPS';
    if (resolutionValue && width) resolutionValue.textContent = width + '×' + height;
    if (waveReadout && typeof waveHeight === 'number') waveReadout.textContent = 'SWELL ' + Math.round(waveHeight);
  }

  function setQualityActive(name) {
    qualityButtons.forEach((button) => button.classList.toggle('active', button.dataset.quality === name));
  }

  function setCameraPresetActive(name, active = true) {
    presetButtons.forEach((button) => {
      if (active) button.classList.toggle('active', button.dataset.preset === name);
      else button.classList.remove('active');
    });
  }

  function setEditMode(mode) {
    editButtons.forEach((button) => button.classList.toggle('active', button.dataset.edit === mode));
    document.body.classList.toggle('edit-active', Boolean(mode));
    if (editBanner) {
      const label = mode === 'rock' ? '放置石头' : mode === 'shell' ? '放置贝壳' : '';
      editBanner.textContent = mode
        ? '布置模式 · ' + label + ' · 点击场景放置 — ESC 退出'
        : '布置模式 · 点击场景放置物体 — ESC 退出';
    }
    if (actions.onCanvasCursor) actions.onCanvasCursor(mode ? 'crosshair' : 'grab');
  }

  function setUIHidden(hidden) {
    uiHidden = Boolean(hidden);
    document.body.classList.toggle('ui-hidden', uiHidden);
    if (!uiHidden) {
      panel?.classList.remove('collapsed');
      panelCollapsed = false;
    }
  }

  function togglePanel() {
    panelCollapsed = !panelCollapsed;
    panel?.classList.toggle('collapsed', panelCollapsed);
  }

  function setLoading(progress, text) {
    if (loaderBar) loaderBar.style.width = Math.max(0, Math.min(100, progress)) + '%';
    if (loaderText && text) loaderText.textContent = text;
  }

  function hideLoading() {
    if (!loader) return;
    loader.classList.add('hidden');
    window.setTimeout(() => {
      loader.style.display = 'none';
    }, 1200);
  }

  function showError(message) {
    if (loaderError) {
      loaderError.style.display = 'block';
      loaderError.textContent = message;
    }
    if (loaderBar) loaderBar.style.width = '100%';
    if (loaderText) loaderText.textContent = '初始化失败';
    if (loader) loader.classList.remove('hidden');
  }

  function showToast(message, duration = 1900) {
    if (!toast) return;
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add('show');
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), duration);
  }

  function handleKeydown(event) {
    const target = event.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
    if (event.code === 'KeyH' && !typing) {
      event.preventDefault();
      setUIHidden(!uiHidden);
      return;
    }
    if (event.code === 'Escape') {
      setEditMode(null);
      actions.onEditMode?.(null);
      return;
    }
    if (event.code === 'Space' && !typing && target?.tagName !== 'BUTTON') {
      event.preventDefault();
      actions.onPauseToggle?.();
    }
  }
  window.addEventListener('keydown', handleKeydown);

  // Responsive: fold the panel on very small screens, keep it open on desktop.
  function applyResponsive() {
    if (window.innerWidth <= 720 && !uiHidden) {
      panel?.classList.add('collapsed');
      panelCollapsed = true;
      setUIHidden(false);
    }
  }
  applyResponsive();
  window.addEventListener('resize', () => {
    if (window.innerWidth <= 720) {
      // Do not force every resize, only the first time it becomes narrow.
      if (!panel?.classList.contains('collapsed') && window.innerHeight < 900) {
        panel?.classList.add('collapsed');
        panelCollapsed = true;
      }
    }
  }, { passive: true });

  return {
    setControlValue,
    sync(name) {
      setControlValue(name, state[name], false);
    },
    syncAll() {
      for (const [name] of sliders) setControlValue(name, state[name], false);
      for (const [name, toggle] of toggles) toggle.setAttribute('aria-pressed', String(Boolean(state[name])));
      setPaused(Boolean(state.paused));
    },
    setPaused,
    setToggle,
    setStats,
    setQualityActive,
    setCameraPresetActive,
    setEditMode,
    setUIHidden,
    togglePanel,
    setLoading,
    hideLoading,
    showError,
    showToast,
    isUIHidden: () => uiHidden,
    getPanelCollapsed: () => panelCollapsed
  };
}
