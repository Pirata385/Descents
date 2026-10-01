// Keyboard and mouse input with pointer lock and rebindable actions.

export const DEFAULT_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  run: ['ShiftLeft', 'ShiftRight'],
  crouch: ['ControlLeft', 'KeyC'],
  interact: ['KeyE'],
  observe: ['KeyF'],
  ability: ['KeyR'],
  lamp: ['KeyL'],
  mapTop: ['KeyM'],
  mapVertical: ['KeyN'],
  catalog: ['KeyJ', 'Tab'],
  inventory: ['KeyI'],
  pause: ['Escape', 'KeyP'],
  reelIn: ['KeyQ'],
  reelOut: ['KeyZ'],
  release: ['KeyX'],
};

export class Input {
  constructor(element) {
    this.el = element;
    this.bindings = { ...DEFAULT_BINDINGS };
    this.down = new Set();
    this.pressed = new Set();   // pressed this frame
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.buttons = 0;
    this.clicked = 0;           // bitmask of buttons pressed this frame
    this.locked = false;
    this.sensitivity = 1;
    this.invertY = false;
    this.enabled = true;
    this.onUnlock = null;
    this.lockTime = 0;
    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT');
      if (typing) return;
      if (e.code === 'Tab') e.preventDefault();
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => { this.down.clear(); this.buttons = 0; });
    element.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      this.buttons |= 1 << e.button;
      this.clicked |= 1 << e.button;
    });
    window.addEventListener('mouseup', (e) => { this.buttons &= ~(1 << e.button); });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // browsers can report one bogus jump right after the pointer locks
      const dx = e.movementX || 0, dy = e.movementY || 0;
      if (performance.now() - this.lockTime < 120 || Math.abs(dx) > 350 || Math.abs(dy) > 350) return;
      this.mouseDX += dx;
      this.mouseDY += dy;
    });
    window.addEventListener('wheel', (e) => { if (this.locked) this.wheel += Math.sign(e.deltaY); }, { passive: true });
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === element;
      if (this.locked) this.lockTime = performance.now();
      if (was && !this.locked && this.onUnlock) this.onUnlock();
    });
  }

  lock() {
    if (this.locked) return;
    try {
      const p = this.el.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* ignore */ }
  }

  unlock() { if (document.pointerLockElement) document.exitPointerLock(); }

  is(action) { return this.bindings[action].some((c) => this.down.has(c)); }
  was(action) { return this.bindings[action].some((c) => this.pressed.has(c)); }

  /** Consume per-frame deltas. */
  endFrame() {
    this.pressed.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.clicked = 0;
  }
}
