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
