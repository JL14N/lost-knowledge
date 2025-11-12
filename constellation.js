import * as THREE from 'https://unpkg.com/three@0.164.1/build/three.module.js';
import { AudioManager } from './audio_manager.js';

// Toggle to disable level-creation features while testing levels
const CREATION_DISABLED = true;

// ConstellationGame
// Usage: import { ConstellationGame } and call new ConstellationGame(scene, camera, renderer).load(sample)
// This implements the core mechanics described by the user:
// - show full constellation image, then start
// - click-and-drag lines between stars; colliders are larger than sprites
// - if you pass another star while dragging, it auto-joins
// - on mouseup validate links; if any incorrect, drop lines drawn during that click
// - stars turn to shining state when linked
// - "Show" button reveals the image again and drops all lines
// - some stars become shooting stars: they move and fade; linking them during their motion drops the click
// - on completion, show low-opacity image overlay and end the level

export class ConstellationGame {
  constructor(scene, camera, renderer, opts = {}) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.radius = opts.radius || 900; // skybox-level distance
    this.group = new THREE.Group();
    this.group.name = 'constellation_group';
    this.scene.add(this.group);

    this.textureLoader = new THREE.TextureLoader();
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    this.stars = []; // { sprite, collider, pos, linked:boolean, shooting:boolean }
    this.edges = new Set(); // correct edges (string 'a-b')
    this.permanentLines = []; // accepted lines in the scene
  this.matchedEdges = new Set(); // edges the player has committed

    // state for current drag
    this.dragging = false;
    this.currentPath = []; // indices of stars joined during this click
    this.currentLine = null; // mesh for dynamic line
    this.currentLinePositions = [];

    // DOM elements
    this.showButton = null;
    this.overlayImg = null;
    this.completionOverlay = null;

    // settings
    // Make stars larger by default to improve selection
    this.colliderScale = opts.colliderScale || 4.5; // collider is several times larger than sprite
    this.starSpriteScale = opts.starSpriteScale || 22.0; // visible sprite size (larger)

    this._boundPointerDown = this._onPointerDown.bind(this);
    this._boundPointerMove = this._onPointerMove.bind(this);
    this._boundPointerUp = this._onPointerUp.bind(this);

  this._pointerLocked = false;
  this._lastPointer = null;
  this._rotateSensitivity = opts.rotateSensitivity || 0.0025;

  // Temporary collections used during a single mouse click/drag
  this._tempLinesThisClick = [];
  this._edgesThisClick = [];
  this._starsLinkedThisClick = [];

  this.creationMode = false; // when true, clicking empty space creates stars and all links are allowed
  this._exportButton = null;

    this.onComplete = opts.onComplete || function(){ console.log('constellation: complete'); };

    this.sample = null; // stored sample data
  }

  // sample format: { image: 'path', stars: [{x,y,z},...], edges: [[i,j],[i,j],...], shooting: [index,...] }
  async load(sample) {
    this.sample = sample || this._makeSample();
    // reset matched edges for a fresh level
    this.matchedEdges = new Set();
    await this._createSprites();
    this._createUI();
    // start interaction immediately; do not auto-show the overlay image at level start
    this._startInteraction();
  }

  // create sprites/colliders from sample stars
  async _createSprites() {
    const emptyTex = await this._loadTexture('./assets/vectors/empty_star.svg');
    const filledTex = await this._loadTexture('./assets/vectors/star.svg');
    const shootingTex = await this._loadTexture('./assets/vectors/shooting_star.svg');

    for (let i=0;i<this.sample.stars.length;i++) {
      const s = this.sample.stars[i];
      // position on sphere of radius this.radius if only direction provided
      const pos = new THREE.Vector3(s.x, s.y, s.z).normalize().multiplyScalar(this.radius);
      // sprite
      const mat = new THREE.SpriteMaterial({ map: emptyTex, transparent: true, depthTest: true, depthWrite: false });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(this.starSpriteScale, this.starSpriteScale, 1);
      sprite.position.copy(pos);
      this.group.add(sprite);

      // collider: invisible sphere slightly larger
      const collGeom = new THREE.SphereGeometry(this.starSpriteScale * this.colliderScale * 0.5, 8, 8);
      const collMat = new THREE.MeshBasicMaterial({ visible: false });
      const collider = new THREE.Mesh(collGeom, collMat);
      collider.position.copy(pos);
      this.group.add(collider);

  const isShooting = (this.sample.shooting || []).includes(i);
  this.stars.push({ sprite, collider, pos, linked:false, shooting:isShooting, index: i, filledTex, emptyTex, shootingTex });
    }

    // build correct edges set
    this.edges.clear();
    for (const e of (this.sample.edges || [])) {
      const key = this._edgeKey(e[0], e[1]);
      this.edges.add(key);
    }
  }

  _edgeKey(a,b){ return (a<b) ? `${a}-${b}` : `${b}-${a}`; }

  async _loadTexture(path){
    return new Promise((res, rej) => this.textureLoader.load(path, res, undefined, rej));
  }

  _createUI() {
    // show button
    if (!this.showButton) {
      const btn = document.createElement('button');
      btn.textContent = 'Show constellation';
      btn.style.position = 'fixed'; btn.style.left = '8px'; btn.style.bottom = '8px'; btn.style.zIndex = 200000;
      document.body.appendChild(btn);
      btn.addEventListener('click', () => { this._showFullImage(); this._clearAllLines(); });
      this.showButton = btn;
    }

    // overlay image (full constellation) as DOM image
    if (!this.overlayImg && this.sample.image) {
      const img = document.createElement('img');
      img.src = this.sample.image;
      img.style.position = 'fixed'; img.style.left = '50%'; img.style.top = '50%'; img.style.transform = 'translate(-50%,-50%)';
      img.style.zIndex = 199999; img.style.maxWidth = '60%'; img.style.maxHeight = '60%'; img.style.pointerEvents = 'none';
      // keep show-image at a consistent 60% opacity per user request
      img.style.opacity = '0.6';
      img.style.display = 'none';
      document.body.appendChild(img);
      this.overlayImg = img;
    }

    // completion overlay
    if (!this.completionOverlay && this.sample.image) {
      const img = document.createElement('img');
      img.src = this.sample.image;
      img.style.position = 'fixed'; img.style.left = '50%'; img.style.top = '50%'; img.style.transform = 'translate(-50%,-50%)';
      img.style.zIndex = 200001; img.style.maxWidth = '80%'; img.style.maxHeight = '80%'; img.style.pointerEvents = 'none';
      // use 60% opacity for completion overlay as well
      img.style.opacity = '0.6'; img.style.display = 'none';
      document.body.appendChild(img);
      this.completionOverlay = img;
    }
  }

  // Public helper to clear any drawn lines (permanent and temporary)
  clearAllLines() {
    try { this._clearAllLines(); } catch (e) { /* ignore */ }
  }

  _showFullImageThenStart() {
    if (!this.overlayImg) { this._startInteraction(); return; }
    this.overlayImg.style.display = 'block';
    setTimeout(() => { this.overlayImg.style.display = 'none'; this._startInteraction(); }, 2200);
  }

  _showFullImage(){ if (this.overlayImg) this.overlayImg.style.display = 'block'; setTimeout(()=>{ if (this.overlayImg) this.overlayImg.style.display = 'none'; }, 2200); }

  _startInteraction() {
    // attach event listeners
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this._boundPointerDown);
    window.addEventListener('pointermove', this._boundPointerMove);
    window.addEventListener('pointerup', this._boundPointerUp);

    // start any shooting star animations
    this._startShootingStars();
  }

  _startShootingStars(){
    for (const s of this.stars) {
      if (!s.shooting) continue;
      // random direction on small arc
      s._shootTarget = s.pos.clone().multiplyScalar(0.9).add(new THREE.Vector3((Math.random()-0.5)*200, (Math.random()-0.5)*200, (Math.random()-0.5)*200));
      s._shootProgress = Math.random() * 2.0; // start at random phase
      s._shootSpeed = 0.2 + Math.random() * 0.4;
    }
  }

  _onPointerDown(ev) {
    ev.preventDefault();
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);

    // detect star under pointer using colliders
    const colliders = this.stars.map(s => s.collider);
    const hits = this.raycaster.intersectObjects(colliders, true);
    // If we're in creation mode and clicked empty space, create a new star
    if (hits.length === 0 && this.creationMode) {
      if (!CREATION_DISABLED) {
        this._createStarAtPointer(ev);
        return;
      } else {
        // creation disabled, ignore empty-space clicks
        return;
      }
    }
    if (hits.length === 0) return; // click empty space
    const hit = hits[0];
    const idx = this.stars.findIndex(s => s.collider === hit.object);
    if (idx < 0) return;

    // begin drag from this star
    this.dragging = true;
    this.currentPath = [idx];
    this._lastPointer = { x: ev.clientX, y: ev.clientY };
    // reset per-click temporary collections
    this._tempLinesThisClick = [];
    this._edgesThisClick = [];
    this._starsLinkedThisClick = [];
    // Start a dynamic line whose start is the first star
    this._createDynamicLine(this.stars[idx].pos.clone(), this.stars[idx].pos.clone());

    // If this star is a shooting star that's currently in motion, linking it should drop the click
    if (this.stars[idx].shooting) {
      // cause current click to drop immediately
      this._dropCurrentClick();
    }
  }

  _onPointerMove(ev) {
    if (!this.dragging) return;
    // Do not directly rotate the camera here. PointerLockControls (created in philosophy.js)
    // will be responsible for camera rotation when pointer is locked. We keep _lastPointer
    // only for potential future debug; avoid accumulating deltas that can increase sensitivity.
    if (this._lastPointer) {
      this._lastPointer.x = ev.clientX; this._lastPointer.y = ev.clientY;
    }
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);

    // project onto sphere at radius where stars live (approx)
    const dir = this.raycaster.ray.direction.clone();
    const origin = this.raycaster.ray.origin.clone();
    // intersect with sphere centered at 0 radius
    const camToCenter = origin.clone().negate();
    const a = dir.dot(dir);
    const b = 2 * dir.dot(origin);
    const c = origin.dot(origin) - (this.radius * this.radius);
    const disc = b*b - 4*a*c;
    let point = null;
    if (disc >= 0) {
      const t = (-b + Math.sqrt(disc)) / (2*a);
      point = origin.clone().add(dir.clone().multiplyScalar(t));
    } else {
      // fallback to far point
      point = origin.clone().add(dir.multiplyScalar(1000));
    }

    // update dynamic line end
    if (this.currentLine) {
      const pos = this.currentLine.geometry.attributes.position.array;
      pos[3] = point.x; pos[4] = point.y; pos[5] = point.z;
      this.currentLine.geometry.attributes.position.needsUpdate = true;
    }

    // check for passing other colliders along the way: do a small sphere test near the ray
    const colliders = this.stars.map(s => s.collider);
    const hits = this.raycaster.intersectObjects(colliders, true);
    for (const h of hits) {
      const idx = this.stars.findIndex(s => s.collider === h.object);
      if (idx < 0) continue;
      const last = this.currentPath[this.currentPath.length-1];
      if (idx === last) continue; // already at this star
      // Finalize the previous segment immediately, but as a temporary segment for this click.
      this._finalizeSegmentAndStartNew(last, idx);
      break; // only handle first encountered per move
    }
  }

  _onPointerUp(ev) {
    if (!this.dragging) return;
    this.dragging = false;
    // reset pointer tracking
    this._lastPointer = null;

    // Validate the edges created during this click. If any invalid and NOT creationMode, drop entire click.
    let bad = false;
    for (const e of this._edgesThisClick) {
      if (!this.creationMode && !this.edges.has(e)) { bad = true; break; }
    }
    if (bad) {
      this._dropCurrentClick();
    } else {
      // commit temp lines to permanent (or if creationMode, also add edges to allowed set)
      this._commitTempLines();
    }
  }

  // Finalize the segment between a->b immediately and start a new dynamic line from b
  _finalizeSegmentAndStartNew(aIdx, bIdx) {
    // create a TEMPORARY line between a and b (commit on mouseup if the entire click is valid)
    const aPos = this.stars[aIdx].pos.clone();
    const bPos = this.stars[bIdx].pos.clone();
    const arr = new Float32Array([aPos.x, aPos.y, aPos.z, bPos.x, bPos.y, bPos.z]);
    const geom = new THREE.BufferGeometry(); geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xffdd88, linewidth: 2 });
    const line = new THREE.Line(geom, mat);
    this.scene.add(line);
    this._tempLinesThisClick.push(line);
    // record the edge key for validation
    this._edgesThisClick.push(this._edgeKey(aIdx, bIdx));

    // visually mark stars as linked for this click (record so we can revert)
    const sa = this.stars[aIdx]; const sb = this.stars[bIdx];
    if (!sa._linkedTemp) { sa._linkedTemp = true; this._starsLinkedThisClick.push(aIdx); if (sa.filledTex) sa.sprite.material.map = sa.filledTex; }
    if (!sb._linkedTemp) { sb._linkedTemp = true; this._starsLinkedThisClick.push(bIdx); if (sb.filledTex) sb.sprite.material.map = sb.filledTex; }
  try { AudioManager.play('philosophy:on-star-link'); } catch(e) {}

    // prepare new dynamic line starting at bPos
    if (this.currentLine) { try { this.scene.remove(this.currentLine); } catch(e) {} }
    this.currentLinePositions = [bPos.clone(), bPos.clone()];
    const geometry = new THREE.BufferGeometry(); const positions = new Float32Array(6);
    positions[0] = bPos.x; positions[1] = bPos.y; positions[2] = bPos.z;
    positions[3] = bPos.x; positions[4] = bPos.y; positions[5] = bPos.z;
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const dynMat = new THREE.LineBasicMaterial({ color: 0xffffcc, linewidth: 2 });
    const dyn = new THREE.Line(geometry, dynMat);
    this.scene.add(dyn); this.currentLine = dyn;

    // update currentPath: now it only contains bIdx as the active start
    this.currentPath = [bIdx];
  }

  _commitTempLines() {
    // move temp lines into permanent collection
    for (const l of this._tempLinesThisClick) this.permanentLines.push(l);
    // if in creation mode, add the edges to the allowed set
    if (this.creationMode) {
      for (const e of this._edgesThisClick) this.edges.add(e);
    }
    // record matched edges (player-created) so we can check completion
    for (const e of this._edgesThisClick) this.matchedEdges.add(e);
    // mark stars permanently linked and clear temporary flags
    for (const idx of this._starsLinkedThisClick) {
      const s = this.stars[idx]; s.linked = true; s._linkedTemp = false;
    }
    this._tempLinesThisClick = [];
    this._edgesThisClick = [];
    this._starsLinkedThisClick = [];
    // clear current dynamic
    if (this.currentLine) { try { this.scene.remove(this.currentLine); } catch(e) {} this.currentLine = null; }
    this.currentLinePositions = [];
    this.currentPath = [];
    this._checkCompletion();
  }

  _createDynamicLine(start, end) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(6);
    positions[0] = start.x; positions[1] = start.y; positions[2] = start.z;
    positions[3] = end.x; positions[4] = end.y; positions[5] = end.z;
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xffffcc, linewidth: 2 });
    const line = new THREE.Line(geometry, mat);
    this.scene.add(line);
    this.currentLine = line;
    this.currentLinePositions = [start.clone(), end.clone()];
  }

  _appendStarToCurrentPath(idx) {
    if (!this.currentLine) return;
    const lastPos = this.currentLinePositions[this.currentLinePositions.length-1].clone();
    const nextPos = this.stars[idx].pos.clone();
    // replace current end with nextPos and extend geometry
    const oldPos = this.currentLine.geometry.attributes.position.array;
    const newCount = (this.currentLinePositions.length+1) * 3;
    const newArr = new Float32Array(newCount);
    for (let i=0;i<(this.currentLinePositions.length*3);i++) newArr[i] = oldPos[i];
    newArr[newArr.length-3] = nextPos.x; newArr[newArr.length-2] = nextPos.y; newArr[newArr.length-1] = nextPos.z;
    this.currentLine.geometry.setAttribute('position', new THREE.BufferAttribute(newArr, 3));
    this.currentLine.geometry.attributes.position.needsUpdate = true;
    this.currentLinePositions.push(nextPos);
    this.currentPath.push(idx);

    // if the star is a shooting star, linking it causes drop
    if (this.stars[idx].shooting) {
      // animate fade out then drop
      this._fadeOutSprite(this.stars[idx].sprite, 600).then(()=>{
        this._dropCurrentClick();
      });
    }
    try { AudioManager.play('philosophy:on-star-link'); } catch(e) {}
  }

  _fadeOutSprite(sprite, dur=600){
    return new Promise((resolve)=>{
      const mat = sprite.material;
      const start = performance.now();
      const from = mat.opacity !== undefined ? mat.opacity : 1.0;
      function step(now){
        const t = Math.min(1, (now - start)/dur);
        mat.opacity = from * (1 - t);
        if (t<1) requestAnimationFrame(step); else resolve();
      }
      requestAnimationFrame(step);
    });
  }

  _dropCurrentClick() {
    // remove current dynamic line
    if (this.currentLine) { try { this.scene.remove(this.currentLine); } catch(e) {} this.currentLine = null; }
    // remove any temporary lines created during this click
    for (const l of this._tempLinesThisClick) { try { this.scene.remove(l); } catch(e) {} }
    this._tempLinesThisClick = [];
    // revert temporary linked visual state on stars
    for (const idx of this._starsLinkedThisClick) {
      const s = this.stars[idx];
      s._linkedTemp = false;
      // revert to empty sprite if not permanently linked
      if (!s.linked && s.emptyTex) s.sprite.material.map = s.emptyTex;
    }
    this._starsLinkedThisClick = [];
    this._edgesThisClick = [];
    this.currentLinePositions = [];
    this.currentPath = [];
  }

  _acceptCurrentPath() {
    if (!this.currentLine) return;
    // convert dynamic line to permanent lines between star positions
    // for simplicity create a single polyline
    const pts = this.currentLinePositions.slice();
    const arr = new Float32Array(pts.length * 3);
    for (let i=0;i<pts.length;i++) { arr[i*3] = pts[i].x; arr[i*3+1] = pts[i].y; arr[i*3+2] = pts[i].z; }
    const geom = new THREE.BufferGeometry(); geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xffdd88, linewidth: 2 });
    const line = new THREE.Line(geom, mat);
    this.scene.add(line);
    this.permanentLines.push(line);

    // mark stars as linked and change sprite
    for (const idx of this.currentPath) {
      const s = this.stars[idx];
      if (!s.linked) {
        s.linked = true;
        if (s.filledTex) s.sprite.material.map = s.filledTex;
        // animate shine: scale pulse
        this._pulseSprite(s.sprite);
        try { AudioManager.play('philosophy:on-star-link'); } catch(e) {}
      }
    }

    // clear dynamic
    if (this.currentLine) { try { this.scene.remove(this.currentLine); } catch(e) {} this.currentLine = null; }
    this.currentLinePositions = [];
    this.currentPath = [];

    // check completion
    this._checkCompletion();
  }

  _pulseSprite(sprite){
    const from = sprite.scale.x; const target = from * 1.5; const dur = 500; const start = performance.now();
    function step(now){
      const t = Math.min(1, (now - start)/dur);
      const tt = t < 0.5 ? 2*t*t : -1 + (4-2*t)*t;
      sprite.scale.set(from + (target-from)*tt, from + (target-from)*tt, 1);
      if (t<1) requestAnimationFrame(step); else {
        // return to original
        const start2 = performance.now(); const dur2 = 300; function step2(now2){ const u = Math.min(1,(now2-start2)/dur2); sprite.scale.set(target + (from-target)*u, target + (from-target)*u,1); if (u<1) requestAnimationFrame(step2); }
        requestAnimationFrame(step2);
      }
    }
    requestAnimationFrame(step);
  }

  _checkCompletion() {
    // If the level specifies required edges, completion means every required edge has been matched.
    if (this.edges && this.edges.size > 0) {
      let allEdges = true;
      for (const e of this.edges) { if (!this.matchedEdges.has(e)) { allEdges = false; break; } }
      if (allEdges) this._onComplete();
      return;
    }
    // fallback: completion when all stars have linked = true
    const all = this.stars.every(s => s.linked);
    if (all) this._onComplete();
  }

  _onComplete() {
    // delegate completion handling to the caller via onComplete callback
    try { this.onComplete(); } catch(e) {}
  }

  _clearAllLines() {
    for (const l of this.permanentLines) try { this.scene.remove(l); } catch(e) {}
    this.permanentLines = [];
    // reset stars
    for (const s of this.stars) {
      s.linked = false; if (s.emptyTex) s.sprite.material.map = s.emptyTex;
      s.sprite.material.opacity = 1.0;
      s.sprite.scale.set(this.starSpriteScale, this.starSpriteScale,1);
    }
    if (this.completionOverlay) this.completionOverlay.style.display = 'none';
  }

  // very small sample for testing: 6 stars in a simple shape
  _makeSample() {
    const dirs = [
      new THREE.Vector3(0,1,0), new THREE.Vector3(0.3,0.9,0.1), new THREE.Vector3(0.6,0.8,0.2),
      new THREE.Vector3(-0.3,0.7,0.2), new THREE.Vector3(-0.6,0.5,0.2), new THREE.Vector3(0,0.2,0.9)
    ];
    const stars = dirs.map(d=> ({ x: d.x, y: d.y, z: d.z }));
    const edges = [[0,1],[1,2],[0,3],[3,4],[0,5]];
    const shooting = [2];
    return { image: './assets/skyboxes/philosophy/success.jpg', stars, edges, shooting };
  }

  _createStarAtPointer(ev) {
    // create a star at the pointer direction on the radius sphere
    const rect = this.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(mouse, this.camera);
    const dir = ray.ray.direction.clone();
    const origin = ray.ray.origin.clone();
    // intersect sphere
    const a = dir.dot(dir);
    const b = 2 * dir.dot(origin);
    const c = origin.dot(origin) - (this.radius * this.radius);
    const disc = b*b - 4*a*c;
    let point = null;
    if (disc >= 0) {
      const t = (-b + Math.sqrt(disc)) / (2*a);
      point = origin.clone().add(dir.clone().multiplyScalar(t));
    } else {
      point = origin.clone().add(dir.multiplyScalar(this.radius));
    }
    // create sprite and collider
    const emptyTex = this.stars.length ? this.stars[0].emptyTex : null;
    const filledTex = this.stars.length ? this.stars[0].filledTex : null;
    const shootingTex = this.stars.length ? this.stars[0].shootingTex : null;
    const mat = new THREE.SpriteMaterial({ map: filledTex || emptyTex, transparent: true, depthTest: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat); sprite.scale.set(this.starSpriteScale, this.starSpriteScale, 1); sprite.position.copy(point); this.group.add(sprite);
    const collGeom = new THREE.SphereGeometry(this.starSpriteScale * this.colliderScale * 0.5, 8, 8);
    const collMat = new THREE.MeshBasicMaterial({ visible: false });
    const collider = new THREE.Mesh(collGeom, collMat); collider.position.copy(point); this.group.add(collider);
    const idx = this.stars.length;
    this.stars.push({ sprite, collider, pos: point.clone(), linked: true, shooting:false, index: idx, filledTex, emptyTex, shootingTex });
    // add immediate visual linked state for creator
    if (filledTex) sprite.material.map = filledTex;
    // update export UI
    this._ensureExportButton();
  }

  _ensureExportButton() {
    if (CREATION_DISABLED) return;
    if (this._exportButton) return;
    const btn = document.createElement('button'); btn.textContent = 'Export constellation';
    btn.style.position = 'fixed'; btn.style.left = '8px'; btn.style.bottom = '44px'; btn.style.zIndex = 200000;
    document.body.appendChild(btn);
    btn.addEventListener('click', () => {
      const data = { stars: this.stars.map(s => ({ x: s.pos.x/this.radius, y: s.pos.y/this.radius, z: s.pos.z/this.radius })), edges: Array.from(this.edges).map(k => k.split('-').map(n=>parseInt(n,10))) };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'constellation.json'; a.click(); URL.revokeObjectURL(url);
    });
    this._exportButton = btn;
  }

  dispose(){
    // cleanup listeners and DOM
    const el = this.renderer.domElement; el.removeEventListener('pointerdown', this._boundPointerDown);
    window.removeEventListener('pointermove', this._boundPointerMove); window.removeEventListener('pointerup', this._boundPointerUp);
    if (this.showButton && this.showButton.parentNode) this.showButton.parentNode.removeChild(this.showButton);
    if (this.overlayImg && this.overlayImg.parentNode) this.overlayImg.parentNode.removeChild(this.overlayImg);
    if (this.completionOverlay && this.completionOverlay.parentNode) this.completionOverlay.parentNode.removeChild(this.completionOverlay);
    try { this.scene.remove(this.group); } catch(e) {}
  }
}
