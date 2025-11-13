// Minimal TowerTop debug scene
// - Loads TowerTop.glb (with several fallbacks)
// - If model loading fails, shows a clear placeholder
// - Simple free-flight movement (WASD, Q/E vertical, Shift to speed)

import * as THREE from 'https://unpkg.com/three@0.164.1/build/three.module.js';
import { GLTFLoader } from 'https://unpkg.com/three@0.164.1/examples/jsm/loaders/GLTFLoader.js';
import { PointerLockControls } from 'https://unpkg.com/three@0.164.1/examples/jsm/controls/PointerLockControls.js';
import { OrbitControls } from 'https://unpkg.com/three@0.164.1/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'https://unpkg.com/three@0.164.1/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'https://unpkg.com/three@0.164.1/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'https://unpkg.com/three@0.164.1/examples/jsm/postprocessing/UnrealBloomPass.js';
import { FilmPass } from 'https://unpkg.com/three@0.164.1/examples/jsm/postprocessing/FilmPass.js';
import { ConstellationGame } from './constellation.js';

let scene, camera, renderer, clock;
let _freeKeys = {};
const _freeSpeed = 4.2;
// Movement controller state
let _movementController = null; // { update(dt), dispose(), center: Vector3, radius, minY, maxY }
// Background composer and layers (moving skyboxes)
let composer = null;
let bgLayers = [];
let bgComposerReady = false;
let bgClock = null;
let bgComposerPasses = null;

// initialize the scene
function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111118);

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(0, 3.6, 6.0);
  // Log initial camera pose to help pick a desired start position
  console.log('philosophy: initial camera pose', { pos: camera.position.clone(), quat: camera.quaternion.clone() });

  // reuse host canvas if present
  const existingCanvas = document.querySelector('#myCanvas');
  if (existingCanvas) renderer = new THREE.WebGLRenderer({ canvas: existingCanvas, antialias: true });
  else renderer = new THREE.WebGLRenderer({ antialias: true });

  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  try { renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; } catch (e) {}
  if (!existingCanvas) document.body.appendChild(renderer.domElement);

  clock = new THREE.Clock();
  // Background clock (shared)
  bgClock = new THREE.Clock();

  // Setup a moving layered skybox and postprocessing composer (non-blocking)
  try {
    const texLoader = new THREE.TextureLoader();
    const definitions = [
      { file: './assets/skyboxes/philosophy/layer1.png', radius: 1000, speed: 0.00001, opacity: 1.0, blending: THREE.NormalBlending },
      // lower brightness of layer 2 slightly
      { file: './assets/skyboxes/philosophy/layer2.png', radius: 990,  speed: 0.00003, opacity: 0.8, blending: THREE.AdditiveBlending },
      { file: './assets/skyboxes/philosophy/layer3.png', radius: 980,  speed: 0.00006, opacity: 0.8, blending: THREE.AdditiveBlending },
      { file: './assets/skyboxes/philosophy/layer4.png', radius: 970,  speed: 0.0001,  opacity: 0.6, blending: THREE.AdditiveBlending },
    ];
    // Create composer and passes
    try {
      composer = new EffectComposer(renderer);
      const renderScene = new RenderPass(scene, camera);
      const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.6, 0.4);
      const film = new FilmPass(0.3, 0.5, 648, false);
      composer.addPass(renderScene);
      composer.addPass(bloom);
      composer.addPass(film);
      bgComposerReady = true;
      bgComposerPasses = { bloom };
    } catch (e) { console.warn('philosophy: composer setup failed', e); }

    // Layered skydomes: use the (older) flat layer filenames if present
    // We'll fall back to the assets/skyboxes/philosophy/X files if they exist.
    const defs = [
      { file: './assets/skyboxes/philosophy/0/layer00.png', radius: 1000, speed: 0.0001, opacity: 1.0, blending: THREE.NormalBlending },
      { file: './assets/skyboxes/philosophy/1/layer10.png', radius: 990,  speed: 0.0003, opacity: 0.8, blending: THREE.AdditiveBlending },
      { file: './assets/skyboxes/philosophy/2/layer20.png', radius: 980,  speed: 0.00006, opacity: 0.8, blending: THREE.AdditiveBlending },
      { file: './assets/skyboxes/philosophy/3/layer30.png', radius: 970,  speed: 0.0005,  opacity: 0.6, blending: THREE.AdditiveBlending },
    ];
    defs.forEach((def, i) => {
      try {
        const tex = texLoader.load(def.file, () => {}, undefined, () => {});
        try { tex.mapping = THREE.EquirectangularReflectionMapping; } catch(e) {}
        const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, transparent: true, opacity: def.opacity, blending: def.blending, depthWrite: false });
        const geo = new THREE.SphereGeometry(def.radius, 64, 64);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.userData = { speed: def.speed, offset: i * 0.15 };
        mesh.rotation.x = 0.2 + Math.random() * 0.1;
        scene.add(mesh);
        bgLayers.push(mesh);
      } catch (e) { console.warn('philosophy: failed to create bg layer', def.file, e); }
    });

    // Particle field (near camera shimmer)
    try {
      const starGeo = new THREE.BufferGeometry();
      const starCount = 1000;
      const positions = new Float32Array(starCount * 3);
      const colors = new Float32Array(starCount * 3);
      const color = new THREE.Color();
      for (let i = 0; i < starCount; i++) {
        const r = 80 + Math.random() * 40;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        positions[i * 3 + 2] = r * Math.cos(phi);
        color.setHSL(0.55 + Math.random() * 0.1, 0.7, 0.8);
        colors.set([color.r, color.g, color.b], i * 3);
      }
      starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      starGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const starMat = new THREE.PointsMaterial({ size: 0.4, vertexColors: true, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending });
      const stars = new THREE.Points(starGeo, starMat);
      scene.add(stars);
    } catch (e) { console.warn('philosophy: star field failed', e); }

    // Gradient dome
    try {
      const gradient = new THREE.Mesh(new THREE.SphereGeometry(940, 32, 32), new THREE.MeshBasicMaterial({ color: 0x112244, side: THREE.BackSide, transparent: true, opacity: 0.5 }));
      scene.add(gradient);
    } catch (e) { console.warn('philosophy: gradient dome failed', e); }

  } catch (e) {
    console.warn('philosophy: background setup failed', e);
  }

  // lighting
  const dir = new THREE.DirectionalLight(0xffffff, 1.8);
  dir.position.set(6, 10, 6);
  try { dir.castShadow = true; dir.shadow.mapSize.set(2048, 2048); } catch (e) {}
  scene.add(dir);

  const fill = new THREE.DirectionalLight(0xfff6e0, 0.9);
  fill.position.set(-6, 6, -4);
  scene.add(fill);

  const amb = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(amb);

  // ground plane removed per user request (keeps scene unobstructed beneath tower)

  window.addEventListener('resize', onWindowResize);
  window.addEventListener('keydown', (e) => { _freeKeys[e.code] = true; });
  window.addEventListener('keyup', (e) => { _freeKeys[e.code] = false; });

  // optional pointer-lock for precision navigation
  document.addEventListener('click', () => {
    try { const controls = new PointerLockControls(camera, renderer.domElement); controls.lock(); } catch (e) {}
  });

  // Keybinding: press L to log current camera pose (position + quaternion) for easy anchoring
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyL') {
      try {
        console.log('philosophy: camera pose (L):', { pos: camera.position.clone(), quat: camera.quaternion.clone() });
      } catch (err) {}
    }
  });

  // attempt to load the model
  initModel();

  // Initialize constellation minigame at skybox distance. This uses
  // the star assets in ./assets/vectors and displays gameplay in the sky.
  try {
    // small delay to ensure renderer and camera exist
    setTimeout(() => {
      try {
        const cg = new ConstellationGame(scene, camera, renderer, { radius: 900 });
        cg.load();
        // keep a global ref for debugging
        window._constellationGame = cg;
      } catch (e) { console.warn('philosophy: constellation init failed', e); }
    }, 400);
  } catch (e) { console.warn('philosophy: constellation setup failed', e); }
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// Layered skybox helper
// Composes images from folders `basePath/0/`, `basePath/1/`, `basePath/2/`, `basePath/3/`
async function applyLayeredSkybox(scene, renderer, basePath = './assets/models/skyboxes/philosophy', opts = {}) {
  // opts: { size: 4096, exposure: 0.92, alphas: [1,0.9,0.8,0.7] }
  const size = opts.size || 4096;
  const height = Math.floor(size / 2);
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = height;
  const ctx = canvas.getContext('2d');

  function loadImg(url) {
    return new Promise((res, rej) => {
      const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = rej; i.src = url;
    });
  }

  const alphas = (opts.alphas && opts.alphas.length === 4) ? opts.alphas : [1.0, 0.92, 0.85, 0.78];
  for (let i = 0; i <= 3; i++) {
    const candidates = [`${basePath}/${i}/layer${i}0.png`, `${basePath}/${i}/layer${i}0.jpg`, `${basePath}/${i}/layer${i}0.jpeg`];
    let img = null;
    for (const c of candidates) {
      try { img = await loadImg(c); if (img) break; } catch (e) { /* try next */ }
    }
    if (!img) continue;
    try {
      ctx.globalAlpha = alphas[i];
      const imgAR = img.width / img.height;
      const canvasAR = canvas.width / canvas.height;
      let sx = 0, sy = 0, sw = img.width, sh = img.height;
      if (imgAR > canvasAR) {
        const targetW = Math.floor(img.height * canvasAR);
        sx = Math.floor((img.width - targetW) / 2);
        sw = targetW;
      } else if (imgAR < canvasAR) {
        const targetH = Math.floor(img.width / canvasAR);
        sy = Math.floor((img.height - targetH) / 2);
        sh = targetH;
      }
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    } catch (e) { console.warn('applyLayeredSkybox: draw error for layer', i, e); }
  }

  try {
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    try { tex.encoding = THREE.sRGBEncoding; } catch(e) {}
    tex.mapping = THREE.EquirectangularReflectionMapping;

    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const env = pmrem.fromEquirectangular(tex).texture;

    try { if (scene.background && scene.background.dispose) scene.background.dispose(); } catch(e) {}
    scene.background = env;

    if (typeof opts.exposure === 'number') {
      try { renderer.toneMappingExposure = opts.exposure; } catch(e) {}
    }

    try { tex.dispose(); } catch(e) {}
    pmrem.dispose();
    return env;
  } catch (e) { console.warn('applyLayeredSkybox: PMREM creation failed', e); return null; }
}

// Try loading a set of candidate models; if none load, create a placeholder
async function initModel() {
  const loader = new GLTFLoader();
  const candidates = [
    './assets/models/TowerTop.glb',
    './assets/models/kickelhahn_tower.glb',
    './assets/models/TowerSection.glb',
    './assets/models/SpiralStairs.glb'
  ];

  for (const p of candidates) {
    try {
      console.log('philosophy: attempting', p);
      const gltf = await new Promise((res, rej) => loader.load(p, res, undefined, rej));
      if (gltf && gltf.scene) {
        placeModel(gltf.scene);
        console.log('philosophy: loaded', p);
        return;
      }
    } catch (e) { console.warn('philosophy: load failed', p, e); }
  }

  console.warn('philosophy: no model loaded; creating placeholder');
  createPlaceholder();
}

function placeModel(model) {
  // scale and center
  model.scale.multiplyScalar(1.5);
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  model.position.sub(center);
  model.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(model);
  const minY = box2.min.y;
  model.position.y -= minY;

  model.traverse((ch) => { if (ch.isMesh) { ch.castShadow = true; ch.receiveShadow = true; } });
  scene.add(model);

  // position camera to view model
  const bounds = new THREE.Box3().setFromObject(model);
  const modelCenter = bounds.getCenter(new THREE.Vector3());
  const modelRadius = Math.max(bounds.getSize(new THREE.Vector3()).x, bounds.getSize(new THREE.Vector3()).z) * 0.6;
  camera.position.set(modelCenter.x, bounds.max.y + 1.8, modelCenter.z + Math.max(2.2, modelRadius + 1.5));
  camera.lookAt(modelCenter.x, bounds.max.y, modelCenter.z);

  // add a platform on top
  // add a platform on top
  try {
    // Create a movement controller constrained to the model center. We intentionally
    // do NOT add a visible platform mesh here — the camera should still be clamped
    // to the circular region (as with the spiral staircase) but the helper circle
    // can be removed for visual cleanliness.
    if (_movementController) { try { _movementController.dispose(); } catch(e) {} }
    const centerPos = modelCenter.clone();
    centerPos.y = bounds.max.y + 0.05;
    // Slightly reduce the visual clamping radius so the player sits a bit closer to the center
    _movementController = createMovementController(camera, { center: centerPos, radius: Math.max(1.5, modelRadius * 0.5) * 0.95, minY: bounds.max.y - 0.2, maxY: bounds.max.y + 6.0 });
    // Place the camera at the circle center and point down so the scene loads centered
    try {
  // place camera a bit above the platform but use the requested starting Y axis
  const requestedY = 1.9181912513709853;
  const startHeight = requestedY; // explicit start Y requested by user
  camera.position.set(centerPos.x, startHeight, centerPos.z);
      camera.lookAt(centerPos.x, bounds.min.y, centerPos.z);
      try { if (_movementController && typeof _movementController.update === 'function') _movementController.update(0); } catch(e) {}
    } catch (e) { /* non-fatal */ }
  } catch(e) { console.warn('philosophy: failed to create movement controller', e); }
}

function createPlaceholder() {
  const placeholder = new THREE.Group();
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.2, 3.6, 32), new THREE.MeshStandardMaterial({ color: 0x7f7f7f }));
  pillar.position.y = 1.8; pillar.castShadow = true; placeholder.add(pillar);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 0.3, 48), new THREE.MeshStandardMaterial({ color: 0x222233 }));
  cap.position.y = 3.05; cap.castShadow = true; placeholder.add(cap);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.2, 16, 64), new THREE.MeshStandardMaterial({ color: 0x444455 }));
  ring.rotation.x = Math.PI / 2; ring.position.y = 3.1; placeholder.add(ring);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 0.2, 64), new THREE.MeshStandardMaterial({ color: 0x191919 }));
  base.position.y = 0; placeholder.add(base);
  scene.add(placeholder);

  // strong directional light so it's visible
  try { const main = new THREE.DirectionalLight(0xffffff, 2.0); main.position.set(6, 10, 8); main.castShadow = true; scene.add(main); } catch (e) {}

  camera.position.set(0, 3.6, 6.0); camera.lookAt(0, 2.6, 0);
  // constrain movement to placeholder platform area
  try {
    if (_movementController) { try { _movementController.dispose(); } catch(e) {} }
    // Slightly tighten placeholder radius as well
    const placeholderCenter = new THREE.Vector3(0,1.6,0);
    _movementController = createMovementController(camera, { center: placeholderCenter, radius: 6.0 * 0.95, minY: 0.5, maxY: 6.0 });
    // Start camera centered over placeholder and look down
    try {
  const requestedY = 1.9181912513709853;
  const startHeight = requestedY; // use requested start Y even for placeholder
  camera.position.set(placeholderCenter.x, startHeight, placeholderCenter.z);
  camera.lookAt(placeholderCenter.x, 0, placeholderCenter.z);
      try { if (_movementController && typeof _movementController.update === 'function') _movementController.update(0); } catch(e) {}
    } catch (e) { /* non-fatal */ }
  } catch(e) { console.warn('philosophy: failed to create movement controller for placeholder', e); }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();

  // free-flight movement: WASD + Q/E vertical + Shift speed
  try {
    const forward = (_freeKeys.KeyW || _freeKeys.ArrowUp) ? 1 : ((_freeKeys.KeyS || _freeKeys.ArrowDown) ? -1 : 0);
    const right = (_freeKeys.KeyD || _freeKeys.ArrowRight) ? 1 : ((_freeKeys.KeyA || _freeKeys.ArrowLeft) ? -1 : 0);
    const up = (_freeKeys.KeyE) ? 1 : ((_freeKeys.KeyQ) ? -1 : 0);
    const speed = _freeSpeed * dt * ((_freeKeys.ShiftLeft || _freeKeys.ShiftRight) ? 2 : 1);
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir); dir.y = 0; dir.normalize();
  // Use dir x up to get the right-hand movement vector. The previous code used up x dir
  // which produced an inverted left/right feel. Swapping the cross order (dir, up)
  // flips the sign so L/R behave as expected for this level.
  const rightVec = new THREE.Vector3(); rightVec.crossVectors(dir, camera.up).normalize();
  camera.position.addScaledVector(dir, forward * speed);
  camera.position.addScaledVector(rightVec, right * speed);
    camera.position.y += up * speed;
  } catch (e) {}

  // If a movement controller exists (created when the model/platform is placed),
  // ensure the camera position is clamped to the platform circle every frame.
  try { if (_movementController && typeof _movementController.update === 'function') _movementController.update(dt); } catch (e) {}
  // Update background layers if present
  try {
    const t = bgClock ? bgClock.getElapsedTime() : 0;
    if (bgLayers && bgLayers.length) {
      bgLayers.forEach((l) => {
        l.rotation.y += (l.userData && l.userData.speed) ? l.userData.speed : 0.00002;
        l.rotation.z = Math.sin(t * 0.05 + ((l.userData && l.userData.offset) ? l.userData.offset : 0)) * 0.05;
      });
    }
    // pulse bloom if composer present
    if (bgComposerReady && bgComposerPasses && bgComposerPasses.bloom) {
      try { bgComposerPasses.bloom.strength = 1.1 + Math.sin((bgClock ? bgClock.getElapsedTime() : 0) * 0.5) * 0.2; } catch(e) {}
    }
  } catch (e) {}

  try {
    if (bgComposerReady && composer) {
      composer.render();
    } else {
      renderer.render(scene, camera);
    }
  } catch (e) {}
}

// Movement controller factory: constrains camera position to a circle (XZ) and vertical bounds
function createMovementController(cameraRef, opts = {}) {
  const center = opts.center || new THREE.Vector3(0, 0, 0);
  const radius = (typeof opts.radius === 'number') ? opts.radius : 6.0;
  const minY = (typeof opts.minY === 'number') ? opts.minY : 0.5;
  const maxY = (typeof opts.maxY === 'number') ? opts.maxY : 10.0;

  let disposed = false;

  function clampPosition() {
    if (disposed) return;
    // compute dxz from center
    const dx = cameraRef.position.x - center.x;
    const dz = cameraRef.position.z - center.z;
    const dist = Math.hypot(dx, dz);
    if (dist > radius) {
      const scale = radius / dist;
      cameraRef.position.x = center.x + dx * scale;
      cameraRef.position.z = center.z + dz * scale;
    }
    // clamp Y
    if (cameraRef.position.y < minY) cameraRef.position.y = minY;
    if (cameraRef.position.y > maxY) cameraRef.position.y = maxY;
  }

  return {
    update: function (dt) { clampPosition(); },
    dispose: function () { disposed = true; }
  };
}

// start
init();
animate();
