
// Lost Knowledge - main scene script
// Static stairs reconstruction mode
//  Click canvas: lock pointer (look around)
//  W A S D : move
//  Q / E   : descend / ascend camera
import * as THREE from 'https://unpkg.com/three@0.164.1/build/three.module.js';
import { GLTFLoader } from 'https://unpkg.com/three@0.164.1/examples/jsm/loaders/GLTFLoader.js';
import { RGBELoader } from 'https://unpkg.com/three@0.164.1/examples/jsm/loaders/RGBELoader.js';
import { PointerLockControls } from 'https://unpkg.com/three@0.164.1/examples/jsm/controls/PointerLockControls.js';

// --- Scene Setup ---
let scene, camera, renderer, controls;
let stairsRef = null;          // base stairs segment
let towerRef = null;           // tower root
let stairsGroup = null;        // group containing all stair segments for whole-stack transforms
// Visibility limiter planes (follow camera)
let topLimiter = null;
let bottomLimiter = null;
// Interaction plane and UI
let interactivePlane = null;
let interactivePlaneVisible = false;
const INTERACT_MAX_DIST = 2.5; // meters (will be used along with responsive checks)
const INTERACT_DOT_THRESHOLD = 0.95; // forward dot threshold (how directly the camera must point)

// Provided JSON data (may include unsorted Y values & manual tweaks)
const stairsSegmentsData = [
  { "position": { "x": -2, "y": 6.25, "z": 17.4 }, "rotation": { "x": 0, "y": 0, "z": 0 }, "scale": { "x": 0.574, "y": 0.53, "z": 0.574 } },
  { "position": { "x": -2, "y": 10.572143951743062, "z": 17.4 }, "rotation": { "x": 0, "y": 0, "z": 0 }, "scale": { "x": 0.574, "y": 0.53, "z": 0.574 } },
  { "position": { "x": -2, "y": 1.9292879034861175, "z": 17.4 }, "rotation": { "x": 0, "y": 0, "z": 0 }, "scale": { "x": 0.574, "y": 0.53, "z": 0.574 } },
  { "position": { "x": -2, "y": 14.896431855229162, "z": 17.4 }, "rotation": { "x": 0, "y": 0, "z": 0 }, "scale": { "x": 0.574, "y": 0.53, "z": 0.574 } }
];


function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x202225);

  camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  // Start camera at the corrected TOP sample position
  camera.position.set(0.9745185184179505, 11.516213485322599, -2.2217748539252415);

  // Save a guaranteed 'start' camera pose here so async model loads can't be influenced
  // by the user moving/looking before models finish loading.
  scene.userData = scene.userData || {};
  scene.userData.startCameraPose = {
    pos: camera.position.clone(),
    quat: camera.quaternion.clone()
  };

  renderer = new THREE.WebGLRenderer({
    canvas: document.querySelector('#myCanvas'),
    antialias: false
  });
  // lower pixel ratio to reduce AA/shader cost on slower machines
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.0));
  // tone mapping/exposure to reduce overall lightness
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.00; // increased so scene is brighter by default
  // reduce shadow and PBR cost
  renderer.shadowMap.enabled = false;
  renderer.physicallyCorrectLights = false;
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function initControls() {
  controls = new PointerLockControls(camera, renderer.domElement);
  renderer.domElement.addEventListener('click', () => controls.lock());
  controls.addEventListener('lock',   () => console.log('Pointer locked'));
  controls.addEventListener('unlock', () => console.log('Pointer unlocked'));
  // Attach camera-following fill light if it was created in initLighting()
  if (scene.userData && scene.userData.cameraLightGroup) {
    camera.add(scene.userData.cameraLightGroup);
  }
}

function initLighting() {
  // Slightly stronger hemisphere and directional fill for general lighting
  const hemi = new THREE.HemisphereLight(0xffffff, 0x666666, 0.35);
  hemi.position.set(0, 1, 0);
  scene.add(hemi);

  const dir = new THREE.DirectionalLight(0xffffff, 0.2);
  dir.position.set(3, 5, 2);
  scene.add(dir);

  // Ambient fill
  const ambient = new THREE.AmbientLight(0xffffff, 0.8);
  scene.add(ambient);

  // Camera-following point light (headlamp) to brighten immediate surroundings
  const cameraLightGroup = new THREE.Group();
  const camFill = new THREE.PointLight(0xffffff, 1.4, 55, 2);
  camFill.position.set(0, 0, 0);
  cameraLightGroup.add(camFill);
  // Keep a reference so it can be attached when camera is created
  scene.userData.cameraLightGroup = cameraLightGroup;
}

// Create a fuzzy radial alpha texture (canvas) for limiter planes
function createFuzzyTexture(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const grd = ctx.createRadialGradient(size/2, size/2, size*0.05, size/2, size/2, size/2);
  // center moderately opaque -> edges transparent (softer fade)
  grd.addColorStop(0.0, 'rgba(0,0,0,0.80)');
  grd.addColorStop(0.6, 'rgba(0,0,0,0.35)');
  grd.addColorStop(1.0, 'rgba(0,0,0,0.0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0,0,size,size);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

function createLimiterPlanes() {
  // Create a small depth-writing occluder (core) and a larger soft alpha overlay.
  const coreSize = 6;
  const coreMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: false, depthTest: true, depthWrite: true, side: THREE.DoubleSide });
  const mistTex = createFuzzyTexture();
  // The overlay uses the fuzzy canvas as an alphaMap for a soft edge and does NOT write depth
  const overlayMat = new THREE.MeshBasicMaterial({ map: mistTex, transparent: true, opacity: 0.70, depthTest: true, depthWrite: false, side: THREE.DoubleSide, alphaMap: mistTex });

  topLimiter = new THREE.Mesh(new THREE.PlaneGeometry(coreSize, coreSize), coreMat.clone());
  bottomLimiter = new THREE.Mesh(new THREE.PlaneGeometry(coreSize, coreSize), coreMat.clone());
  topLimiter.rotation.x = -Math.PI / 2;
  bottomLimiter.rotation.x = -Math.PI / 2;
  topLimiter.userData.zBias = -0.01;
  bottomLimiter.userData.zBias = 0.01;
  scene.add(topLimiter);
  scene.add(bottomLimiter);

  // Overlay planes are larger and soft; they will be positioned above the core but share only Y movement
  const overlaySize = 28;
  const topOverlay = new THREE.Mesh(new THREE.PlaneGeometry(overlaySize, overlaySize), overlayMat.clone());
  const bottomOverlay = new THREE.Mesh(new THREE.PlaneGeometry(overlaySize, overlaySize), overlayMat.clone());
  topOverlay.rotation.x = -Math.PI / 2;
  bottomOverlay.rotation.x = -Math.PI / 2;
  // store overlays for vertical following; don't parent them to limiter cores so we can control XZ independently
  topLimiter.userData.overlay = topOverlay;
  bottomLimiter.userData.overlay = bottomOverlay;
  scene.add(topOverlay);
  scene.add(bottomOverlay);
}

function updateLimiterPlanes() {
  if (!topLimiter || !bottomLimiter || !camera) return;
  const rings = 3;
  const dy = rings * helix.pitch;
  // Position occluder cores at helix.center XZ but follow the player's Y so the occlusion feels anchored to the tower
  const cx = helix.center.x, cz = helix.center.y;
  topLimiter.position.set(cx, camera.position.y + dy + (topLimiter.userData.zBias || 0), cz);
  bottomLimiter.position.set(cx, camera.position.y - dy + (bottomLimiter.userData.zBias || 0), cz);
  // Position the soft overlay at the same XZ as the core but allow it to be slightly offset in Y to avoid z-fighting
  const topOverlay = topLimiter.userData.overlay;
  const bottomOverlay = bottomLimiter.userData.overlay;
  if (topOverlay) topOverlay.position.set(cx, camera.position.y + dy + 0.01, cz);
  if (bottomOverlay) bottomOverlay.position.set(cx, camera.position.y - dy - 0.01, cz);
}

// --- Interaction helpers ---
function createInteractivePlane() {
  // Small red plane to mark the window; size will be proportional to camera fov/screen
  const geo = new THREE.PlaneGeometry(1.0, 0.6);
  const mat = new THREE.MeshBasicMaterial({ color: 0x00000000, transparent: true, opacity: 0.0, side: THREE.DoubleSide });
  const plane = new THREE.Mesh(geo, mat);
  plane.name = 'interactiveWindowMarker';
  // We'll position this relative to the tower after model load; default invisible
  plane.visible = false;
  scene.add(plane);
  interactivePlane = plane;
}

function createInteractionUI() {
  // inject Google Font and basic styles
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;700&display=swap';
  document.head.appendChild(link);

  const style = document.createElement('style');
  style.textContent = `
    #lk_interact { position: fixed; left: 50%; transform: translateX(-50%); bottom: 6vh; pointer-events: none; z-index: 10000; font-family: 'Cinzel', serif; display: flex; align-items:center; gap:0.6rem; }
    #lk_interact .panel { background: rgba(0,0,0,0.55); color: #fff; padding: 0.6rem 1rem; border-radius: 8px; font-size: calc(12px + 0.4vh); display:inline-flex; align-items:center; gap:0.4rem; }
  #lk_interact img { height: calc(22px + 0.8vh); width: auto; display:inline-block; vertical-align:middle; }
    #lk_interact.hidden { display:none; }
  `;
  document.head.appendChild(style);

  const el = document.createElement('div');
  el.id = 'lk_interact';
  el.className = 'hidden';
  el.innerHTML = '<div class="panel"><div id="lk_interact_text">Presiona <img id="lk_interact_key" src="./assets/vectors/Fkey.svg" alt="F" style="height:1.5em; vertical-align:middle; margin:0 0.35rem; display:inline-block;"/> para recuperar el conocimiento</div></div>';
  document.body.appendChild(el);
}

function updateInteraction() {
  if (!interactivePlane || !camera || !scene.userData || !scene.userData.modelsLoaded) return;
  // compute distance from camera to plane
  const camPos = camera.position;
  const planePos = interactivePlane.getWorldPosition(new THREE.Vector3());
  const toPlane = new THREE.Vector3().subVectors(planePos, camPos);
  const dist = toPlane.length();
  // get camera forward
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  const dot = forward.dot(toPlane.normalize());
  const qualifies = dist <= INTERACT_MAX_DIST && dot >= INTERACT_DOT_THRESHOLD;
  const ui = document.getElementById('lk_interact');
  if (qualifies) {
    if (ui) ui.classList.remove('hidden');
    interactivePlane.material.color.set(0xff6666);
    interactivePlaneVisible = true;
  } else {
    if (ui) ui.classList.add('hidden');
    interactivePlane.material.color.set(0xff3333);
    interactivePlaneVisible = false;
  }
}

// Key handler for interaction
window.addEventListener('keydown', (e)=>{
  if (e.code === 'KeyF' && interactivePlaneVisible) {
    // simple feedback action: flash text and log
    const t = document.getElementById('lk_interact_text');
    if (t) {
      t.textContent = 'Conocimiento recuperado';
      setTimeout(()=>{ if (t) t.textContent = 'Presiona F para recuperar el conocimiento'; }, 2000);
    }
    console.log('Interact: recovered knowledge');
  }
});



function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// --- Movement (camera) ---
const keys = {};
const WALK_SPEED = 3.0;
const RUN_MULT = 1.8;
const FLOOR_Y = 0.1; // minimal floor height when flying down

// Helical band constraint config
const helix = {
  enabled: true,
  center: new THREE.Vector2(0, 0), // set to tower XZ after load
  radius: 5.0,
  thickness: 0.6, // allowed band thickness (radius +/- thickness/2)
  pitch: 3.0,     // vertical rise per full revolution (2PI)
  baseY: 0.0,     // anchor Y for theta=0
  offsetY: 0.0    // user vertical offset applied to whole helix (adjusted by Q/E)
};

// Convenience flag to indicate inverted winding (pitch sign handled directly)
// Permanently invert helix as requested
helix.inverted = true;
// track continuous angle (radians) so we can span multiple revolutions
helix.lastTheta = 0;
// small cooldown (ms) to avoid immediate repeated wrapping when near threshold
helix.wrapCooldown = 250;
helix._lastWrapTime = 0;

// --- Permanent helix calibration (user-provided) ---
// These values were measured and should be treated as authoritative for this scene.
window._helixTop = {
  x: -0.8308358640774964,
  y: 19.277361614729536,
  z: -1.2965045326129125,
  theta: -33.936299897535235,
  helixY: 19.277361614729536,
  radius: 2.213723533344434
};
window._helixBottom = {
  x: -0.8308358640774964,
  y: 1.9769616146937727,
  z: -1.2965045326129125,
  theta: -33.936299897535235,
  helixY: 1.9769616146937727,
  radius: 2.213723533344434
};
// Number of full helix rings between bottom and top (user-provided)
window._helixRingsOverride = 8;
// Measured pitch per revolution (vertical per 2π)
helix.pitch = 2.16255; // from HelixTopBottomReport.pitchMeasured
// set lastTheta to the measured continuous theta (prevents initial jumps)
helix.lastTheta = window._helixTop.theta;
// Hardcode helix.radius to the requested authoritative value and compute baseY from embedded sample
helix.radius = 1.943; // hardcoded per user request
// recompute baseY so that helixY = baseY + sign*(theta/2π)*pitch + offsetY matches measured helixY
{
  const sign = helix.inverted ? -1 : 1;
  const theta = helix.lastTheta;
  helix.baseY = window._helixTop.helixY - sign * (theta / (2 * Math.PI)) * helix.pitch - helix.offsetY;
}


function setupMovement() {
  window.addEventListener('keydown', (e) => { keys[e.code] = true; });
  window.addEventListener('keyup',   (e) => { keys[e.code] = false; });
}

// Recompute helix.radius using stairs world positions (median or mean)
// Note: radius tuning and persistence removed — radius is hardcoded above.

function averageSpacing(data) {
  if (data.length < 2) return 0;
  // sort clone by y ascending
  const sorted = [...data].sort((a,b) => a.position.y - b.position.y);
  let total = 0;
  for (let i=1;i<sorted.length;i++) total += (sorted[i].position.y - sorted[i-1].position.y);
  return total / (sorted.length - 1);
}

function rebuildStairsFromData(baseStairs, data) {
  // Determine averaged spacing ignoring original jitter
  const sorted = [...data].sort((a,b) => a.position.y - b.position.y);
  const spacing = averageSpacing(sorted);
  const baseY = sorted[0].position.y; // anchor at lowest given value
  const group = []; // references
  for (let i=0;i<sorted.length;i++) {
    const d = sorted[i];
    const seg = (i===0 ? baseStairs : baseStairs.clone(true));
    // Position using evenly spaced Y but preserve X/Z from data (assumes constant)
    seg.position.set(d.position.x, baseY + spacing * i, d.position.z);
    seg.rotation.set(d.rotation.x, d.rotation.y, d.rotation.z);
    seg.scale.set(d.scale.x, d.scale.y, d.scale.z);
    if (i>0) stairsGroup.add(seg);
    group.push(seg);
  }
  // Rebuilt stair segments
  return group;
}


// Reusable vectors to avoid per-frame allocations
const _v_dir = new THREE.Vector3();
const _v_right = new THREE.Vector3();
const _v_move = new THREE.Vector3();
const _v_up = new THREE.Vector3(0,1,0);

function updateMovement(dt) {
  if (!controls.isLocked) return;
  // If models haven't finished loading, don't allow movement to run (prevents accidental teleports before anchoring)
  if (!scene.userData || !scene.userData.modelsLoaded) return;
  const speed = (keys.ShiftLeft || keys.ShiftRight) ? WALK_SPEED * RUN_MULT : WALK_SPEED;
  // Basic forward/back controls when helix is disabled
  if (!helix.enabled) {
    if (keys.KeyW) controls.moveForward( speed * dt);
    if (keys.KeyS) controls.moveForward(-speed * dt);
    if (keys.KeyA) controls.moveRight(  -speed * dt);
    if (keys.KeyD) controls.moveRight(   speed * dt);
  } else {
    // Convert WASD to a horizontal movement vector (based on camera yaw) and map to helix
    const f = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
    const s = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    if (f !== 0 || s !== 0) {
  camera.getWorldDirection(_v_dir);
  _v_dir.y = 0; _v_dir.normalize();
  _v_right.crossVectors(_v_dir, _v_up).normalize();
      _v_move.set(0,0,0);
      _v_move.addScaledVector(_v_dir, f * speed * dt);
      _v_move.addScaledVector(_v_right, s * speed * dt);

      // target XZ after movement attempt
      const cx = helix.center.x, cz = helix.center.y;
      const curX = camera.position.x, curZ = camera.position.z;
      const targetX = curX + _v_move.x;
      const targetZ = curZ + _v_move.z;

      // compute wrapped theta from target point
      let wrappedTheta = Math.atan2(targetZ - cz, targetX - cx);
      if (wrappedTheta < 0) wrappedTheta += Math.PI * 2;
      // choose the theta branch nearest to lastTheta so helix is continuous
      let k = Math.round((helix.lastTheta - wrappedTheta) / (2 * Math.PI));
      let theta = wrappedTheta + k * (2 * Math.PI);
      // update stored lastTheta
      helix.lastTheta = theta;

      // compute clamped radius from the attempted target point so helix.thickness is honored
      const rTarget = Math.hypot(targetX - cx, targetZ - cz);
      const rMin = helix.radius - helix.thickness / 2;
      const rMax = helix.radius + helix.thickness / 2;
      const rClamped = Math.min(Math.max(rTarget, rMin), rMax);

      camera.position.x = cx + rClamped * Math.cos(theta);
      camera.position.z = cz + rClamped * Math.sin(theta);

      // update Y following helix curve + offset (apply inversion)
      const sign = helix.inverted ? -1 : 1;
      camera.position.y = helix.baseY + sign * (theta / (2 * Math.PI)) * helix.pitch + helix.offsetY;
    }
  }
  // vertical fly or helix offset
  if (helix.enabled) {
    if (keys.KeyE) helix.offsetY += speed * dt;
    if (keys.KeyQ) helix.offsetY -= speed * dt;
  } else {
    if (keys.KeyE) camera.position.y += speed * dt;
    if (keys.KeyQ) camera.position.y -= speed * dt;
    if (camera.position.y < FLOOR_Y) camera.position.y = FLOOR_Y;
  }

  // apply helical / cylindrical constraint after movement
  constrainCameraToHelix();
}

function constrainCameraToHelix() {
  // If models haven't finished loading and anchoring, skip constraint/wrap entirely to avoid teleport-before-load
  if (!scene.userData || !scene.userData.modelsLoaded) return;
  if (!helix.enabled || !camera) return;
  // horizontal vector from center to camera
  const cx = helix.center.x, cz = helix.center.y;
  const dx = camera.position.x - cx;
  const dz = camera.position.z - cz;
  // wrapped theta in [0, 2PI)
  let wrappedTheta = Math.atan2(dz, dx);
  if (wrappedTheta < 0) wrappedTheta += Math.PI * 2;
  // choose the theta branch nearest lastTheta so motion is continuous over multiple revolutions
  const k = Math.round((helix.lastTheta - wrappedTheta) / (2 * Math.PI));
  let theta = wrappedTheta + k * (2 * Math.PI);
  // If we have an initial helix reference, compute revolutions relative to that and
  // teleport back to the saved initial camera position when exceeding ±4 revolutions.
  // Only consider wrap if we have a valid initial reference and the tower has been placed.
  const now = Date.now();
  const wrapReadyAt = scene.userData && scene.userData.wrapReadyAt;
  if (towerRef && scene.userData && scene.userData.initialHelixRef && scene.userData.wrapReady && wrapReadyAt && (now - wrapReadyAt) > 1000) {
    const init = scene.userData.initialHelixRef;
  // use ±2 rings as the wrap trigger threshold (wrap distance remains 3 * pitch)
  const upThreshold = init.cameraPos.y + 2 * helix.pitch;
  const downThreshold = init.cameraPos.y - 2 * helix.pitch;
    // (debug logging removed to reduce console spam)
  if (camera.position.y >= upThreshold || camera.position.y <= downThreshold) {
      const now = Date.now();
      if (now - helix._lastWrapTime < (helix.wrapCooldown || 0)) {
        // skip wrapping if within cooldown window
      } else {
  // Wrap the camera Y by ±3 * helix.pitch so the player stays at the same X/Z and rotation
  const wrapAmount = 3 * helix.pitch;
        if (camera.position.y >= upThreshold) {
          camera.position.y -= wrapAmount;
        } else if (camera.position.y <= downThreshold) {
          camera.position.y += wrapAmount;
        }

        // Recompute helix.lastTheta so the helix mapping (theta -> helixY) matches the new camera.position.y
        try {
          initHelixLastThetaFromCamera();
        } catch (e) {
          // fallback: compute wrapped theta from position if init helper isn't available
          let wrappedAtPos = Math.atan2(camera.position.z - helix.center.y, camera.position.x - helix.center.x);
          if (wrappedAtPos < 0) wrappedAtPos += Math.PI * 2;
          const branch = Math.round((helix.lastTheta - wrappedAtPos) / (2 * Math.PI));
          helix.lastTheta = wrappedAtPos + branch * (2 * Math.PI);
        }

        // After recomputing lastTheta, set camera.y to the canonical helixY so we don't oscillate
        try {
          const sign = helix.inverted ? -1 : 1;
          const canonicalY = helix.baseY + sign * (helix.lastTheta / (2 * Math.PI)) * helix.pitch + helix.offsetY;
          camera.position.y = canonicalY;
        } catch (e) {
          // ignore
        }

        // Sync PointerLockControls internal object position so movement/rotation remain seamless
        try {
          if (controls && controls.getObject) controls.getObject().position.copy(camera.position);
        } catch (e) {
          // ignore if controls not available
        }

  helix._lastWrapTime = now;
        // Important: return now so the later helixY recomputation does not overwrite the wrapped Y
        return;
      }
    }
  }
  // otherwise update continuous theta normally
  helix.lastTheta = theta;

  // compute desired radius (clamp into band)
  const r = Math.hypot(dx, dz);
  const rMin = helix.radius - helix.thickness / 2;
  const rMax = helix.radius + helix.thickness / 2;
  const rClamped = Math.min(Math.max(r, rMin), rMax);

  // set camera X,Z to lie on the clamped radius at the same theta
  camera.position.x = cx + rClamped * Math.cos(theta);
  camera.position.z = cz + rClamped * Math.sin(theta);

  // if helix mapping is desired, set camera Y to follow helix curve
  const sign = helix.inverted ? -1 : 1;
  const helixY = helix.baseY + sign * (theta / (2 * Math.PI)) * helix.pitch + helix.offsetY;
  camera.position.y = helixY;
}

// --- Model Loading ---
function loadGLTF(url) {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.load(url, (g) => resolve(g.scene), undefined, reject);
  });
}

function centerAndFloor(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const center = box.getCenter(new THREE.Vector3());
  obj.position.sub(center);
  obj.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(obj);
  const minY = box2.min.y;
  obj.position.y -= minY;
  obj.updateMatrixWorld(true);
  return { size: box2.getSize(new THREE.Vector3()) };
}

// Initialize helix.lastTheta so the continuous helix matches current camera Y
function initHelixLastThetaFromCamera() {
  if (!camera) return;
  const cx = helix.center.x, cz = helix.center.y;
  const dx = camera.position.x - cx;
  const dz = camera.position.z - cz;
  let wrappedTheta = Math.atan2(dz, dx);
  if (wrappedTheta < 0) wrappedTheta += Math.PI * 2;
  const sign = helix.inverted ? -1 : 1;
  // solve for k so the helixY (with theta + 2πk) is closest to camera.y
  // helixY = baseY + sign * (theta_full / 2π) * pitch + offsetY
  // => theta_full = ((camera.y - baseY - offsetY) * 2π) / (sign * pitch)
  const desiredThetaFull = ((camera.position.y - helix.baseY - helix.offsetY) * 2 * Math.PI) / (sign * helix.pitch || 1e-6);
  const k = Math.round((desiredThetaFull - wrappedTheta) / (2 * Math.PI));
  helix.lastTheta = wrappedTheta + k * (2 * Math.PI);
}

// Compute helix.lastTheta so the continuous helix matches a given world position (useful when camera moved before load)
function computeHelixLastThetaFromPosition(worldPos) {
  if (!worldPos) return;
  const cx = helix.center.x, cz = helix.center.y;
  const dx = worldPos.x - cx;
  const dz = worldPos.z - cz;
  let wrappedTheta = Math.atan2(dz, dx);
  if (wrappedTheta < 0) wrappedTheta += Math.PI * 2;
  const sign = helix.inverted ? -1 : 1;
  const desiredThetaFull = ((worldPos.y - helix.baseY - helix.offsetY) * 2 * Math.PI) / (sign * helix.pitch || 1e-6);
  const k = Math.round((desiredThetaFull - wrappedTheta) / (2 * Math.PI));
  return wrappedTheta + k * (2 * Math.PI);
}

async function placeTowerAndStairs() {
  try {
    const [tower, stairs] = await Promise.all([
      loadGLTF('./assets/models/TowerSection.glb'),
      loadGLTF('./assets/models/SpiralStairs.glb'),
    ]);

  const { size: towerSize }  = centerAndFloor(tower);
  // We no longer auto-center & scale stairs; keep its authored proportions.
  // centerAndFloor(stairs); // (skip to preserve original pivot if desired)

  tower.position.set(0, 0, 0);
  scene.add(tower);
  towerRef = tower;

  // Create group to hold stairs
  stairsGroup = new THREE.Group();
  towerRef.add(stairsGroup);

  // Use first data entry to set base transform before cloning others
  const first = stairsSegmentsData[0];
  stairs.position.set(first.position.x, first.position.y, first.position.z);
  stairs.rotation.set(first.rotation.x, first.rotation.y, first.rotation.z);
  stairs.scale.set(first.scale.x, first.scale.y, first.scale.z);
  stairs.updateMatrixWorld(true);
  stairsGroup.add(stairs);
  stairsRef = stairs;
  rebuildStairsFromData(stairsRef, stairsSegmentsData); // clones go into group

  // Initialize helix center + radius using tower bounding box if available
  try {
    const tbox = new THREE.Box3().setFromObject(towerRef);
  const center = tbox.getCenter(new THREE.Vector3());
  helix.center.set(center.x, center.z);
  // keep hardcoded helix.radius; do not overwrite from tower bounds
  // set baseY to lowest stair Y
    const ys = stairsSegmentsData.map(d => d.position.y);
  helix.baseY = Math.min(...ys);
  // Elevate the helix so the whole winding is shifted up by the measured delta (~0.3525)
  helix.baseY += 0.3525;
    // Place several interior point lights along the tower Y extent to evenly light the inside
    try {
      const tmin = tbox.min.y, tmax = tbox.max.y;
      const lights = 3;
      for (let i=0;i<lights;i++) {
        const y = tmin + (i / (lights - 1 || 1)) * (tmax - tmin);
        const pl = new THREE.PointLight(0xfff6e0, 0.45, 20, 2);
        pl.position.set(center.x, y, center.z);
        scene.add(pl);
      }
  // interior lights added
    } catch (e) {
      console.warn('Failed to add interior lights', e);
    }
      // Add clones following the pattern: ±3 and ±6 rings from the base tower
      try {
        const d1 = 3 * helix.pitch;
        const d2 = 6 * helix.pitch;
        const clones = [ -d2, -d1, d1, d2 ];
        for (const dy of clones) {
          const c = tower.clone(true);
          c.position.copy(tower.position);
          c.position.y += dy;
          scene.add(c);
        }
      } catch (e) {
        console.warn('Failed to create tower clones', e);
      }
  } catch (e) {
    console.warn('Helix init failed, using defaults', e);
  }
  // set continuous theta to match a stable start pose (avoid using live camera if user moved before load)
  const startPose = (scene.userData && scene.userData.startCameraPose) ? scene.userData.startCameraPose : { pos: camera.position.clone(), quat: camera.quaternion.clone() };
  // compute a robust lastTheta from the start pose position
  try {
    helix.lastTheta = computeHelixLastThetaFromPosition(startPose.pos) || helix.lastTheta;
  } catch (e) {
    initHelixLastThetaFromCamera();
  }
  // Store the initial helix reference (theta and the start camera pose) for wrap thresholds
  scene.userData.initialHelixRef = {
    theta: helix.lastTheta,
    cameraPos: startPose.pos.clone(),
    cameraQuat: startPose.quat.clone()
  };
  // mark models as loaded so constraints and wrap logic can safely run
  scene.userData.modelsLoaded = true;
  // create the interactive plane marker and UI
  try {
    createInteractivePlane();
    createInteractionUI();
    // position the plane using the initial camera transform so it stays fixed relative to that initial pose
    if (interactivePlane && scene.userData && scene.userData.initialHelixRef) {
      const init = scene.userData.initialHelixRef;
      const placeDist = 1.2; // meters in front of the initial camera
      // compute forward from stored quaternion
      const forward = new THREE.Vector3(0,0,-1).applyQuaternion(init.cameraQuat).normalize();
      const target = new THREE.Vector3().copy(init.cameraPos).addScaledVector(forward, placeDist);
      // small nudge toward the tower center so it visually sits in the window seam
      const towardCenter = new THREE.Vector3(helix.center.x, target.y, helix.center.y).sub(target).multiplyScalar(0.08);
      target.add(towardCenter);
      interactivePlane.position.copy(target);
      // orient plane to face the initial camera position
      interactivePlane.lookAt(init.cameraPos);
      interactivePlane.visible = true;
      // scale plane based on initial distance so it appears consistent
      const d = init.cameraPos.distanceTo(interactivePlane.position);
      const scale = Math.max(0.5, Math.min(1.6, d * 0.35));
      interactivePlane.scale.set(scale, scale * 0.6, 1);
    }
  } catch (e) {
    console.warn('Interactive plane setup failed', e);
  }
  // Now that models are loaded and initial references are stored, allow wrap to occur after a brief delay
  setTimeout(() => {
    scene.userData.wrapReady = true;
    scene.userData.wrapReadyAt = Date.now();
    // refresh initial cameraPos anchor so enabling wrap doesn't immediately teleport
    if (scene.userData.initialHelixRef && camera) scene.userData.initialHelixRef.cameraPos = camera.position.clone();
  }, 1000);

  } catch (e) {
    console.error('Model load error', e);
  }
}

// --- Animation Loop ---
// Create one shared clock for the animation loop
const __globalClock = new THREE.Clock();
function animate() {
  function loop() {
    requestAnimationFrame(loop);
    const dt = __globalClock.getDelta();
    updateMovement(dt);
    // keep limiter planes aligned with camera
    updateLimiterPlanes();
  // update interactive UI state
  try { updateInteraction(); } catch (e) { /* ignore */ }
    renderer.render(scene, camera);
    // update stats overlay if present
    try {
      if (window._statsOverlay && window._statsOverlay.update) window._statsOverlay.update(dt);
    } catch (e) {
      // ignore
    }
  }
  loop();
}

// --- Main Entry ---

function main() {
  initScene();
  initControls();
  initLighting();
  setupMovement();
  window.addEventListener('resize', onWindowResize);
  // Create limiter planes that follow the camera
  createLimiterPlanes();
  // Attempt to load an HDR sky at assets/textures/Skybox.hdr and apply as environment/background
  async function _tryLoadHDRSky() {
    try {
      const rgbe = new RGBELoader();
      const data = await new Promise((resolve, reject)=> rgbe.load('./assets/textures/Skybox.hdr', resolve, undefined, reject));
      // PMREM generator to get an env map suitable for PBR
      const pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      // rotate by creating a texture and setting center/rotation
      data.center.set(0.5, 0.5);
      data.rotation = Math.PI; // 180 degrees
      const env = pmrem.fromEquirectangular(data).texture;
  // use HDR as background only to avoid the cost of a full environment for PBR
  scene.background = env;
      data.dispose();
      pmrem.dispose();
    } catch (e) {
      // fallback: no HDR present
      // console.warn('HDR sky load failed or missing: assets/textures/Skybox.hdr');
    }
  }
  _tryLoadHDRSky().catch(()=>{});
  // Removed runtime tweaking and capture handlers - scene runs with embedded calibration only.

  // Create a small, non-obtrusive stats overlay
  (function createStatsOverlay(){
    const style = document.createElement('style');
    style.textContent = `
      #lk_stats { position: fixed; right: 8px; top: 8px; background: rgba(0,0,0,0.55); color: #e8e8e8; padding: 8px 10px; font-family: monospace; font-size:12px; line-height:1.3; border-radius:6px; z-index:9999; pointer-events:none; }
      #lk_stats.hidden { display:none; }
      #lk_stats .label { color:#9ab; }
    `;
    document.head.appendChild(style);
    const el = document.createElement('div');
    el.id = 'lk_stats';
    el.innerHTML = '<div><span class="label">FPS:</span> <span id="lk_fps">...</span></div>'+
                   '<div><span class="label">Y:</span> <span id="lk_cam_y">...</span></div>'+
                   '<div><span class="label">radius:</span> <span id="lk_radius">...</span></div>'+
                   '<div><span class="label">pitch:</span> <span id="lk_pitch">...</span></div>';
    document.body.appendChild(el);
    // simple smoothed FPS counter
    let acc = 0; let frames = 0; let fps = 0;
    function update(dt){
      frames++;
      acc += (dt || 0);
      if (acc >= 0.5) { // update every 0.5s
        fps = Math.round(frames / acc);
        frames = 0; acc = 0;
        const elF = document.getElementById('lk_fps');
        const elY = document.getElementById('lk_cam_y');
        const elR = document.getElementById('lk_radius');
        const elP = document.getElementById('lk_pitch');
        if (elF) elF.textContent = fps;
        if (elY) elY.textContent = camera ? camera.position.y.toFixed(2) : 'n/a';
        if (elR) elR.textContent = helix.radius.toFixed(3);
        if (elP) elP.textContent = helix.pitch.toFixed(3);
      }
    }
    // attach to window so animate() can call it without imports
    window._statsOverlay = { update };
    // Toggle visibility with Tab (non-obstructive): allow showing/hiding for screenshots
    window.addEventListener('keydown', (e)=>{ if (e.code === 'Tab') { e.preventDefault(); el.classList.toggle('hidden'); } });
  })();

  animate();
  placeTowerAndStairs();
}

main();
