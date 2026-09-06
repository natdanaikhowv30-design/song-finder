/**
 * player.js — Playback Queue Controller
 * รูปแบบ: Finite State Machine + Observer (EventTarget)
 * เหตุการณ์ที่ปล่อย: change | state | progress | unplayable | exhausted
 */
export const REPEAT = { OFF: 'off', ALL: 'all', ONE: 'one' };

export class PlaybackQueue extends EventTarget {
  #audio;
  #resolver;
  #preloader = new Audio();
  #list = [];
  #order = [];
  #cursor = -1;
  #shuffle = false;
  #repeat = REPEAT.OFF;
  #fails = 0;
  #token = 0;                       // guard กัน race condition จากการกดรัว

  constructor(audio, resolver) {
    super();
    this.#audio = audio;
    this.#resolver = resolver;
    this.#preloader.preload = 'auto';

    audio.addEventListener('ended', () => this.#onEnded());
    audio.addEventListener('play', () => this.#emit('state'));
    audio.addEventListener('pause', () => this.#emit('state'));
    audio.addEventListener('error', () => this.#emit('state'));
    audio.addEventListener('timeupdate', () => this.#emit('progress'));
    audio.addEventListener('loadedmetadata', () => this.#emit('progress'));
  }

  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /* ---------- Getters ---------- */
  get current() { return this.#list[this.#order[this.#cursor]] || null; }
  get size() { return this.#order.length; }
  get position() { return this.#cursor + 1; }
  get shuffle() { return this.#shuffle; }
  get repeat() { return this.#repeat; }
  get isPlaying() { return !this.#audio.paused && !this.#audio.ended; }
  get duration() { return Number.isFinite(this.#audio.duration) ? this.#audio.duration : 0; }
  get time() { return this.#audio.currentTime || 0; }
  get ratio() { return this.duration ? this.time / this.duration : 0; }
  isCurrent(id) { return this.current?.id === id; }

  /* ---------- Order Management (Fisher–Yates) ---------- */
  #buildOrder(pinId = null) {
    const idx = this.#list.map((_, i) => i);
    if (this.#shuffle) {
      for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }
    }
    this.#order = idx;
    if (pinId != null) {
      const at = this.#order.findIndex((i) => this.#list[i].id === pinId);
      if (at > 0) this.#order.unshift(...this.#order.splice(at, 1));
      this.#cursor = at >= 0 ? 0 : this.#cursor;
    }
  }

  /* ---------- Public Commands ---------- */
  async start(list, startId) {
    this.#list = Array.isArray(list) ? list.slice() : [];
    this.#fails = 0;
    this.#buildOrder(startId);
    if (this.#cursor < 0) this.#cursor = 0;
    return this.#playCursor();
  }

  async toggle() {
    if (!this.current) return;
    if (this.isPlaying) { this.#audio.pause(); return; }
    if (this.#audio.src) {
      try { await this.#audio.play(); } catch { /* autoplay policy */ }
      return;
    }
    return this.#playCursor();
  }

  async next(auto = false) {
    if (!this.size) return;
    if (auto && this.#repeat === REPEAT.ONE) {
      this.#audio.currentTime = 0;
      try { await this.#audio.play(); } catch {}
      return;
    }
    const last = this.#cursor >= this.size - 1;
    if (last && this.#repeat === REPEAT.OFF) {
      this.#audio.pause();
      this.#emit('exhausted');
      return;
    }
    this.#cursor = last ? 0 : this.#cursor + 1;
    return this.#playCursor();
  }

  async prev() {
    if (!this.size) return;
    // มาตรฐาน media player: ย้อนเกิน 3 วิ = เริ่มเพลงเดิมใหม่
    if (this.time > 3) { this.#audio.currentTime = 0; return; }
    this.#cursor = this.#cursor <= 0 ? this.size - 1 : this.#cursor - 1;
    return this.#playCursor();
  }

  async jumpTo(id) {
    const at = this.#order.findIndex((i) => this.#list[i].id === id);
    if (at < 0) return false;
    this.#cursor = at;
    await this.#playCursor();
    return true;
  }

  seek(ratio) {
    if (!this.duration) return;
    this.#audio.currentTime = Math.max(0, Math.min(1, ratio)) * this.duration;
  }

  setShuffle(on) {
    this.#shuffle = Boolean(on);
    this.#buildOrder(this.current?.id ?? null);
    this.#emit('change');
  }

  cycleRepeat() {
    const seq = [REPEAT.OFF, REPEAT.ALL, REPEAT.ONE];
    this.#repeat = seq[(seq.indexOf(this.#repeat) + 1) % seq.length];
    this.#emit('change');
    return this.#repeat;
  }

  stop() {
    this.#audio.pause();
    this.#audio.removeAttribute('src');
    this.#audio.load();
    this.#cursor = -1;
    this.#emit('change');
  }

  /* ---------- Internal ---------- */
  async #playCursor() {
    const song = this.current;
    if (!song) return;
    const my = ++this.#token;

    this.#emit('change', { loading: true });

    let url = song.previewUrl || null;
    if (!url) {
      try { url = await this.#resolver(song); } catch { url = null; }
    }
    if (my !== this.#token) return;                 // ถูกแทนที่ด้วยคำสั่งใหม่แล้ว

    if (!url) {
      this.#emit('unplayable', { song });
      // Circuit breaker — กัน infinite recursion เมื่อทั้งคิวเล่นไม่ได้
      if (++this.#fails >= Math.min(this.size, 8)) { this.#emit('exhausted'); return; }
      return this.next(true);
    }

    this.#fails = 0;
    song.previewUrl = url;                          // memoize กลับเข้า object
    this.#audio.src = url;
    try {
      await this.#audio.play();
    } catch {
      this.#emit('state');
      return;
    }
    this.#emit('change');
    this.#prefetchNext();
  }

  /** ลด gap ระหว่างเพลงด้วยการ warm HTTP connection ล่วงหน้า */
  #prefetchNext() {
    const nx = this.#list[this.#order[this.#cursor + 1]];
    if (nx?.previewUrl && this.#preloader.src !== nx.previewUrl) {
      this.#preloader.src = nx.previewUrl;
      this.#preloader.load();
    }
  }

  #onEnded() { this.next(true); }
}
