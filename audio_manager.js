// Simple AudioManager enforcing at-most-two-different-sounds playing rule.
// Rule: a sound may play only if there are currently 0 playing sounds, or
// exactly 1 playing sound and that sound is different from the candidate.
// If the rule isn't satisfied the play request is dismissed.

const SOUND_MAP = {
  'painting:move-tile': './assets/audio/sound-effects/painting/move-tile.mp3',
  'painting:scene-victory': './assets/audio/sound-effects/painting/scene-load-and-victory.mp3',
  'philosophy:on-level-start': './assets/audio/sound-effects/philosophy/on-level-start.mp3',
  'philosophy:on-star-link': './assets/audio/sound-effects/philosophy/on-star-link.mp3'
};

const _audioEls = new Map(); // key -> HTMLAudioElement
const _activeKeys = new Set(); // distinct sound keys currently playing

function _createAudio(key) {
  const src = SOUND_MAP[key];
  if (!src) return null;
  const a = new Audio(src);
  a.preload = 'auto';
  a.addEventListener('ended', () => {
    try { _activeKeys.delete(key); } catch(e) {}
  });
  a.addEventListener('pause', () => {
    // If paused and at end, ensure active set cleaned up
    if (a.currentTime === 0 || a.ended) { try { _activeKeys.delete(key); } catch(e) {} }
  });
  return a;
}

export const AudioManager = {
  // Attempt to play a mapped sound key. Returns true if playback was initiated, false if dismissed.
  play(key) {
    if (!SOUND_MAP[key]) {
      console.warn('AudioManager: unknown key', key);
      return false;
    }
    // Evaluate allowed conditions
    const activeCount = _activeKeys.size;
    if (activeCount === 0) {
      // allowed
    } else if (activeCount === 1 && !_activeKeys.has(key)) {
      // allowed (one different sound playing)
    } else {
      // not allowed (either same sound already playing, or two different sounds already playing)
      return false;
    }

    let a = _audioEls.get(key);
    if (!a) { a = _createAudio(key); if (!a) return false; _audioEls.set(key, a); }
    try {
      const p = a.play();
      // Some browsers return a promise which may reject if autoplay is blocked
      if (p && typeof p.then === 'function') {
        p.then(() => { _activeKeys.add(key); }).catch((err) => { try { _activeKeys.delete(key); } catch(e){} });
      } else {
        _activeKeys.add(key);
      }
      return true;
    } catch (e) {
      console.warn('AudioManager: play failed', e);
      try { _activeKeys.delete(key); } catch(e) {}
      return false;
    }
  },

  // Stop and clear all playing sounds (helper for scene switches)
  stopAll() {
    for (const [k,a] of _audioEls.entries()) {
      try { a.pause(); a.currentTime = 0; } catch(e) {}
    }
    _activeKeys.clear();
  },

  // Expose internal state for debugging
  _state() { return { active: Array.from(_activeKeys), loaded: Array.from(_audioEls.keys()) }; }
};

// Background music controller (separate from sound-effects and narrator managers)
// Usage: call BackgroundMusic.init() early, then BackgroundMusic.play() after a user interaction
// Place a music file at ./assets/audio/background.mp3 or call BackgroundMusic.load(src)
export const BackgroundMusic = (function(){
  const STORAGE_KEY_MUTED = 'lk_music_muted';
  const STORAGE_KEY_VOLUME = 'lk_music_volume';
  let _audio = null;
  let _src = './assets/audio/background.mp3';
  let _muted = false;
  let _volume = 0.45;
  let _currentKey = null;

  // Default music map: map semantic keys to audio files (place files under these paths)
  const MUSIC_MAP = {
    // use the existing audio files in the repo (found under assets/audio/...)
    'painting:play': './assets/audio/sound-effects/painting/painting_loop.mp3',
    'philosophy:main': './assets/audio/sound-effects/philosophy/philosophy_loop.mp3'
  };

  function _createAudio() {
    if (!_src) return null;
    try {
      const a = new Audio(_src);
      a.loop = true;
      a.preload = 'auto';
      a.volume = _volume;
      a.muted = _muted;
      a.addEventListener('error', (e) => { console.warn('BackgroundMusic: audio element error', e); });
      return a;
    } catch (e) { console.warn('BackgroundMusic: create failed', e); return null; }
  }

  return {
    init() {
      try {
        const m = window.localStorage && window.localStorage.getItem(STORAGE_KEY_MUTED);
        if (m !== null) _muted = m === '1' || m === 'true';
        const v = window.localStorage && window.localStorage.getItem(STORAGE_KEY_VOLUME);
        if (v !== null) {
          const nv = Number(v);
          if (!Number.isNaN(nv)) _volume = Math.max(0, Math.min(1, nv));
        }
        if (!_audio) _audio = _createAudio();
      } catch (e) { console.warn('BackgroundMusic.init failed', e); }
    },

    // Replace the audio source (call before play if needed)
    load(src) {
      try {
        _src = src;
        if (_audio) { try { _audio.pause(); _audio = null; } catch(e){} }
        _audio = _createAudio();
        // loading a custom src clears any current key mapping
        _currentKey = null;
      } catch (e) { console.warn('BackgroundMusic.load failed', e); }
    },

    // Play a semantic key from MUSIC_MAP. If the key is already playing, do nothing.
    playFor(key) {
      try {
        if (!key) return false;
        const src = MUSIC_MAP[key];
        if (!src) { console.warn('BackgroundMusic.playFor: unknown key', key); return false; }
        console.log('BackgroundMusic.playFor ->', key, src);
        if (_currentKey === key && _audio && !_audio.paused && !_audio.ended) return true;
        // switch src and play
        this.load(src);
        _currentKey = key;
        return this.play();
      } catch (e) { console.warn('BackgroundMusic.playFor failed', e); return false; }
    },

    getCurrentKey() { return _currentKey; },

    play() {
      try {
        if (!_audio) _audio = _createAudio();
        if (!_audio) return false;
        const p = _audio.play();
        if (p && typeof p.then === 'function') {
          p.then(() => {}).catch((err) => { console.warn('BackgroundMusic: play rejected', err); });
        }
        return true;
      } catch (e) { console.warn('BackgroundMusic.play failed', e); return false; }
    },

    pause() {
      try { if (_audio) _audio.pause(); } catch(e) { console.warn('BackgroundMusic.pause failed', e); }
    },

    stop() {
      try { if (_audio) { _audio.pause(); _audio.currentTime = 0; } } catch(e) {}
    },

    setVolume(v) {
      try { _volume = Math.max(0, Math.min(1, v)); if (_audio) _audio.volume = _volume; if (window.localStorage) window.localStorage.setItem(STORAGE_KEY_VOLUME, String(_volume)); } catch(e) { console.warn('BackgroundMusic.setVolume failed', e); }
    },

    getVolume() { return _volume; },

    toggleMute() {
      try {
        _muted = !_muted;
        if (_audio) _audio.muted = _muted;
        if (window.localStorage) window.localStorage.setItem(STORAGE_KEY_MUTED, _muted ? '1' : '0');
        return _muted;
      } catch(e) { console.warn('BackgroundMusic.toggleMute failed', e); return _muted; }
    },

    isMuted() { return _muted; }
    ,
    isPlaying() {
      try { return !!(_audio && !_audio.paused && !_audio.ended); } catch(e) { return false; }
    }
  };
})();
