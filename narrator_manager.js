// NarratorManager: ensures at most one narrator clip from assets/audio/narrator/ plays at a time.
// Narrator audio may overlap with sound effects (they use a different manager).

const NARRATOR_MAP = {
  'narrator:on-game-start': './assets/audio/narrator/on-game-start.m4a',
  'narrator:on-painting-scene-load': './assets/audio/narrator/on-painting-scene-load.m4a',
  'narrator:on-level-repeat-1': './assets/audio/narrator/on-level-repeat-1.m4a',
  'narrator:on-level-repeat-2': './assets/audio/narrator/on-level-repeat-2.m4a',
  'narrator:on-level-repeat-3': './assets/audio/narrator/on-level-repeat-3.m4a',
  'narrator:on-game-end-fade-white': './assets/audio/narrator/on-game-end-fade-white.m4a'
};

let _currentAudio = null;
let _currentKey = null;

export const NarratorManager = {
  // Attempt to play narrator clip. Will only start if no other narrator clip is playing.
  play(key) {
    if (!NARRATOR_MAP[key]) {
      console.warn('NarratorManager: unknown key', key);
      return false;
    }
    if (_currentAudio && !_currentAudio.ended && _currentKey) {
      // another narrator clip is already playing — dismiss request
      return false;
    }
    // create or reuse audio element for the key
    try {
      // If there is an existing audio element, discard it
      if (_currentAudio) {
        try { _currentAudio.pause(); _currentAudio.currentTime = 0; } catch(e) {}
        _currentAudio = null; _currentKey = null;
      }
      const a = new Audio(NARRATOR_MAP[key]);
      a.preload = 'auto';
      a.addEventListener('ended', () => { try { _currentAudio = null; _currentKey = null; } catch(e){} });
      const p = a.play();
      if (p && typeof p.then === 'function') {
        p.then(() => { _currentAudio = a; _currentKey = key; }).catch((err) => { console.warn('NarratorManager: play rejected', err); _currentAudio = null; _currentKey = null; });
      } else {
        _currentAudio = a; _currentKey = key;
      }
      return true;
    } catch (e) {
      console.warn('NarratorManager: play failed', e);
      _currentAudio = null; _currentKey = null;
      return false;
    }
  },

  stopAll() {
    try { if (_currentAudio) { _currentAudio.pause(); _currentAudio.currentTime = 0; } } catch(e) {}
    _currentAudio = null; _currentKey = null;
  },

  _state() { return { key: _currentKey, isPlaying: !!_currentAudio && !_currentAudio.ended }; }
};
