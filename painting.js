import * as THREE from 'https://unpkg.com/three@0.164.1/build/three.module.js';

/*
  Slide puzzle module (3x4)

  Responsibilities:
  - Build a 3x4 sliding puzzle using a sliced image atlas.
  - Provide a minimal public API:
      init(scene, camera, controls, anchorPosition, anchorQuaternion)
      show() / hide() / toggle() / isActive()
      update(dt)
      updateInteractBubble(visible)
  - Render pieces as individual THREE.Mesh planes with per-tile CanvasTexture so
    tiles are crisp and independent.
  - Ensure shuffles are solvable by performing a sequence of legal moves.
  - Provide small UX niceties: animated slides, quiver on illegal moves, fade-in
    of final tile when solved, and in-puzzle HUD/dialog management.

  Notes on data shapes and conventions:
  - _board is a ROWS x COLS array of integers (1..ROWS*COLS-1) with 0 representing the blank.
  - _tileMeshes mirrors _board with the THREE.Mesh for each cell.
  - Textures are CanvasTexture objects stored in _lastTextures in row-major order.
*/

// Slide puzzle module (3x4) using move-based randomization to guarantee solvability.
// Exports: init(scene, camera, controls, anchorPosition, anchorQuaternion), show(), hide(), toggle(), isActive()

const ROWS = 3;
const COLS = 4;
const SHUFFLE_MOVES = 80; // we'll multiply by 10 as requested elsewhere when invoking randomize

let _scene, _camera, _controls;
let _group = null; // THREE.Group holding piece meshes
let _board = null; // 2D array rows x cols storing indices (0 = blank)
let _tileSize = 1.0;
let _anchorPos = new THREE.Vector3();
let _anchorQuat = new THREE.Quaternion();
let _active = false;
// rotation removed per request
let _lastTextures = null;
let _preTeleportPose = null;
let _tileMeshes = null; // 2D array [r][c] -> mesh
let _animating = false;
let _previousBackground = null; // save scene.background to restore after hide
let _appliedBackground = null; // keep a reference to the sky we applied for bookkeeping
let _controlsInverted = true; // current inversion state for controls (default: inverted)

// Fade in the missing (final) tile over the blank cell. Used when puzzle is solved.
// Returns a Promise that resolves when the opacity animation finishes.
function _fadeInBlank(duration=600) {
  return new Promise((resolve)=>{
    const blank = _findBlank(_board);
    if (!blank) return resolve();
    const finalIndex = ROWS * COLS; // last tile
    const tex = (_lastTextures && _lastTextures.length >= finalIndex) ? _lastTextures[finalIndex-1] : null;
    if (!tex) return resolve();
    try { tex.encoding = THREE.sRGBEncoding; } catch(e) {}
    const geo = new THREE.PlaneGeometry(_tileSize, _tileSize);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.45, roughness: 1.0, metalness: 0.0, side: THREE.DoubleSide, transparent: true, opacity: 0.0 });
    const mesh = new THREE.Mesh(geo, mat);
    // place at blank position
    const blankMesh = (_tileMeshes && _tileMeshes[blank.r]) ? _tileMeshes[blank.r][blank.c] : null;
    if (blankMesh) mesh.position.copy(blankMesh.position);
    else {
      const spacing = _tileSize * 0.98;
      const startX = - (COLS/2 - 0.5) * spacing;
      const startY = (ROWS/2 - 0.5) * spacing;
      mesh.position.set(startX + blank.c*spacing, startY - blank.r*spacing, -0.5);
    }
    // add on top of existing group
    try { if (_group) _group.add(mesh); } catch(e) {}
    _tileMeshes[blank.r][blank.c] = mesh;
    // animate opacity
    const start = performance.now();
    function step(now){
      const t = Math.min(1, (now - start) / duration);
      mat.opacity = t;
      if (t < 1) requestAnimationFrame(step); else { mat.opacity = 1.0; mat.transparent = false; resolve(); }
    }
    requestAnimationFrame(step);
  });
}

// create texture atlas by slicing the image into ROWS x COLS
// Slice the source image into ROWS x COLS canvases and return an array of CanvasTextures.
// If the image fails to load, create colored fallback tiles for visual debugging.
async function _createTileTextures(src) {
  // load image as Image element
  let img;
  try {
    img = await new Promise((res, rej) => {
      const i = new Image(); i.crossOrigin = 'anonymous';
      i.onload = () => res(i); i.onerror = rej; i.src = src;
    });
  } catch (e) {
    console.warn('SlidePuzzle: failed to load image, using fallback colored tiles', e);
    img = null;
  }
  const textures = [];
  let tw, th;
  if (img) {
    const iw = img.width, ih = img.height;
    tw = Math.floor(iw / COLS); th = Math.floor(ih / ROWS);
  } else {
    // fallback tile pixel size
    tw = 128; th = 128;
  }
  for (let r=0;r<ROWS;r++){
    for (let c=0;c<COLS;c++){
      // create a dedicated canvas for each tile so the texture doesn't get overwritten
      const canvasTile = document.createElement('canvas');
      canvasTile.width = tw; canvasTile.height = th;
      const ctxTile = canvasTile.getContext('2d');
      if (img) {
        ctxTile.drawImage(img, c*tw, r*th, tw, th, 0,0,tw,th);
      } else {
        // fallback visual: colored tile with index hint
        ctxTile.fillStyle = `hsl(${(r*COLS + c) * 6}, 60%, 40%)`;
        ctxTile.fillRect(0,0,tw,th);
      }
      const tex = new THREE.CanvasTexture(canvasTile);
      tex.needsUpdate = true;
      textures.push(tex);
    }
  }
  return textures;
}

// Create a solved board layout where the last cell is blank (0).
function _createEmptyBoard() {
  const arr = [];
  let idx = 1;
  for (let r=0;r<ROWS;r++){
    const row = [];
    for (let c=0;c<COLS;c++){
      // last cell is blank (0)
      if (r === ROWS-1 && c === COLS-1) { row.push(0); }
      else { row.push(idx++); }
    }
    arr.push(row);
  }
  return arr;
}

// Find the blank cell in a board and return {r,c} or null if not found.
function _findBlank(board){
  for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++) if (board[r][c]===0) return {r,c};
  return null;
}

// Check whether a tile can move into the blank from the given direction.
// dir: 'U','D','L','R' meaning move the tile in that direction into the blank
// NOTE: this computes source coordinates relative to the blank and ensures bounds.
function _canMove(board, r,c, dir){
  const blank = _findBlank(board);
  if (!blank) return false;
  // compute source tile coordinates for direction: pressing 'U' should move the tile above into the blank
  let sr = blank.r + (dir === 'U' ? -1 : (dir === 'D' ? 1 : 0));
  let sc = blank.c + (dir === 'L' ? -1 : (dir === 'R' ? 1 : 0));
  return sr>=0 && sr<ROWS && sc>=0 && sc<COLS;
}

// Apply a logical move: slide the tile in the specified direction into the blank.
// Returns true if a move was applied.
function _applyMove(board, dir){
  const blank = _findBlank(board);
  if (!blank) return false;
  // pressing 'U' moves the tile above the blank down into the blank (so source is blank.r-1)
  const sr = blank.r + (dir === 'U' ? -1 : (dir === 'D' ? 1 : 0));
  const sc = blank.c + (dir === 'L' ? -1 : (dir === 'R' ? 1 : 0));
  if (sr<0||sr>=ROWS||sc<0||sc>=COLS) return false;
  board[blank.r][blank.c] = board[sr][sc];
  board[sr][sc] = 0;
  return true;
}

// Flatten board to a 1D array for easy comparison and logging.
function _boardToIndexArray(board){
  const out = [];
  for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++) out.push(board[r][c]);
  return out;
}

// Rebuild the THREE.Group that visually represents the board using the provided textures.
// This disposes previous geometries/materials and rebuilds meshes based on _board.
function _renderBoard(textures){
  // remove prior parent group if present so we don't leave empty groups in the scene
  try {
    if (_group && _group.parentGroup) {
      try { if (_scene && _scene.children.includes(_group.parentGroup)) _scene.remove(_group.parentGroup); } catch(e) {}
      _group.parentGroup = null;
    }
  } catch(e) {}
  if (_group) { _group.traverse(o=>{ if (o.material) o.material.dispose?.(); if (o.geometry) o.geometry.dispose?.(); }); }
  _group = new THREE.Group();
  const baseZ = -0.5; // slightly behind the interactive plane
  const spacing = _tileSize * 0.98;
  const startX = - (COLS/2 - 0.5) * spacing;
  const startY = (ROWS/2 - 0.5) * spacing;
  const geo = new THREE.PlaneGeometry(_tileSize, _tileSize);
  // create mesh tracking array
  _tileMeshes = Array.from({length:ROWS}, ()=> Array.from({length:COLS}, ()=> null));
  for (let r=0;r<ROWS;r++){
    for (let c=0;c<COLS;c++){
      const idx = _board[r][c];
      const mat = new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.DoubleSide });
          if (idx !== 0) {
            const tex = textures[idx-1];
            // ensure correct color space
            try { tex.encoding = THREE.sRGBEncoding; } catch(e) {}
            // use an emissive PBR material so the tile is visible regardless of scene lighting
            try { tex.encoding = THREE.sRGBEncoding; } catch(e) {}
            const pbr = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.45, roughness: 1.0, metalness: 0.0, side: THREE.DoubleSide });
            const m = new THREE.Mesh(geo, pbr);
            m.position.set(startX + c*spacing, startY - r*spacing, baseZ);
            _group.add(m);
            _tileMeshes[r][c] = m;
            continue;
          }
          // For the blank tile (0) create an invisible/transparent mesh so layout and hit/positioning remain stable
          const blankMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.0, side: THREE.DoubleSide });
          const blankMesh = new THREE.Mesh(geo, blankMat);
          blankMesh.position.set(startX + c*spacing, startY - r*spacing, baseZ);
          _group.add(blankMesh);
          _tileMeshes[r][c] = blankMesh;
    }
  }
  // position the group relative to anchor
  const g = new THREE.Group();
  g.add(_group);
  g.position.copy(_anchorPos);
  // orient to face the stored quaternion's forward direction
  g.quaternion.copy(_anchorQuat);
  // offset backward a bit so it sits behind the red plane (which is facing camera)
  g.translateZ(-1.6);
  // Do not add to the scene yet; parentGroup will be attached to scene when show() is called
  _group.parentGroup = g;
  // If puzzle currently active, add the parentGroup so re-render reflects immediately
  if (_active && _scene && !_scene.children.includes(g)) {
    _scene.add(g);
    g.visible = true;
  } else {
    g.visible = false;
  }
}

// Simple animation helper using requestAnimationFrame. Interpolates position of mesh.
// Animate a mesh from one position to another using a gentle ease-in-out curve.
function _animateMeshPosition(mesh, fromPos, toPos, duration=260) {
  return new Promise((resolve)=>{
    const start = performance.now();
    function step(now){
      const t = Math.min(1, (now - start) / duration);
      const tt = t < 0.5 ? 2*t*t : -1 + (4-2*t)*t; // easeInOutQuad-like
      mesh.position.x = fromPos.x + (toPos.x - fromPos.x) * tt;
      mesh.position.y = fromPos.y + (toPos.y - fromPos.y) * tt;
      mesh.position.z = fromPos.z + (toPos.z - fromPos.z) * tt;
      if (t < 1) requestAnimationFrame(step); else resolve();
    }
    requestAnimationFrame(step);
  });
}

// Small 'quiver' feedback animation used when the user attempts an illegal move.
function _animateQuiver(mesh, axis='x', amount=0.04, duration=120) {
  return new Promise((resolve)=>{
    const from = mesh.position[axis];
    const half = duration/2;
    const start = performance.now();
    function step(now){
      const elapsed = now - start;
      if (elapsed < half) {
        const t = elapsed / half;
        mesh.position[axis] = from + amount * t;
        requestAnimationFrame(step);
      } else if (elapsed < duration) {
        const t = (elapsed - half) / half;
        mesh.position[axis] = from + amount * (1 - t);
        requestAnimationFrame(step);
      } else {
        mesh.position[axis] = from;
        resolve();
      }
    }
    requestAnimationFrame(step);
  });
}

// Shuffle the board by performing `moves` legal random moves. This guarantees solvability.
function _shuffleByMoves(board, moves) {
  const dirs = ['U','D','L','R'];
  for (let i=0;i<moves;i++){
    // pick a random direction that is legal
    const legal = dirs.filter(d => _canMove(board, null, null, d));
    if (legal.length===0) continue;
    const d = legal[Math.floor(Math.random()*legal.length)];
    _applyMove(board,d);
  }
}

// Greedily move the blank toward the bottom-right corner by applying local moves.
// Used to ensure the blank finishes in the expected final position after shuffling.
function _minimalMovesToBottomRight(board) {
  // We'll move blank down/right when possible by applying 'D' then 'R' where applicable
  const steps = [];
  const maxSteps = ROWS * COLS * 50; // safety cap to avoid runaway loops
  let safety = 0;
  while (true) {
    if (++safety > maxSteps) {
      console.warn('SlidePuzzle:_minimalMovesToBottomRight hit safety cap', safety);
      break;
    }
    const blank = _findBlank(board);
    if (!blank) break;
    if (blank.r === ROWS-1 && blank.c === COLS-1) break;
    // prefer to move blank down (D) then right (R)
    if (blank.r < ROWS-1) {
      if (_applyMove(board, 'D')) { steps.push('D'); continue; }
    }
    if (blank.c < COLS-1) {
      if (_applyMove(board, 'R')) { steps.push('R'); continue; }
    }
    // otherwise try any valid move to make progress
    const dirs = ['D','R','U','L'];
    let moved = false;
    for (const d of dirs) { if (_applyMove(board, d)) { steps.push(d); moved = true; break; } }
    if (!moved) break; // stuck
  }
  return steps;
}

// Initialize the puzzle: bind scene/camera/controls, create textures, render board,
// and set puzzle state to 'loaded' so the main app can show the F bubble.
export async function init(scene, camera, controls, anchorPosition, anchorQuaternion) {
  _scene = scene; _camera = camera; _controls = controls;
  _anchorPos.copy(anchorPosition || new THREE.Vector3());
  _anchorQuat.copy(anchorQuaternion || new THREE.Quaternion());
  _board = _createEmptyBoard();
  _tileSize = 0.64; // chosen to fit visually behind marker; doubled so puzzle appears larger
  // debug state
  window._slidePuzzleState = { inited: false, texturesLoaded: false };
  // prepare textures
  const src = './assets/images/ThePersistenceOfMemory_Dali.jpg';
  const textures = await _createTileTextures(src);
  _lastTextures = textures;
  if (textures && textures.length === ROWS * COLS) window._slidePuzzleState.texturesLoaded = true;
  _renderBoard(textures);
  // load panoramic skybox texture (equirectangular) and set as scene background while puzzle is loaded
  try {
    const skyPath = './assets/textures/SkyboxPintura.png';
    const loader = new THREE.TextureLoader();
    loader.load(skyPath, (tex) => {
      try {
        tex.mapping = THREE.EquirectangularReflectionMapping;
        try { tex.encoding = THREE.sRGBEncoding; } catch(e) {}
        if (_scene) {
              // dispose any existing background to free GPU memory before replacing
              try {
                const prev = _scene.background;
                if (prev) {
                  try { if (prev.dispose) prev.dispose(); } catch(e) { /* ignore */ }
                }
              } catch(e) {}
              _scene.background = tex;
              _appliedBackground = tex;
              _previousBackground = null; // do not restore previous background on hide
              console.log('SlidePuzzle: skybox applied (previous background disposed)', skyPath);
            }
      } catch(e) { console.warn('SlidePuzzle: failed to apply skybox', e); }
    }, undefined, (err)=>{ console.warn('SlidePuzzle: skybox load error', err); });
  } catch(e) { console.warn('SlidePuzzle: skybox loader failed', e); }
  window._slidePuzzleState.inited = true;
  // mark puzzle as loaded so main can show F-dialog; use state machine key
  try { if (_scene && _scene.userData) _scene.userData.puzzleState = 'loaded'; } catch(e) {}
  console.log('SlidePuzzle: initialized (texturesLoaded=', window._slidePuzzleState.texturesLoaded, ')');
  // removed per-module debug overlay; HUD standardized in main.js
  // apply randomize 10x as requested
  for (let i=0;i<10;i++) {
    _shuffleByMoves(_board, SHUFFLE_MOVES);
  }
  // ensure blank at bottom-right by applying minimal inverse moves (we'll compute steps to bottom-right)
  const steps = _minimalMovesToBottomRight(_board);
  // render again after shuffle and adjustment
  _renderBoard(textures);
  // Add puzzle parentGroup to the scene so the puzzle is visible immediately and remains present
  try { if (_group && _group.parentGroup && _scene && !_scene.children.includes(_group.parentGroup)) { _scene.add(_group.parentGroup); _group.parentGroup.visible = true; } } catch(e) {}
}

function _isSolved(){
  if (!_board) return false;
  const flat = _boardToIndexArray(_board);
  return flat.every((v,i)=> (i === flat.length - 1 ? v === 0 : v === i+1));
}

export function show() {
  // Public: show the puzzle UI and teleport the camera to the panel pose.
  // Side-effects: sets _active=true, disables movement controls, creates HUD elements.
  if (!_scene || !_group) return;
  _active = true;
  try { if (_scene && _scene.userData) { _scene.userData.puzzleState = 'active'; } } catch(e) {}
  // Do NOT unlock pointer or disable movement here; movement stays enabled until the user presses F.
  // make DOM overlay visible if desired
  // Bring puzzle group into scene and make visible
  if (_group && _group.parentGroup) {
    if (!_scene.children.includes(_group.parentGroup)) _scene.add(_group.parentGroup);
    _group.parentGroup.visible = true;
  }
  // save current camera pose & control state, then teleport camera to panel's position and rotation
  try {
    if (_scene && _scene.userData && _scene.userData.initialPanelPose && _scene.userData.camera) {
      const cam = _scene.userData.camera;
      const p = _scene.userData.initialPanelPose;
      try {
        _preTeleportPose = { pos: cam.position.clone(), quat: cam.quaternion.clone(), controlsEnabled: !!(_scene.userData && _scene.userData.controlsEnabled), pointerLocked: !!(_controls && _controls.isLocked) };
      } catch(e) { _preTeleportPose = null; }
      // move camera to panel
      cam.position.copy(p.pos);
      cam.quaternion.copy(p.quat);
      // sync any pointerlock control object if present
      if (_controls && _controls.getObject) {
        try { _controls.getObject().position.copy(cam.position); _controls.getObject().quaternion.copy(cam.quaternion); } catch(e) {}
      }
      // disable movement while solving: unlock pointer and set controlsEnabled=false
      try { if (_controls && _controls.unlock) _controls.unlock(); if (_scene && _scene.userData) _scene.userData.controlsEnabled = false; } catch(e) {}
    }
  } catch(e) {}
  // create on-screen in-puzzle dialogues using a centralized helper so each panel is consistent
  try {
    let wrap = document.getElementById('lk_puzzle_wrap');
    if (!wrap) {
      wrap = document.createElement('div'); wrap.id = 'lk_puzzle_wrap';
      wrap.style.position = 'fixed'; wrap.style.left = '50%'; wrap.style.transform = 'translateX(-50%)'; wrap.style.bottom = '2vh'; wrap.style.zIndex = 100000; wrap.style.display = 'flex'; wrap.style.gap = '1.2rem'; wrap.style.pointerEvents = 'none'; wrap.style.justifyContent = 'center';
      document.body.appendChild(wrap);
    }

    // helper that returns standardized dialog markup (CSS lives in main.js)
    function createDialogHTML(iconSrc, line1, line2, id) {
      return `
      <div ${id ? `id="${id}"` : ''} class="lk_dialog">
        <img class="lk_dialog_icon" src="${iconSrc}"/>
        <div class="lk_dialog_text">
          <div class="lk_dialog_line1">${line1}</div>
          <div class="lk_dialog_line2">${line2}</div>
        </div>
      </div>`;
    }

  wrap.innerHTML = '';
  // Arrow keys (use tiny icon, single two-line short text)
  wrap.innerHTML += `<div class="lk_dialog"> <img class="lk_dialog_icon lk_icon_tiny" src="./assets/vectors/ArrowKeys.svg"/> <div class="lk_dialog_text"><div class="lk_dialog_line1">Mover piezas</div><div class="lk_dialog_line2"></div></div></div>`;
  // Help (single-line) — clickable and mapped to H
  wrap.innerHTML += `<div id="lk_dialog_h" class="lk_dialog"> <img class="lk_dialog_icon" src="./assets/vectors/Hkey.svg"/> <div class="lk_dialog_text"><div class="lk_dialog_line1">Ayuda</div><div class="lk_dialog_line2"></div></div></div>`;
  // Randomize (R)
  wrap.innerHTML += `<div id="lk_dialog_r" class="lk_dialog"> <img class="lk_dialog_icon" src="./assets/vectors/Rkey.svg"/> <div class="lk_dialog_text"><div class="lk_dialog_line1">Mezclar</div><div class="lk_dialog_line2"></div></div></div>`;
  // Invert controls: only icon + single label, icon color indicates state
  wrap.innerHTML += `<div id="lk_dialog_i" class="lk_dialog"> <img id="lk_dialog_i_img" class="lk_dialog_icon" src="./assets/vectors/Ikey.svg"/> <div class="lk_dialog_text"><div class="lk_dialog_line1">Invertir controles</div><div class="lk_dialog_line2"></div></div></div>`;

    // Immediately set the inversion icon state (icon color flip only)
    try {
      const ideImg = document.getElementById('lk_dialog_i_img');
      if (ideImg) ideImg.style.filter = _controlsInverted ? 'invert(1) saturate(1.2)' : 'none';
    } catch(e) {}

    // Attach click handlers for interchangeable dialogs (except arrows)
    try {
      const rEl = document.getElementById('lk_dialog_r');
      if (rEl) {
        rEl.style.pointerEvents = 'auto';
        rEl.addEventListener('click', (ev)=>{ ev.stopPropagation(); try {
          if (_animating) return;
          for (let i=0;i<10;i++) _shuffleByMoves(_board, SHUFFLE_MOVES);
          _minimalMovesToBottomRight(_board);
          try { _renderBoard((_lastTextures || [])); } catch(e) {}
        } catch(e) { console.warn('Shuffle click failed', e); } });
      }
      const iEl = document.getElementById('lk_dialog_i');
      if (iEl) {
        iEl.style.pointerEvents = 'auto';
        iEl.addEventListener('click', (ev)=>{ ev.stopPropagation(); try {
          _controlsInverted = !_controlsInverted;
          const img = document.getElementById('lk_dialog_i_img'); if (img) img.style.filter = _controlsInverted ? 'invert(1) saturate(1.2)' : 'none';
        } catch(e) { console.warn('Invert click failed', e); } });
      }
      const hEl = document.getElementById('lk_dialog_h');
      if (hEl) {
        hEl.style.pointerEvents = 'auto';
        hEl.addEventListener('click', (ev)=>{ ev.stopPropagation(); try {
          // Show a transient help bubble describing controls
          let help = document.getElementById('lk_help_notify');
          if (!help) {
            help = document.createElement('div'); help.id = 'lk_help_notify'; help.className = 'lk_dialog';
            help.style.position = 'fixed'; help.style.left = '50%'; help.style.transform = 'translateX(-50%)'; help.style.bottom = '12vh'; help.style.zIndex = 100000; help.style.pointerEvents = 'none';
            help.innerHTML = `<div class="lk_dialog_text"><div class="lk_dialog_line1">Flechas: mover piezas</div><div class="lk_dialog_line2">R: Mezclar · I: Invertir controles</div></div>`;
            document.body.appendChild(help);
          }
          help.style.display = 'block';
          setTimeout(()=>{ try { if (help && help.parentNode) help.parentNode.removeChild(help); } catch(e){} }, 5000);
        } catch(e) { console.warn('Help click failed', e); } });
      }
    } catch(e) {}

  // wrap is purely informational; clicks should not interact with the dialog boxes
  wrap.style.pointerEvents = 'none';

    // create a small top-right F button (visible while puzzle solving) — smaller than the bottom bubble
    try {
      let topF = document.getElementById('lk_interact_topright');
      if (!topF) {
  topF = document.createElement('div'); topF.id = 'lk_interact_topright';
  topF.style.position = 'fixed'; topF.style.right = '12px'; topF.style.top = '12px'; topF.style.zIndex = 100002; topF.style.pointerEvents = 'auto';
        // use standardized markup but shrink padding and icon
        topF.innerHTML = `<div class="lk_dialog" style="padding:6px 8px; min-height:40px; max-width:14rem;"><img class="lk_dialog_icon" src="./assets/vectors/Fkey.svg"/><div class="lk_dialog_text"><div class="lk_dialog_line1">Volver</div></div></div>`;
        document.body.appendChild(topF);
        // reduce icon and text sizes for this small bubble
        try {
          const ico = topF.querySelector('.lk_dialog_icon'); if (ico) ico.style.height = '28px';
          const l1 = topF.querySelector('.lk_dialog_line1'); if (l1) l1.style.fontSize = '14px';
          const l2 = topF.querySelector('.lk_dialog_line2'); if (l2) l2.style.fontSize = '12px';
        } catch(e) {}
  topF.addEventListener('click', (ev)=>{ ev.stopPropagation(); try { hide(); } catch(e){} });
      } else {
        try { topF.style.display = 'block'; } catch(e) {}
      }
    } catch(e) {}
  } catch(e) {}
  // (rotation/hint removed)
  // attach keyboard handlers for arrow keys while puzzle is active (with solved detection)
  try {
    window._slidePuzzle_keyHandler = function(e){
      if (!(_active)) return;
      if (_animating) return; // block input during animations
      const code = e.code;
      let dir = null;
  // Inverted controls: Up should move the tile down into the blank, etc.
      // Map arrow keys according to inversion flag
      if (code === 'ArrowUp') dir = _controlsInverted ? 'D' : 'U';
      else if (code === 'ArrowDown') dir = _controlsInverted ? 'U' : 'D';
      else if (code === 'ArrowLeft') dir = _controlsInverted ? 'R' : 'L';
      else if (code === 'ArrowRight') dir = _controlsInverted ? 'L' : 'R';
      // Randomize (R)
      if (code === 'KeyR') {
        e.preventDefault();
        if (_animating) return;
        // reuse previous shuffle: 10 times
        for (let i=0;i<10;i++) _shuffleByMoves(_board, SHUFFLE_MOVES);
        _minimalMovesToBottomRight(_board);
        try { _renderBoard((_lastTextures || [])); } catch(e) {}
        console.log('SlidePuzzle: randomized via R');
        return;
      }
      // Toggle control inversion (I)
      if (code === 'KeyI') {
        e.preventDefault();
        _controlsInverted = !_controlsInverted;
        try {
          const el = document.getElementById('lk_dialog_i');
          if (el) {
            const state = el.querySelector('.lk_state'); if (state) state.textContent = _controlsInverted ? 'SÍ' : 'NO';
            const img = el.querySelector('img'); if (img) img.style.filter = _controlsInverted ? 'invert(1) saturate(1.2)' : 'none';
          }
        } catch(e) {}
        console.log('SlidePuzzle: inversion toggled', _controlsInverted);
        return;
      }
      if (!dir) return;
      e.preventDefault();
      console.log('SlidePuzzle:key', dir);
      const blank = _findBlank(_board);
      if (!blank) return;
      const sr = blank.r + (dir === 'U' ? -1 : (dir === 'D' ? 1 : 0));
      const sc = blank.c + (dir === 'L' ? -1 : (dir === 'R' ? 1 : 0));
      if (sr<0||sr>=ROWS||sc<0||sc>=COLS) {
        // illegal: prefer the tile in the attempted direction (sr,sc) to quiver — avoid quivering the blank mesh itself
        const dirVec = { 'U': [-1,0], 'D':[1,0], 'L':[0,-1], 'R':[0,1] }[dir] || [0,0];
        let mesh = null; let chosenAxis = 'x'; let chosenAmount = 0.04;
        // attempt preferred tile (sr,sc)
        if (sr>=0 && sr<ROWS && sc>=0 && sc<COLS) {
          const cand = (_tileMeshes && _tileMeshes[sr]) ? _tileMeshes[sr][sc] : null;
          // ensure candidate is not the blank (board value != 0)
          if (cand && _board[sr][sc] !== 0) {
            mesh = cand;
            if (dirVec[0] !== 0) { chosenAxis = 'y'; chosenAmount = (dirVec[0] > 0) ? -0.04 : 0.04; }
            else { chosenAxis = 'x'; chosenAmount = (dirVec[1] > 0) ? 0.04 : -0.04; }
          }
        }
        // fallback to opposite direction tile
        if (!mesh) {
          const oppR = blank.r - dirVec[0];
          const oppC = blank.c - dirVec[1];
          if (oppR>=0 && oppR<ROWS && oppC>=0 && oppC<COLS) {
            const cand = (_tileMeshes && _tileMeshes[oppR]) ? _tileMeshes[oppR][oppC] : null;
            if (cand && _board[oppR][oppC] !== 0) {
              mesh = cand;
              if (dirVec[0] !== 0) { chosenAxis = 'y'; chosenAmount = (dirVec[0] > 0) ? 0.04 : -0.04; }
              else { chosenAxis = 'x'; chosenAmount = (dirVec[1] > 0) ? -0.04 : 0.04; }
            }
          }
        }
        // final fallback: any orthogonal neighbor that is not blank
        if (!mesh) {
          const orth = (dir === 'L' || dir === 'R') ? [[-1,0],[1,0]] : [[0,-1],[0,1]];
          for (const off of orth) {
            const nr = blank.r + off[0], nc = blank.c + off[1];
            if (nr>=0 && nr<ROWS && nc>=0 && nc<COLS) {
              const cand = (_tileMeshes && _tileMeshes[nr]) ? _tileMeshes[nr][nc] : null;
              if (cand && _board[nr][nc] !== 0) { mesh = cand; if (off[0] !== 0) { chosenAxis = 'y'; chosenAmount = (off[0]>0)? -0.04:0.04; } else { chosenAxis='x'; chosenAmount=(off[1]>0)?0.04:-0.04; } break; }
            }
          }
        }
        if (mesh) { _animating = true; _animateQuiver(mesh, chosenAxis, chosenAmount, 140).then(()=>{ _animating = false; }); }
        console.log('SlidePuzzle:illegal move', dir);
        return;
      }
      // legal: animate source tile sliding into blank
      const mesh = (_tileMeshes && _tileMeshes[sr]) ? _tileMeshes[sr][sc] : null;
      const blankMesh = (_tileMeshes && _tileMeshes[blank.r]) ? _tileMeshes[blank.r][blank.c] : null;
      if (!mesh) {
        // still apply logical move and update board/visuals
        const moved = _applyMove(_board, dir);
        if (moved) {
          try { _renderBoard((_lastTextures || [])); } catch(e) {}
        }
        try { console.log('SlidePuzzle:board', _boardToIndexArray(_board)); } catch(e) {}
        return;
      }
      _animating = true;
      // compute world positions for mesh and blank
      const fromPos = mesh.position.clone();
      const toPos = (blankMesh) ? blankMesh.position.clone() : new THREE.Vector3((function(){
        // fallback compute
        const spacing = _tileSize * 0.98;
        const startX = - (COLS/2 - 0.5) * spacing;
        const startY = (ROWS/2 - 0.5) * spacing;
        return new THREE.Vector3(startX + blank.c*spacing, startY - blank.r*spacing, mesh.position.z);
      })());
      _animateMeshPosition(mesh, fromPos, toPos, 260).then(()=>{
        // swap meshes in tracking array and update board model
        _tileMeshes[blank.r][blank.c] = mesh;
        _tileMeshes[sr][sc] = blankMesh || null;
        // snap positions to canonical layout to avoid drift
        try { mesh.position.copy(toPos); if (blankMesh) blankMesh.position.copy(fromPos); } catch(e) {}
        const moved = _applyMove(_board, dir);
        try { console.log('SlidePuzzle:move result', moved); } catch(e) {}
        try { console.log('SlidePuzzle:board', _boardToIndexArray(_board)); } catch(e) {}
        _animating = false;
        // after move, check solved
        try {
          if (_isSolved()) {
            console.log('SlidePuzzle: solved detected');
            // fade in the missing final tile, then finish solved flow
            (async ()=>{
              try { _animating = true; await _fadeInBlank(600); } catch(e) { console.warn('SlidePuzzle: fade failed', e); }
              try { if (_scene && _scene.userData) { _scene.userData.puzzleSolved = true; _scene.userData.puzzleState = 'finished'; } } catch(e) {}
              try { const wrap = document.getElementById('lk_puzzle_wrap'); if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap); } catch(e) {}
              try { if (window._slidePuzzle_keyHandler) { window.removeEventListener('keydown', window._slidePuzzle_keyHandler); window._slidePuzzle_keyHandler = null; } } catch(e) {}
              try {
                // remove any interact bubbles so the 'Volver' affordance disappears on solve
                try { const b = document.getElementById('lk_interact'); if (b && b.parentNode) b.parentNode.removeChild(b); } catch(e) {}
                try { const tf = document.getElementById('lk_interact_topright'); if (tf && tf.parentNode) tf.parentNode.removeChild(tf); } catch(e) {}
                let sn = document.getElementById('lk_solved_notify');
                if (!sn) {
                  sn = document.createElement('div'); sn.id = 'lk_solved_notify';
                  sn.className = 'lk_dialog';
                  sn.style.position = 'fixed'; sn.style.left = '50%'; sn.style.transform = 'translateX(-50%)'; sn.style.bottom = '4vh'; sn.style.zIndex = 100000; sn.style.pointerEvents = 'none';
                  // show only text (no F icon) to avoid implying an F action after the puzzle is solved
                  sn.innerHTML = `<div class="lk_dialog_text"><div class="lk_dialog_line1">Conocimiento recuperado</div><div class="lk_dialog_line2"></div></div>`;
                  document.body.appendChild(sn);
                }
                sn.style.display = 'block';
                setTimeout(()=>{ try { if (sn && sn.parentNode) sn.parentNode.removeChild(sn); } catch(e){} }, 5000);
              } catch(e) {}
              try { if (_preTeleportPose && _scene && _scene.userData && _scene.userData.camera) { const cam = _scene.userData.camera; cam.position.copy(_preTeleportPose.pos); cam.quaternion.copy(_preTeleportPose.quat); if (_controls && _controls.getObject) { try { _controls.getObject().position.copy(cam.position); _controls.getObject().quaternion.copy(cam.quaternion); } catch(e){} } } } catch(e) {}
              _active = false;
              try { if (_scene && _scene.userData) _scene.userData.puzzleState = 'finished'; } catch(e) {}
              _animating = false;
            })();
          }
        } catch(e) { console.warn('SlidePuzzle: solved check failed', e); }
      });
    };
    window.addEventListener('keydown', window._slidePuzzle_keyHandler);
  } catch(e) {}
}

export function hide() {
  _active = false;
  // re-lock will be handled by main when toggling back; just hide
  if (_group && _group.parentGroup) {
    // Keep the parentGroup present and visible so the panel remains visible when exiting
    try { _group.parentGroup.visible = true; } catch(e) {}
    // Do NOT remove the parentGroup from the scene: puzzle should remain present after hide/exit
  }
  try { if (window._slidePuzzle_keyHandler) { window.removeEventListener('keydown', window._slidePuzzle_keyHandler); window._slidePuzzle_keyHandler = null; } } catch(e) {}
  // mark puzzle inactive but do not automatically re-lock pointer; unlocking must be reversed by pressing F
  try { if (_scene && _scene.userData) { if (_scene.userData.puzzleState !== 'finished') _scene.userData.puzzleState = 'loaded'; else _scene.userData.puzzleState = 'finished'; } } catch(e) {}
  // remove on-screen in-puzzle dialogues
  try { const wrap = document.getElementById('lk_puzzle_wrap'); if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap); } catch(e) {}
  // remove main small bubble so it doesn't linger; main.updateInteraction will recreate if appropriate
  try { const b = document.getElementById('lk_interact'); if (b && b.parentNode) b.parentNode.removeChild(b); } catch(e) {}
  try { const tf = document.getElementById('lk_interact_topright'); if (tf && tf.parentNode) tf.parentNode.removeChild(tf); } catch(e) {}
  // if the board is solved, set a solved flag and update the main F-dialogue text
  try {
    const flat = _boardToIndexArray(_board);
    const solved = flat.every((v, i) => (i === flat.length - 1 ? v === 0 : v === i+1));
    if (solved) {
      if (_scene && _scene.userData) { _scene.userData.puzzleSolved = true; _scene.userData.puzzleState = 'finished'; }
      // update main interact text if present
      try { const t = document.getElementById('lk_interact_text'); if (t) t.textContent = 'Conocimiento recuperado'; } catch(e) {}
      // do not re-enable the F bubble when solved; restore camera if we saved one
      try { if (_preTeleportPose && _scene && _scene.userData && _scene.userData.camera) { const cam = _scene.userData.camera; cam.position.copy(_preTeleportPose.pos); cam.quaternion.copy(_preTeleportPose.quat); if (_controls && _controls.getObject) { try { _controls.getObject().position.copy(cam.position); _controls.getObject().quaternion.copy(cam.quaternion); } catch(e){} } } } catch(e) {}
  } else {
  try { const t = document.getElementById('lk_interact_text'); if (t && (_scene && _scene.userData && _scene.userData.puzzleState === 'loaded')) t.textContent = 'Recuperar conocimiento'; } catch(e) {}
      // restore camera to previous pose when exiting without solving
      try { if (_preTeleportPose && _scene && _scene.userData && _scene.userData.camera) { const cam = _scene.userData.camera; cam.position.copy(_preTeleportPose.pos); cam.quaternion.copy(_preTeleportPose.quat); if (_controls && _controls.getObject) { try { _controls.getObject().position.copy(cam.position); _controls.getObject().quaternion.copy(cam.quaternion); } catch(e){} } } } catch(e) {}
      // restore movement controls to previous state
      try { if (_scene && _scene.userData) _scene.userData.controlsEnabled = !!(_preTeleportPose && _preTeleportPose.controlsEnabled); if (_preTeleportPose && _preTeleportPose.pointerLocked && _controls && _controls.lock) try { _controls.lock(); } catch(e) {} } catch(e) {}
    }
  } catch(e) {}
  // Do not modify or restore the skybox on hide: once loaded the sky should remain.
}

export function toggle() {
  if (_active) hide(); else show();
}

export function isActive(){ return !!_active; }

// Rotation control API
// Called every frame by main animate loop (no-op, kept for compatibility)
export function update(dt) { return; }

// Interact bubble management (moved from main.js)
// Ensure the bottom-centered interact bubble exists. This bubble is created lazily
// and is used by the main loop (via updateInteractBubble) to show the '[F] Volver' affordance.
// The bubble is interactive and clicking it will call hide().
function _ensureInteractBubble(){
  let b = document.getElementById('lk_interact');
  if (!b) {
    b = document.createElement('div'); b.id = 'lk_interact';
    b.style.pointerEvents = 'auto';
    b.style.cursor = 'pointer';
    // Use standardized dialog markup; main.css provides .lk_dialog rules
    b.innerHTML = `<div class="lk_dialog"><img id="lk_interact_icon" class="lk_dialog_icon" src="./assets/vectors/Fkey.svg"/><div class="lk_dialog_text"><div class="lk_dialog_line1" id="lk_interact_text">Volver</div></div></div>`;
    document.body.appendChild(b);
    b.addEventListener('click', (ev)=>{ ev.stopPropagation(); try { hide(); } catch(e){} });
  }
  return b;
}

// Called by main.updateInteraction(qualifies) to toggle visibility of the bottom-centered F bubble.
// visible: boolean indicating whether the player is looking at the panel.
export function updateInteractBubble(visible){
  try {
    const b = _ensureInteractBubble();
    if (!b) return;
    // visible when puzzle is loaded and player looks at panel; otherwise hide
    if (visible && _scene && _scene.userData && (_scene.userData.puzzleState === 'loaded' || _scene.userData.puzzleLoaded)) {
      b.style.display = 'block';
      // if puzzle solved, show 'Conocimiento recuperado' briefly
      if (_scene && _scene.userData && _scene.userData.puzzleState === 'finished') {
        const txt = document.getElementById('lk_interact_text'); if (txt) txt.textContent = 'Conocimiento recuperado';
        const tail = document.getElementById('lk_interact_tail'); if (tail) tail.textContent = '';
      } else {
        const txt = document.getElementById('lk_interact_text'); if (txt) txt.textContent = 'Recuperar conocimiento';
        const tail = document.getElementById('lk_interact_tail'); if (tail) tail.textContent = '';
      }
    } else {
      b.style.display = 'none';
    }
  } catch(e) {}
}
