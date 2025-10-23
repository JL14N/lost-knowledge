// Final Level: Cosmic Sky Scene
// Requires three.js r164+
// Dependencies: OrbitControls, EffectComposer, RenderPass, UnrealBloomPass, FilmPass

import * as THREE from 'https://unpkg.com/three@0.164.1/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.164.1/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'https://unpkg.com/three@0.164.1/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'https://unpkg.com/three@0.164.1/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'https://unpkg.com/three@0.164.1/examples/jsm/postprocessing/UnrealBloomPass.js';
import { FilmPass } from 'https://unpkg.com/three@0.164.1/examples/jsm/postprocessing/FilmPass.js';

let scene, camera, renderer, composer, clock;
let layers = [];

init();
animate();

function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // CAMERA
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(0, 0, 1);

  // RENDERER
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  // CONTROLS (for slow cinematic orbit)
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 0.5;
  controls.maxDistance = 10;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.1;

  clock = new THREE.Clock();

  // POSTPROCESSING
  const renderScene = new RenderPass(scene, camera);
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.2, 0.8, 0.2);
  const film = new FilmPass(0.3, 0.5, 648, false);
  composer = new EffectComposer(renderer);
  // ensure composer has the correct initial size
  try { composer.setSize(window.innerWidth, window.innerHeight); } catch(e) { console.warn('Composer setSize failed', e); }
  composer.addPass(renderScene);
  composer.addPass(bloom);
  composer.addPass(film);

  // LIGHTS
  const fillLight = new THREE.PointLight(0x66ccff, 0.2, 0);
  fillLight.position.set(10, 10, 10);
  scene.add(fillLight);

  // LAYERED SKYDOMES
  const texLoader = new THREE.TextureLoader();

  const definitions = [
    { file: 'layer1.png', radius: 1000, speed: 0.00001, opacity: 1.0, blending: THREE.NormalBlending },
    { file: 'layer2.png', radius: 990,  speed: 0.00003, opacity: 0.8, blending: THREE.AdditiveBlending },
    { file: 'layer3.png', radius: 980,  speed: 0.00006, opacity: 0.8, blending: THREE.AdditiveBlending },
    { file: 'layer4.png', radius: 970,  speed: 0.0001,  opacity: 0.6, blending: THREE.AdditiveBlending },
  ];

  definitions.forEach((def, i) => {
    const path = `assets/skyboxes/${def.file}`;
    const tex = texLoader.load(path,
      (loadedTex)=>{
        console.log('philosophy: loaded sky texture', path);
        try { loadedTex.mapping = THREE.EquirectangularReflectionMapping; } catch(e) {}
        try { loadedTex.colorSpace = THREE.SRGBColorSpace; } catch(e) {}
        // as a quick visibility check, set the scene background to the first loaded layer
        try { if (i === 0) scene.background = loadedTex; } catch(e) {}
      },
      undefined,
      (err)=>{ console.warn('philosophy: sky texture load error', path, err); }
    );
    try { tex.mapping = THREE.EquirectangularReflectionMapping; } catch(e) {}
    try { tex.colorSpace = THREE.SRGBColorSpace; } catch(e) {}
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      side: THREE.BackSide,
      transparent: true,
      opacity: def.opacity,
      blending: def.blending,
      depthWrite: false,
    });
    const geo = new THREE.SphereGeometry(def.radius, 64, 64);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData = { speed: def.speed, offset: i * 0.15 };
    mesh.rotation.x = 0.2 + Math.random() * 0.1;
    scene.add(mesh);
    layers.push(mesh);
  });

  // PARTICLE FIELD (near camera shimmer)
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
  const starMat = new THREE.PointsMaterial({
    size: 0.4,
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending,
  });
  const stars = new THREE.Points(starGeo, starMat);
  scene.add(stars);

  // GRADIENT LIGHT DOME (faint horizon glow)
  const gradient = new THREE.Mesh(
    new THREE.SphereGeometry(940, 32, 32),
    new THREE.MeshBasicMaterial({
      color: 0x112244,
      side: THREE.BackSide,
      transparent: true,
      opacity: 0.5,
    })
  );
  scene.add(gradient);

  window.addEventListener('resize', onWindowResize);

  function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
  }
}

function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();

  // Animate sky layers
  layers.forEach((l) => {
    l.rotation.y += l.userData.speed;
    l.rotation.z = Math.sin(t * 0.05 + l.userData.offset) * 0.05;
  });

  // Pulsating brightness effect
  const bloomIntensity = 1.1 + Math.sin(t * 0.5) * 0.2;
  composer.passes[1].strength = bloomIntensity;

  // Slight camera bob (subtle floating feeling)
  camera.position.y = Math.sin(t * 0.2) * 0.3;

  composer.render();
}
