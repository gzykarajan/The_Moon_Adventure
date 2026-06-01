import * as THREE from "three";
import earthUrl from "../assets/picture/earth.png?url";
import "./styles.css";

// Add or remove .mp3 files in assets/BGM; Vite will include them in this playlist automatically.
const bgmModules = import.meta.glob("../assets/BGM/*.mp3", {
  eager: true,
  query: "?url",
  import: "default"
});
const bgmPlaylist = Object.entries(bgmModules)
  .sort(([left], [right]) => left.localeCompare(right, "zh-Hans-CN"))
  .map(([, url]) => url);

const canvas = document.getElementById("moon-canvas");
const loading = document.getElementById("loading");
const progressText = document.getElementById("progressText");
const starText = document.getElementById("starText");
const hintText = document.getElementById("hintText");
const musicButton = document.getElementById("musicButton");
const musicIcon = document.getElementById("musicIcon");
const questionPanel = document.getElementById("questionPanel");
const questionCreature = document.getElementById("questionCreature");
const questionMeta = document.getElementById("questionMeta");
const questionText = document.getElementById("questionText");
const optionsEl = document.getElementById("options");
const finishPanel = document.getElementById("finishPanel");
const restartButton = document.getElementById("restartButton");

const WORLD_SIZE = 520;
const WORLD_LIMIT = WORLD_SIZE * 0.5 - 14;
const ROVER_EYE_HEIGHT = 1.35;
const ENCOUNTER_DISTANCE = 6.2;
const ALIEN_FACE_DISTANCE = 18;

// Meteor frequency knobs for developers:
// Lower these two numbers to make meteors appear more often; raise them for a calmer sky.
const METEOR_MIN_INTERVAL = 5.5;
const METEOR_MAX_INTERVAL = 11;

const EARTH_CAMERA_OFFSET = new THREE.Vector3(68, 44, -145);
const EARTH_BASE_SCALE = new THREE.Vector3(22, 15, 1);
const EARTH_WORLD_DISTANCE = 1800;

// Camera-local sky zones. Increase a zone's weight to make meteors appear there more often.
// Keep y high and z negative so meteors remain in the sky and never appear to hit the moon.
const METEOR_SPAWN_ZONES = [
  { name: "left", weight: 0.28, xMin: -48, xMax: -27, yMin: 18, yMax: 27, zMin: -78, zMax: -58, direction: 1 },
  { name: "center", weight: 0.44, xMin: -22, xMax: 22, yMin: 18, yMax: 28, zMin: -82, zMax: -62 },
  { name: "right", weight: 0.28, xMin: 27, xMax: 48, yMin: 18, yMax: 27, zMin: -78, zMax: -58, direction: -1 }
];

const QUESTION_FILES = ["pinyin", "math", "chinese", "english"];
const OPTION_LETTERS = ["A", "B", "C", "D"];
const CONTROL_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"];
const INPUT_EVENT_HANDLED_FLAG = "__moonAdventureInputHandled";
const creatureNames = [
  "露娜",
  "米米",
  "泡泡",
  "星芽",
  "咕噜",
  "贝拉",
  "圆圆",
  "晶晶",
  "小柚",
  "月莓"
];

const state = {
  mode: "drive",
  keys: new Set(),
  rover: {
    position: new THREE.Vector3(0, 0, 7),
    yaw: 0,
    speed: 0
  },
  stars: 0,
  currentAlien: null,
  selectedOption: 0,
  currentQuestion: null,
  usedQuestionIds: new Set(),
  audioWanted: true,
  audioReady: false
};

const terrainCraters = [];
const aliens = [];
const meteors = [];
const sparkleBursts = [];
let questionPool = [];
let terrainMesh;
let roverDash;
let pathLine;
let earthGroup;
let earthSprite;
let earthInitialDistance = 1;
const earthInitialScale = new THREE.Vector3();
let meteorLayer;
let meteorTexture;
let moonDustTexture;
const cockpitParts = {};
let lastTime = performance.now();
let nextMeteorTime = 4;
let currentBgmIndex = 0;

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance"
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.88;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x090a0a);
scene.fog = new THREE.FogExp2(0x090a0a, 0.012);

const camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.1, 2600);
camera.rotation.order = "YXZ";
scene.add(camera);

const listener = new THREE.AudioListener();
camera.add(listener);

const audio = new Audio(bgmPlaylist[currentBgmIndex] || "");
audio.loop = false;
audio.volume = 0.42;
audio.preload = "auto";
audio.addEventListener("ended", playNextBgmTrack);
audio.addEventListener("error", () => {
  if (bgmPlaylist.length > 1) {
    playNextBgmTrack();
    return;
  }
  state.audioReady = false;
  updateMusicButton();
});

init().catch((error) => {
  loading.textContent = "游戏启动失败，请检查控制台。";
  console.error(error);
});

async function init() {
  questionPool = await loadQuestions();
  createLights();
  createStars();
  createTerrain();
  state.rover.position.y = terrainHeight(state.rover.position.x, state.rover.position.z) + ROVER_EYE_HEIGHT;
  updateCamera();
  createEarth();
  createMeteorSystem();
  createRoute();
  createAliens();
  createRoverDashboard();
  updateHud();
  bindInput();
  exposeDevDebug();
  resize();
  loading.classList.add("hidden");
  requestAnimationFrame(animate);
  tryStartMusic();
}

function exposeDevDebug() {
  if (!import.meta.env.DEV) {
    return;
  }
  window.__moonAdventureDebug = {
    getRover: () => ({
      x: state.rover.position.x,
      y: state.rover.position.y,
      z: state.rover.position.z,
      yaw: state.rover.yaw,
      speed: state.rover.speed,
      mode: state.mode,
      stars: state.stars,
      activeAlien: state.currentAlien
    }),
    getWorld: () => ({
      size: WORLD_SIZE,
      limit: WORLD_LIMIT,
      route: getRoutePoints().map((point) => ({ x: point.x, z: point.z }))
    }),
    getCameraForward: () => {
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      return { x: forward.x, y: forward.y, z: forward.z };
    },
    getEarth: () => {
      if (!earthGroup || !earthSprite) {
        return null;
      }
      return {
        parent: earthGroup.parent === scene ? "scene" : earthGroup.parent?.type || "none",
        x: earthGroup.position.x,
        y: earthGroup.position.y,
        z: earthGroup.position.z,
        distance: camera.position.distanceTo(earthGroup.position),
        scaleX: earthSprite.scale.x,
        scaleY: earthSprite.scale.y,
        depthTest: earthSprite.material.depthTest,
        renderOrder: earthSprite.renderOrder
      };
    },
    getAliens: () =>
      aliens.map((alien, index) => ({
        index,
        name: creatureNames[index],
        completed: alien.userData.completed,
        visible: alien.visible,
        x: alien.position.x,
        y: alien.position.y,
        z: alien.position.z
      })),
    spawnMeteor: (zoneName = "center") => spawnMeteor(true, getMeteorDebugOptions(zoneName)),
    moveRoverTo: (x, z, yaw = state.rover.yaw) => {
      state.rover.position.set(x, terrainHeight(x, z) + ROVER_EYE_HEIGHT, z);
      state.rover.yaw = yaw;
      state.rover.speed = 0;
      updateCamera();
    }
  };
}

async function loadQuestions() {
  const banks = await Promise.all(
    QUESTION_FILES.map(async (name) => {
      const response = await fetch(`/questions/${name}.json`);
      if (!response.ok) {
        throw new Error(`Cannot load question bank: ${name}`);
      }
      const data = await response.json();
      validateQuestionBank(data, name);
      return data.items.map((item) => ({ ...item, subject: data.subject }));
    })
  );
  return banks.flat();
}

function validateQuestionBank(data, name) {
  if (!data.subject || !Array.isArray(data.items) || data.items.length < 20) {
    throw new Error(`${name}.json must include a subject and at least 20 items.`);
  }
  data.items.forEach((item) => {
    if (!item.id || !item.question || !Array.isArray(item.options) || item.options.length !== 4) {
      throw new Error(`Bad question format in ${name}: ${item.id || "unknown"}`);
    }
    if (!Number.isInteger(item.answer) || item.answer < 0 || item.answer > 3) {
      throw new Error(`Bad answer index in ${name}: ${item.id}`);
    }
  });
}

function createLights() {
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1d201d, 1.5));

  const sun = new THREE.DirectionalLight(0xfff0c4, 3.6);
  sun.position.set(-45, 60, 35);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -90;
  sun.shadow.camera.right = 90;
  sun.shadow.camera.top = 90;
  sun.shadow.camera.bottom = -90;
  scene.add(sun);
}

function createStars() {
  const geometry = new THREE.BufferGeometry();
  const positions = [];
  const colors = [];
  const rng = mulberry32(34);
  for (let i = 0; i < 950; i += 1) {
    const radius = 170 + rng() * 190;
    const theta = rng() * Math.PI * 2;
    const y = 45 + rng() * 180;
    positions.push(Math.cos(theta) * radius, y, Math.sin(theta) * radius);
    const warm = 0.75 + rng() * 0.25;
    colors.push(warm, warm, 0.82 + rng() * 0.18);
  }
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: 0.75,
    vertexColors: true,
    transparent: true,
    opacity: 0.76,
    sizeAttenuation: true
  });
  scene.add(new THREE.Points(geometry, material));
}

function createEarth() {
  earthGroup = new THREE.Group();
  const earthDirection = EARTH_CAMERA_OFFSET.clone().normalize().applyQuaternion(camera.quaternion);
  earthGroup.position.copy(camera.position).addScaledVector(earthDirection, EARTH_WORLD_DISTANCE);
  scene.add(earthGroup);

  const earthTexture = new THREE.TextureLoader().load(earthUrl);
  earthTexture.colorSpace = THREE.SRGBColorSpace;
  earthTexture.anisotropy = 4;

  earthSprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: earthTexture,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: false
    })
  );
  earthInitialDistance = camera.position.distanceTo(earthGroup.position);
  earthInitialScale.copy(EARTH_BASE_SCALE).multiplyScalar(earthInitialDistance / EARTH_CAMERA_OFFSET.length());
  earthSprite.scale.copy(earthInitialScale);
  earthSprite.center.set(0.5, 0.5);
  earthSprite.renderOrder = -10;
  earthGroup.add(earthSprite);
}

function updateEarth() {
  if (!earthGroup || !earthSprite) {
    return;
  }
  const distance = camera.position.distanceTo(earthGroup.position);
  earthSprite.scale.copy(earthInitialScale).multiplyScalar(distance / earthInitialDistance);
}

function createMeteorSystem() {
  meteorLayer = new THREE.Group();
  meteorLayer.name = "SkyMeteors";
  camera.add(meteorLayer);
  scheduleNextMeteor(0);
}

function scheduleNextMeteor(time) {
  nextMeteorTime = time + METEOR_MIN_INTERVAL + Math.random() * (METEOR_MAX_INTERVAL - METEOR_MIN_INTERVAL);
}

function getMeteorDebugOptions(zoneName) {
  const zone = METEOR_SPAWN_ZONES.find((item) => item.name === zoneName) || METEOR_SPAWN_ZONES[1];
  const centerX = (zone.xMin + zone.xMax) * 0.5;
  const centerY = (zone.yMin + zone.yMax) * 0.5;
  const centerZ = (zone.zMin + zone.zMax) * 0.5;
  return {
    x: centerX,
    y: centerY,
    z: centerZ,
    direction: zone.direction ?? (centerX < 0 ? 1 : -1),
    speed: 10,
    life: 2.4
  };
}

function chooseMeteorZone() {
  const totalWeight = METEOR_SPAWN_ZONES.reduce((sum, zone) => sum + zone.weight, 0);
  let pick = Math.random() * totalWeight;
  for (const zone of METEOR_SPAWN_ZONES) {
    pick -= zone.weight;
    if (pick <= 0) {
      return zone;
    }
  }
  return METEOR_SPAWN_ZONES[METEOR_SPAWN_ZONES.length - 1];
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function spawnMeteor(force = false, options = {}) {
  if (!meteorLayer) {
    return null;
  }
  if (force) {
    while (meteors.length > 0) {
      disposeMeteor(meteors.pop());
    }
  } else if (meteors.length > 0) {
    return null;
  }

  const zone = options.zone ? METEOR_SPAWN_ZONES.find((item) => item.name === options.zone) || chooseMeteorZone() : chooseMeteorZone();
  const direction = options.direction ?? zone.direction ?? (zone.name === "left" ? 1 : zone.name === "right" ? -1 : (Math.random() > 0.5 ? 1 : -1));
  const trailLength = 16 + Math.random() * 9;
  const startX = options.x ?? randomBetween(zone.xMin, zone.xMax);
  const startY = options.y ?? randomBetween(zone.yMin, zone.yMax);
  const startZ = options.z ?? randomBetween(zone.zMin, zone.zMax);
  const speed = options.speed ?? (18 + Math.random() * 8);
  const life = options.life ?? (1.45 + Math.random() * 0.65);

  const group = new THREE.Group();
  group.position.set(startX, startY, startZ);

  const streakMaterial = new THREE.MeshBasicMaterial({
    map: createMeteorTexture(),
    color: 0xeaf4ff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide
  });
  const streak = new THREE.Mesh(new THREE.PlaneGeometry(trailLength, 2.4), streakMaterial);
  streak.renderOrder = 2;
  streak.position.set(0, 0, 0);
  streak.rotation.z = direction > 0 ? 0.16 : Math.PI - 0.16;
  group.add(streak);

  group.userData = {
    age: 0,
    life,
    velocity: new THREE.Vector3(direction * speed, -0.55 - Math.random() * 0.35, 0),
    streakMaterial
  };
  meteorLayer.add(group);
  meteors.push(group);
  return group;
}

function createMeteorTexture() {
  if (meteorTexture) {
    return meteorTexture;
  }

  const textureCanvas = document.createElement("canvas");
  textureCanvas.width = 256;
  textureCanvas.height = 48;
  const ctx = textureCanvas.getContext("2d");
  const centerY = textureCanvas.height * 0.5;
  const glow = ctx.createLinearGradient(0, centerY, textureCanvas.width, centerY);
  glow.addColorStop(0, "rgba(255,255,255,0)");
  glow.addColorStop(0.45, "rgba(174,214,255,0.12)");
  glow.addColorStop(0.82, "rgba(224,242,255,0.62)");
  glow.addColorStop(1, "rgba(255,250,220,0.96)");
  ctx.strokeStyle = glow;
  ctx.lineWidth = 9;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(10, centerY);
  ctx.lineTo(textureCanvas.width - 8, centerY);
  ctx.stroke();

  const core = ctx.createLinearGradient(0, centerY, textureCanvas.width, centerY);
  core.addColorStop(0, "rgba(255,255,255,0)");
  core.addColorStop(0.68, "rgba(255,255,255,0.34)");
  core.addColorStop(1, "rgba(255,255,240,1)");
  ctx.strokeStyle = core;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(26, centerY);
  ctx.lineTo(textureCanvas.width - 10, centerY);
  ctx.stroke();

  meteorTexture = new THREE.CanvasTexture(textureCanvas);
  meteorTexture.colorSpace = THREE.SRGBColorSpace;
  return meteorTexture;
}

function createTerrain() {
  const rng = mulberry32(8);
  for (let i = 0; i < 150; i += 1) {
    terrainCraters.push({
      x: (rng() - 0.5) * WORLD_SIZE * 0.92,
      z: (rng() - 0.5) * WORLD_SIZE * 0.92,
      r: 1.2 + rng() * rng() * 19,
      depth: 0.24 + rng() * 2.8,
      sharpness: 0.68 + rng() * 0.5
    });
  }
  terrainCraters.push(
    { x: -18, z: -32, r: 12, depth: 2.2, sharpness: 0.92 },
    { x: 24, z: -86, r: 16, depth: 2.8, sharpness: 1.04 },
    { x: -28, z: -148, r: 20, depth: 3.1, sharpness: 0.9 },
    { x: 34, z: -198, r: 14, depth: 2.4, sharpness: 1.08 },
    { x: -56, z: -226, r: 28, depth: 4.1, sharpness: 0.86 },
    { x: 82, z: -122, r: 24, depth: 3.7, sharpness: 0.96 },
    { x: -94, z: 42, r: 30, depth: 4.4, sharpness: 0.82 }
  );

  const geometry = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, 420, 420);
  const position = geometry.attributes.position;
  const colors = [];
  const color = new THREE.Color();
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const z = -position.getY(i);
    const height = terrainHeight(x, z);
    position.setZ(i, height);
    const shade = THREE.MathUtils.clamp(0.42 + height * 0.045 + fineDust(x, z) * 0.06, 0.22, 0.68);
    color.setRGB(shade * 1.1, shade * 1.08, shade * 1.02);
    colors.push(color.r, color.g, color.b);
  }
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.rotateX(-Math.PI / 2);

  terrainMesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      map: createMoonDustTexture(),
      vertexColors: true,
      roughness: 0.94,
      metalness: 0.01
    })
  );
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);

  const rimMaterial = new THREE.MeshStandardMaterial({
    color: 0x9a9688,
    roughness: 0.98,
    transparent: true,
    opacity: 0.46
  });
  const shadowMaterial = new THREE.MeshBasicMaterial({
    color: 0x11120f,
    transparent: true,
    opacity: 0.18,
    depthWrite: false
  });
  const ejectaMaterial = new THREE.MeshBasicMaterial({
    color: 0xc2bdab,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  terrainCraters
    .filter((crater) => crater.r > 4.5)
    .slice(0, 86)
    .forEach((crater) => {
      const shadow = new THREE.Mesh(new THREE.CircleGeometry(crater.r * 0.82, 44), shadowMaterial);
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.set(crater.x, terrainHeight(crater.x, crater.z) + 0.018, crater.z);
      scene.add(shadow);

      if (crater.r > 8) {
        const ejecta = new THREE.Mesh(new THREE.RingGeometry(crater.r * 1.08, crater.r * 1.46, 64), ejectaMaterial);
        ejecta.rotation.x = -Math.PI / 2;
        ejecta.rotation.z = crater.x * 0.03;
        ejecta.position.set(crater.x, terrainHeight(crater.x, crater.z) + 0.024, crater.z);
        scene.add(ejecta);
      }

      const ring = new THREE.Mesh(new THREE.TorusGeometry(crater.r * 0.98, 0.065 + crater.r * 0.008, 8, 56), rimMaterial);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(crater.x, terrainHeight(crater.x, crater.z) + 0.055, crater.z);
      scene.add(ring);
    });

  createMoonRocks(rng);
  createMoonDustSpeckles(rng);
}

function terrainHeight(x, z) {
  let height = softNoise(x, z) * 1.2 + fineDust(x, z) * 0.09 + Math.sin(x * 0.045 + z * 0.018) * 0.34;
  for (const crater of terrainCraters) {
    const d = Math.hypot(x - crater.x, z - crater.z);
    const inner = crater.r * 0.78;
    const outer = crater.r * 1.18;
    if (d < inner) {
      const t = d / inner;
      const bowl = Math.cos(t * Math.PI * 0.5) ** crater.sharpness;
      const floor = 1 - smoothstep(0.1, 0.55, t) * 0.24;
      height -= bowl * crater.depth * floor;
    } else if (d < outer) {
      const t = (d - inner) / (outer - inner);
      height += Math.sin((1 - t) * Math.PI) * crater.depth * 0.32;
    }
  }
  return height;
}

function createMoonDustTexture() {
  if (moonDustTexture) {
    return moonDustTexture;
  }
  const size = 256;
  const textureCanvas = document.createElement("canvas");
  textureCanvas.width = size;
  textureCanvas.height = size;
  const ctx = textureCanvas.getContext("2d");
  const image = ctx.createImageData(size, size);
  const rng = mulberry32(77);
  for (let i = 0; i < image.data.length; i += 4) {
    const v = 118 + Math.floor((rng() - 0.5) * 34);
    image.data[i] = v + 6;
    image.data[i + 1] = v + 4;
    image.data[i + 2] = v;
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  moonDustTexture = new THREE.CanvasTexture(textureCanvas);
  moonDustTexture.wrapS = THREE.RepeatWrapping;
  moonDustTexture.wrapT = THREE.RepeatWrapping;
  moonDustTexture.repeat.set(24, 24);
  moonDustTexture.colorSpace = THREE.SRGBColorSpace;
  return moonDustTexture;
}

function createMoonRocks(rng) {
  const rockMaterial = new THREE.MeshStandardMaterial({
    color: 0x8d887c,
    roughness: 0.96,
    metalness: 0.02
  });
  const rockGeometry = new THREE.DodecahedronGeometry(1, 0);
  for (let i = 0; i < 260; i += 1) {
    const x = (rng() - 0.5) * WORLD_SIZE * 0.9;
    const z = (rng() - 0.5) * WORLD_SIZE * 0.9;
    if (Math.hypot(x, z - 7) < 8) {
      continue;
    }
    const rock = new THREE.Mesh(rockGeometry, rockMaterial);
    const scale = 0.12 + rng() * rng() * 0.72;
    rock.scale.set(scale * (0.8 + rng() * 0.8), scale * (0.42 + rng() * 0.78), scale * (0.75 + rng() * 0.7));
    rock.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
    rock.position.set(x, terrainHeight(x, z) + scale * 0.32, z);
    rock.castShadow = true;
    rock.receiveShadow = true;
    scene.add(rock);
  }
}

function createMoonDustSpeckles(rng) {
  const geometry = new THREE.BufferGeometry();
  const positions = [];
  const colors = [];
  const color = new THREE.Color();
  for (let i = 0; i < 2300; i += 1) {
    const x = (rng() - 0.5) * WORLD_SIZE * 0.92;
    const z = (rng() - 0.5) * WORLD_SIZE * 0.92;
    const y = terrainHeight(x, z) + 0.035;
    positions.push(x, y, z);
    const shade = 0.38 + rng() * 0.32;
    color.setRGB(shade * 1.1, shade * 1.08, shade);
    colors.push(color.r, color.g, color.b);
  }
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  scene.add(
    new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        size: 0.055,
        vertexColors: true,
        transparent: true,
        opacity: 0.48,
        sizeAttenuation: true
      })
    )
  );
}

function smoothstep(edge0, edge1, value) {
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function fineDust(x, z) {
  return (
    Math.sin(x * 1.7 + z * 0.4) * 0.35 +
    Math.sin(z * 1.31) * 0.25 +
    Math.sin((x - z) * 0.83) * 0.2
  );
}

function softNoise(x, z) {
  return (
    Math.sin(x * 0.13) * 0.34 +
    Math.sin(z * 0.11 + 1.8) * 0.24 +
    Math.sin((x + z) * 0.045) * 0.32
  );
}

function createRoute() {
  const points = getRoutePoints();
  const curvePoints = points.map((point) => new THREE.Vector3(point.x, terrainHeight(point.x, point.z) + 0.08, point.z));
  pathLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(curvePoints),
    new THREE.LineBasicMaterial({
      color: 0xd9f08b,
      transparent: true,
      opacity: 0.3
    })
  );
  scene.add(pathLine);

  const lampMaterial = new THREE.MeshStandardMaterial({
    color: 0xd9f08b,
    emissive: 0x9bc05d,
    emissiveIntensity: 0.75,
    roughness: 0.5
  });
  points.forEach((point, index) => {
    if (index % 2 !== 0) return;
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.23, 14, 10), lampMaterial);
    lamp.position.set(point.x, terrainHeight(point.x, point.z) + 0.32, point.z);
    scene.add(lamp);
  });
}

function getRoutePoints() {
  const points = [new THREE.Vector3(0, 0, 7)];
  for (let i = 0; i < creatureNames.length; i += 1) {
    const z = -18 - i * 22;
    const x = Math.sin(i * 0.95) * 15;
    points.push(new THREE.Vector3(x, 0, z));
  }
  return points;
}

function createAliens() {
  const points = getRoutePoints().slice(1);
  points.forEach((point, index) => {
    const alien = createAlien(index);
    alien.position.set(point.x, terrainHeight(point.x, point.z) + 0.95, point.z);
    alien.rotation.y = Math.PI + Math.sin(index) * 0.2;
    alien.userData = {
      index,
      baseY: alien.position.y,
      completed: false
    };
    aliens.push(alien);
    scene.add(alien);
  });
}

function createAlien(index) {
  const group = new THREE.Group();
  const hueColors = [0xc8f58b, 0xf7b7d9, 0x91e2ff, 0xffdd7a, 0xbeb2ff, 0x87f1cc, 0xffb48a, 0xd4fffb, 0xf4ffa2, 0xd8b2ff];
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: hueColors[index],
    roughness: 0.55,
    metalness: 0.02,
    emissive: hueColors[index],
    emissiveIntensity: 0.06
  });
  const bellyMaterial = new THREE.MeshStandardMaterial({
    color: 0xf8f4df,
    roughness: 0.62
  });
  const eyeMaterial = new THREE.MeshStandardMaterial({
    color: 0x101513,
    roughness: 0.2
  });
  const glowMaterial = new THREE.MeshBasicMaterial({
    color: hueColors[index],
    transparent: true,
    opacity: 0.16
  });

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.88 + (index % 3) * 0.08, 26, 18), bodyMaterial);
  body.scale.set(0.82 + (index % 2) * 0.18, 1.05 + (index % 4) * 0.08, 0.72 + (index % 3) * 0.1);
  body.castShadow = true;
  group.add(body);

  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.42, 20, 12), bellyMaterial);
  belly.position.set(0, -0.1, 0.62);
  belly.scale.set(1, 0.72, 0.18);
  group.add(belly);

  const eyeCount = index % 4 === 0 ? 3 : 2;
  for (let i = 0; i < eyeCount; i += 1) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.105, 16, 10), eyeMaterial);
    const spread = eyeCount === 3 ? (i - 1) * 0.26 : (i === 0 ? -0.18 : 0.18);
    eye.position.set(spread, 0.3 + (i === 1 && eyeCount === 3 ? 0.09 : 0), 0.72);
    group.add(eye);
  }

  const footGeometry = new THREE.SphereGeometry(0.2, 14, 10);
  for (const side of [-1, 1]) {
    const foot = new THREE.Mesh(footGeometry, bodyMaterial);
    foot.position.set(side * 0.36, -0.78, 0.22);
    foot.scale.set(1.1, 0.46, 0.85);
    group.add(foot);
  }

  const antennaCount = index % 3 === 0 ? 2 : 1;
  for (let i = 0; i < antennaCount; i += 1) {
    const offset = antennaCount === 2 ? (i === 0 ? -0.22 : 0.22) : 0;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 0.56, 10), bodyMaterial);
    stem.position.set(offset, 0.98, 0.04);
    stem.rotation.z = offset * 0.75;
    group.add(stem);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.12, 14, 10), bodyMaterial);
    tip.position.set(offset * 1.45, 1.29, 0.04);
    group.add(tip);
  }

  const glow = new THREE.Mesh(new THREE.SphereGeometry(1.35, 28, 16), glowMaterial);
  glow.scale.set(1.1, 0.72, 1.1);
  group.add(glow);

  return group;
}

function createRoverDashboard() {
  roverDash = new THREE.Group();
  const tubeMat = new THREE.MeshStandardMaterial({
    color: 0x9fa6a0,
    roughness: 0.34,
    metalness: 0.72
  });
  const darkTubeMat = new THREE.MeshStandardMaterial({
    color: 0x202521,
    roughness: 0.48,
    metalness: 0.62
  });
  const panelMat = new THREE.MeshStandardMaterial({
    color: 0x56635b,
    emissive: 0x22351e,
    emissiveIntensity: 0.18,
    roughness: 0.42,
    metalness: 0.24
  });
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xd9f08b,
    transparent: true,
    opacity: 0.7
  });
  const tireMat = new THREE.MeshStandardMaterial({
    color: 0x111311,
    roughness: 0.88,
    metalness: 0.02
  });
  const rimMat = new THREE.MeshStandardMaterial({
    color: 0xc8c9bd,
    roughness: 0.28,
    metalness: 0.76
  });
  const suitMat = new THREE.MeshStandardMaterial({
    color: 0xd8d8c8,
    roughness: 0.62,
    metalness: 0.04
  });
  const gloveMat = new THREE.MeshStandardMaterial({
    color: 0xefe9d0,
    roughness: 0.56,
    metalness: 0.03
  });

  createOpenRoverFrame(roverDash, tubeMat, darkTubeMat);
  createRoverWheels(roverDash, tireMat, rimMat);
  createRoverControls(roverDash, panelMat, tubeMat, glowMat);
  createAstronautArms(roverDash, suitMat, gloveMat, tubeMat);
  createRoverAntennaAndGear(roverDash, tubeMat, panelMat, glowMat);

  const leftLight = new THREE.PointLight(0xd9f08b, 0.35, 4);
  leftLight.position.set(-0.58, -0.58, -1.34);
  roverDash.add(leftLight);
  const rightLight = leftLight.clone();
  rightLight.position.x = 0.58;
  roverDash.add(rightLight);
  camera.add(roverDash);
}

function createOpenRoverFrame(parent, tubeMat, darkTubeMat) {
  const rails = [
    [[-0.88, -0.75, -0.76], [-1.18, -0.76, -1.88], 0.025],
    [[0.88, -0.75, -0.76], [1.18, -0.76, -1.88], 0.025],
    [[-0.72, -0.58, -0.82], [-1.08, -0.48, -1.62], 0.018],
    [[0.72, -0.58, -0.82], [1.08, -0.48, -1.62], 0.018],
    [[-1.08, -0.55, -1.52], [1.08, -0.55, -1.52], 0.022],
    [[-0.88, -0.76, -1.86], [0.88, -0.76, -1.86], 0.024],
    [[-0.72, -0.58, -0.82], [0.72, -0.58, -0.82], 0.018],
    [[-0.58, -0.7, -0.72], [0.58, -0.7, -0.72], 0.018],
    [[-0.78, -0.68, -0.86], [0, -0.62, -1.48], 0.018],
    [[0.78, -0.68, -0.86], [0, -0.62, -1.48], 0.018]
  ];
  rails.forEach(([start, end, radius]) => {
    addTubeBetween(parent, tubeMat, new THREE.Vector3(...start), new THREE.Vector3(...end), radius);
  });

  const footDeck = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.05, 0.58), darkTubeMat);
  footDeck.position.set(0, -0.83, -0.78);
  footDeck.rotation.x = -0.1;
  parent.add(footDeck);

  const ribbedPanel = new THREE.Group();
  for (let i = 0; i < 7; i += 1) {
    const rib = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.58), tubeMat);
    rib.position.set(-0.48 + i * 0.16, -0.78, -0.98);
    rib.rotation.x = -0.12;
    ribbedPanel.add(rib);
  }
  parent.add(ribbedPanel);
}

function createRoverWheels(parent, tireMat, rimMat) {
  const leftWheel = createRoverWheel(tireMat, rimMat);
  leftWheel.position.set(-1.05, -0.66, -1.48);
  leftWheel.rotation.y = Math.PI * 0.5;
  parent.add(leftWheel);

  const rightWheel = createRoverWheel(tireMat, rimMat);
  rightWheel.position.set(1.05, -0.66, -1.48);
  rightWheel.rotation.y = Math.PI * 0.5;
  parent.add(rightWheel);

  const farLeftWheel = createRoverWheel(tireMat, rimMat, 0.72);
  farLeftWheel.position.set(-1.18, -0.66, -2.12);
  farLeftWheel.rotation.y = Math.PI * 0.5;
  farLeftWheel.scale.setScalar(0.82);
  parent.add(farLeftWheel);

  const farRightWheel = createRoverWheel(tireMat, rimMat, 0.72);
  farRightWheel.position.set(1.18, -0.66, -2.12);
  farRightWheel.rotation.y = Math.PI * 0.5;
  farRightWheel.scale.setScalar(0.82);
  parent.add(farRightWheel);

  cockpitParts.wheels = [leftWheel, rightWheel, farLeftWheel, farRightWheel];
}

function createRoverWheel(tireMat, rimMat, treadScale = 1) {
  const wheel = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.09, 14, 32), tireMat);
  wheel.add(tire);

  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.017, 10, 28), rimMat);
  wheel.add(rim);

  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.08, 20), rimMat);
  hub.rotation.x = Math.PI * 0.5;
  wheel.add(hub);

  for (let i = 0; i < 18; i += 1) {
    const angle = (i / 18) * Math.PI * 2;
    const tread = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.035, 0.19 * treadScale), tireMat);
    tread.position.set(Math.cos(angle) * 0.24, Math.sin(angle) * 0.24, 0);
    tread.rotation.z = angle;
    tread.rotation.y = Math.PI * 0.5;
    wheel.add(tread);
  }

  for (let i = 0; i < 6; i += 1) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.17, 0.016), rimMat);
    spoke.rotation.z = (i / 6) * Math.PI;
    wheel.add(spoke);
  }
  return wheel;
}

function createRoverControls(parent, panelMat, tubeMat, glowMat) {
  const consoleBase = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.34, 0.36), panelMat);
  consoleBase.position.set(0, -0.53, -1.12);
  consoleBase.rotation.x = -0.26;
  parent.add(consoleBase);

  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(0.38, 0.22),
    new THREE.MeshBasicMaterial({ color: 0xa9d978, transparent: true, opacity: 0.74 })
  );
  screen.position.set(0, -0.42, -0.91);
  screen.rotation.x = -0.52;
  parent.add(screen);
  cockpitParts.screen = screen;

  for (let i = 0; i < 5; i += 1) {
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.026, 10, 8), glowMat);
    light.position.set(-0.2 + i * 0.1, -0.5, -0.87);
    parent.add(light);
  }

  const handleBar = new THREE.Group();
  addTubeBetween(handleBar, tubeMat, new THREE.Vector3(-0.4, -0.42, -0.82), new THREE.Vector3(0.4, -0.42, -0.82), 0.02);
  addTubeBetween(handleBar, tubeMat, new THREE.Vector3(-0.26, -0.42, -0.82), new THREE.Vector3(-0.42, -0.36, -0.76), 0.018);
  addTubeBetween(handleBar, tubeMat, new THREE.Vector3(0.26, -0.42, -0.82), new THREE.Vector3(0.42, -0.36, -0.76), 0.018);
  cockpitParts.handleBar = handleBar;
  parent.add(handleBar);
}

function createAstronautArms(parent, suitMat, gloveMat, tubeMat) {
  const leftArm = createAstronautArm(-1, suitMat, gloveMat);
  const rightArm = createAstronautArm(1, suitMat, gloveMat);
  parent.add(leftArm, rightArm);
  cockpitParts.leftArm = leftArm;
  cockpitParts.rightArm = rightArm;

  const suitTrimMat = new THREE.MeshStandardMaterial({ color: 0xb5181d, roughness: 0.44, metalness: 0.04 });
  for (const side of [-1, 1]) {
    const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.065, 0.008, 8, 18), suitTrimMat);
    cuff.position.set(side * 0.37, -0.34, -0.79);
    cuff.rotation.y = Math.PI * 0.5;
    parent.add(cuff);
  }

  addTubeBetween(parent, tubeMat, new THREE.Vector3(-0.35, -0.49, -0.84), new THREE.Vector3(0.35, -0.49, -0.84), 0.014);
}

function createAstronautArm(side, suitMat, gloveMat) {
  const arm = new THREE.Group();
  const shoulder = new THREE.Vector3(side * 0.72, -0.72, -0.42);
  const elbow = new THREE.Vector3(side * 0.5, -0.52, -0.62);
  const wrist = new THREE.Vector3(side * 0.36, -0.39, -0.78);
  addTubeBetween(arm, suitMat, shoulder, elbow, 0.07);
  addTubeBetween(arm, suitMat, elbow, wrist, 0.06);

  const glove = new THREE.Mesh(new THREE.SphereGeometry(0.075, 18, 12), gloveMat);
  glove.position.copy(wrist);
  glove.scale.set(1.05, 0.72, 1.2);
  arm.add(glove);

  const finger = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.035, 0.11), gloveMat);
  finger.position.set(side * 0.34, -0.38, -0.84);
  finger.rotation.y = side * 0.34;
  arm.add(finger);
  return arm;
}

function createRoverAntennaAndGear(parent, tubeMat, panelMat, glowMat) {
  const sensorMount = new THREE.Group();
  sensorMount.position.set(-0.45, -0.57, -1.25);
  sensorMount.rotation.set(-0.12, 0.12, -0.04);

  const basePlate = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.055, 0.24), panelMat);
  basePlate.position.set(0, -0.03, 0);
  sensorMount.add(basePlate);

  const sensorPod = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.2, 0.18), panelMat);
  sensorPod.position.set(0, 0.1, -0.02);
  sensorMount.add(sensorPod);

  addTubeBetween(sensorMount, tubeMat, new THREE.Vector3(-0.18, -0.06, 0.11), new THREE.Vector3(-0.32, -0.34, 0.34), 0.014);
  addTubeBetween(sensorMount, tubeMat, new THREE.Vector3(0.18, -0.06, 0.11), new THREE.Vector3(0.1, -0.34, 0.36), 0.014);
  addTubeBetween(sensorMount, tubeMat, new THREE.Vector3(0, -0.06, -0.11), new THREE.Vector3(0.24, -0.32, -0.34), 0.012);
  parent.add(sensorMount);

  const cameraEye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 16, 10), glowMat);
  cameraEye.position.set(0, 0.11, 0.09);
  sensorMount.add(cameraEye);

  const antennaBase = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.08, 14), panelMat);
  antennaBase.position.set(0.18, 0.22, -0.02);
  sensorMount.add(antennaBase);

  const shortAntenna = new THREE.Group();
  shortAntenna.position.set(0.18, 0.26, -0.02);
  addTubeBetween(shortAntenna, tubeMat, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.08, 0.28, -0.06), 0.008);
  const antennaTip = new THREE.Mesh(new THREE.SphereGeometry(0.025, 10, 8), glowMat);
  antennaTip.position.set(0.08, 0.28, -0.06);
  shortAntenna.add(antennaTip);
  sensorMount.add(shortAntenna);

  const rightInstrument = new THREE.Group();
  rightInstrument.position.set(0.44, -0.62, -1.18);
  addTubeBetween(rightInstrument, tubeMat, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.18, 0.22, -0.1), 0.016);
  const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.035, 24), panelMat);
  dial.position.set(0.2, 0.24, -0.11);
  dial.rotation.x = Math.PI * 0.5;
  rightInstrument.add(dial);
  const dialFace = new THREE.Mesh(new THREE.CircleGeometry(0.07, 24), glowMat);
  dialFace.position.set(0.2, 0.24, -0.09);
  dialFace.rotation.x = Math.PI * 0.5;
  rightInstrument.add(dialFace);
  parent.add(rightInstrument);

  const sampleArm = new THREE.Group();
  sampleArm.position.set(0.58, -0.48, -1.18);
  addTubeBetween(sampleArm, tubeMat, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.35, 0.06, -0.34), 0.026);
  addTubeBetween(sampleArm, tubeMat, new THREE.Vector3(0.35, 0.06, -0.34), new THREE.Vector3(0.5, -0.04, -0.62), 0.02);
  const scoop = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.04, 0.12), panelMat);
  scoop.position.set(0.54, -0.05, -0.68);
  scoop.rotation.x = 0.45;
  sampleArm.add(scoop);
  parent.add(sampleArm);
  cockpitParts.sampleArm = sampleArm;
}

function addTubeBetween(parent, material, start, end, radius) {
  const midpoint = start.clone().add(end).multiplyScalar(0.5);
  const direction = end.clone().sub(start);
  const segment = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 0.92, direction.length(), 14), material);
  segment.position.copy(midpoint);
  segment.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  parent.add(segment);
}

function bindInput() {
  window.__moonAdventureInputCleanup?.();

  const controller = new AbortController();
  const { signal } = controller;
  const cleanupInput = () => controller.abort();
  window.__moonAdventureInputCleanup = cleanupInput;

  window.addEventListener("resize", resize, { signal });
  window.addEventListener("keydown", (event) => {
    if (event[INPUT_EVENT_HANDLED_FLAG]) {
      return;
    }
    event[INPUT_EVENT_HANDLED_FLAG] = true;

    if (CONTROL_KEYS.includes(event.code)) {
      event.preventDefault();
    }
    tryStartMusic();
    if (state.mode === "quiz") {
      if (event.repeat) {
        return;
      }
      handleQuizKey(event.code);
      return;
    }
    if (event.code.startsWith("Arrow")) {
      state.keys.add(event.code);
    }
  }, { signal });

  window.addEventListener("keyup", (event) => {
    state.keys.delete(event.code);
  }, { signal });

  window.addEventListener("pointerdown", tryStartMusic, { signal });

  musicButton.addEventListener("click", () => {
    state.audioWanted = !state.audioWanted;
    if (state.audioWanted) {
      tryStartMusic();
    } else {
      audio.pause();
      state.audioReady = false;
    }
    updateMusicButton();
  }, { signal });

  restartButton.addEventListener("click", () => {
    resetGame();
  }, { signal });

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      cleanupInput();
      if (window.__moonAdventureInputCleanup === cleanupInput) {
        delete window.__moonAdventureInputCleanup;
      }
    });
  }
}

function handleQuizKey(code) {
  const directOption = ["KeyA", "KeyB", "KeyC", "KeyD", "Digit1", "Digit2", "Digit3", "Digit4"].indexOf(code);
  if (directOption >= 0) {
    state.selectedOption = directOption % 4;
    renderOptions();
  } else if (code === "ArrowLeft") {
    state.selectedOption = (state.selectedOption + 3) % 4;
    renderOptions();
  } else if (code === "ArrowRight") {
    state.selectedOption = (state.selectedOption + 1) % 4;
    renderOptions();
  } else if (code === "Space") {
    submitAnswer();
  }
}

function tryStartMusic() {
  if (!state.audioWanted || bgmPlaylist.length === 0) {
    state.audioReady = false;
    updateMusicButton();
    return;
  }
  if (!audio.src) {
    setBgmTrack(0);
  }
  audio
    .play()
    .then(() => {
      state.audioReady = true;
      updateMusicButton();
    })
    .catch(() => {
      state.audioReady = false;
      updateMusicButton();
    });
}

function setBgmTrack(index) {
  if (bgmPlaylist.length === 0) {
    return;
  }
  currentBgmIndex = (index + bgmPlaylist.length) % bgmPlaylist.length;
  audio.src = bgmPlaylist[currentBgmIndex];
  audio.load();
}

function playNextBgmTrack() {
  if (!state.audioWanted || bgmPlaylist.length === 0) {
    return;
  }
  setBgmTrack(currentBgmIndex + 1);
  tryStartMusic();
}

function updateMusicButton() {
  musicButton.setAttribute("aria-pressed", String(state.audioWanted && state.audioReady && !audio.paused));
  musicIcon.textContent = state.audioWanted && state.audioReady && !audio.paused ? "♪" : "×";
}

function animate(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.04);
  lastTime = now;
  updateRover(dt);
  updateAliens(now * 0.001);
  updateCockpit(now * 0.001);
  updateMeteors(now * 0.001, dt);
  updateSparkles(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

function updateCockpit(time) {
  if (cockpitParts.wheels) {
    cockpitParts.wheels.forEach((wheel) => {
      wheel.rotation.x = time * state.rover.speed * 0.75;
    });
  }
  if (cockpitParts.handleBar) {
    cockpitParts.handleBar.rotation.z = Math.sin(time * 1.3) * 0.018 + state.rover.speed * 0.001;
  }
  if (cockpitParts.leftArm) {
    cockpitParts.leftArm.rotation.z = Math.sin(time * 1.1) * 0.01;
  }
  if (cockpitParts.rightArm) {
    cockpitParts.rightArm.rotation.z = -Math.sin(time * 1.1) * 0.01;
  }
  if (cockpitParts.sampleArm) {
    cockpitParts.sampleArm.rotation.y = -0.18 + Math.sin(time * 0.8) * 0.025;
  }
  if (cockpitParts.screen) {
    cockpitParts.screen.material.opacity = 0.56 + Math.sin(time * 2.2) * 0.12;
  }
}

function updateRover(dt) {
  if (state.mode !== "drive") {
    state.rover.speed = THREE.MathUtils.damp(state.rover.speed, 0, 7, dt);
    updateCamera();
    return;
  }

  const turn = 1.65;
  if (state.keys.has("ArrowLeft")) {
    state.rover.yaw += turn * dt;
  }
  if (state.keys.has("ArrowRight")) {
    state.rover.yaw -= turn * dt;
  }

  const wantedSpeed = (state.keys.has("ArrowUp") ? 9.4 : 0) + (state.keys.has("ArrowDown") ? -4.2 : 0);
  state.rover.speed = THREE.MathUtils.damp(state.rover.speed, wantedSpeed, 4.5, dt);
  const direction = new THREE.Vector3(-Math.sin(state.rover.yaw), 0, -Math.cos(state.rover.yaw));
  const proposed = state.rover.position.clone().addScaledVector(direction, state.rover.speed * dt);
  proposed.x = THREE.MathUtils.clamp(proposed.x, -WORLD_LIMIT, WORLD_LIMIT);
  proposed.z = THREE.MathUtils.clamp(proposed.z, -WORLD_LIMIT, WORLD_LIMIT);

  state.rover.position.copy(proposed);
  state.rover.position.y = terrainHeight(state.rover.position.x, state.rover.position.z) + ROVER_EYE_HEIGHT;
  updateCamera();
  checkAlienEncounter();
}

function updateCamera() {
  camera.position.copy(state.rover.position);
  const roll = Math.sin(performance.now() * 0.004) * Math.min(Math.abs(state.rover.speed) / 9, 1) * 0.008;
  camera.rotation.set(-0.055, state.rover.yaw, roll);
  updateEarth();
}

function updateAliens(time) {
  aliens.forEach((alien, index) => {
    if (alien.userData.completed) {
      alien.visible = false;
      return;
    }
    alien.visible = true;
    alien.position.y = alien.userData.baseY + Math.sin(time * 1.6 + index) * 0.13;
    const distance = state.rover.position.distanceTo(alien.position);
    if (state.currentAlien === index || distance < ALIEN_FACE_DISTANCE) {
      faceAlienToRover(alien, 0.18);
    } else {
      alien.rotation.y += 0.002 + index * 0.0001;
    }
  });
}

function faceAlienToRover(alien, amount = 1) {
  const dx = state.rover.position.x - alien.position.x;
  const dz = state.rover.position.z - alien.position.z;
  if (Math.hypot(dx, dz) < 0.001) {
    return;
  }
  const targetYaw = Math.atan2(dx, dz);
  const delta = Math.atan2(Math.sin(targetYaw - alien.rotation.y), Math.cos(targetYaw - alien.rotation.y));
  alien.rotation.y += delta * amount;
}

function updateMeteors(time, dt) {
  if (time >= nextMeteorTime) {
    spawnMeteor();
    scheduleNextMeteor(time);
  }

  for (let i = meteors.length - 1; i >= 0; i -= 1) {
    const meteor = meteors[i];
    meteor.userData.age += dt;
    meteor.position.addScaledVector(meteor.userData.velocity, dt);

    const progress = THREE.MathUtils.clamp(meteor.userData.age / meteor.userData.life, 0, 1);
    const fadeIn = THREE.MathUtils.smoothstep(progress, 0, 0.18);
    const fadeOut = 1 - THREE.MathUtils.smoothstep(progress, 0.58, 1);
    const opacity = fadeIn * fadeOut;
    meteor.userData.streakMaterial.opacity = 0.78 * opacity;

    if (meteor.userData.age >= meteor.userData.life) {
      disposeMeteor(meteor);
      meteors.splice(i, 1);
    }
  }
}

function disposeMeteor(meteor) {
  meteorLayer.remove(meteor);
  meteor.children.forEach((child) => {
    if (child.geometry) {
      child.geometry.dispose();
    }
    child.material.dispose();
  });
}

function updateSparkles(dt) {
  for (let i = sparkleBursts.length - 1; i >= 0; i -= 1) {
    const burst = sparkleBursts[i];
    burst.life -= dt;
    burst.points.material.opacity = Math.max(0, burst.life / burst.maxLife);
    burst.points.rotation.y += dt * 0.9;
    burst.points.position.y += dt * 0.65;
    if (burst.life <= 0) {
      scene.remove(burst.points);
      burst.points.geometry.dispose();
      burst.points.material.dispose();
      sparkleBursts.splice(i, 1);
    }
  }
}

function checkAlienEncounter() {
  const nearest = findNearestIncompleteAlien();
  if (!nearest) {
    return;
  }
  if (nearest.distance < ENCOUNTER_DISTANCE) {
    beginQuestion(nearest.index);
  } else if (nearest.distance < 18) {
    hintText.textContent = `${creatureNames[nearest.index]} 就在附近，靠近她来答题。`;
  }
}

function findNearestIncompleteAlien() {
  let nearest = null;
  aliens.forEach((alien, index) => {
    if (alien.userData.completed) {
      return;
    }
    const distance = state.rover.position.distanceTo(alien.position);
    if (!nearest || distance < nearest.distance) {
      nearest = { alien, index, distance };
    }
  });
  return nearest;
}

function beginQuestion(alienIndex) {
  state.mode = "quiz";
  state.keys.clear();
  state.selectedOption = 0;
  state.currentAlien = alienIndex;
  faceAlienToRover(aliens[alienIndex], 1);
  updateCamera();
  showNewQuestion();
  questionPanel.classList.remove("hidden");
  hintText.textContent = "答对题目就能得到一颗星。";
}

function showNewQuestion() {
  const available = questionPool.filter((question) => !state.usedQuestionIds.has(question.id));
  const pool = available.length > 0 ? available : questionPool;
  if (available.length === 0) {
    state.usedQuestionIds.clear();
  }
  const question = pool[Math.floor(Math.random() * pool.length)];
  state.currentQuestion = question;
  state.usedQuestionIds.add(question.id);
  questionCreature.textContent = `${creatureNames[state.currentAlien]} 的月光题`;
  questionMeta.textContent = `${question.subject} · 选择 A、B、C、D`;
  questionText.textContent = question.question;
  renderOptions();
}

function renderOptions() {
  optionsEl.replaceChildren();
  state.currentQuestion.options.forEach((option, index) => {
    const item = document.createElement("div");
    item.className = `option${index === state.selectedOption ? " selected" : ""}`;
    const letter = document.createElement("span");
    letter.className = "option-letter";
    letter.textContent = OPTION_LETTERS[index];
    const label = document.createElement("span");
    label.textContent = option;
    item.append(letter, label);
    optionsEl.append(item);
  });
}

function submitAnswer() {
  if (!state.currentQuestion) {
    return;
  }
  if (state.selectedOption === state.currentQuestion.answer) {
    completeCurrentAlien();
    return;
  }
  hintText.textContent = "没关系，外星朋友换一道新题。";
  state.selectedOption = 0;
  showNewQuestion();
}

function completeCurrentAlien() {
  const alien = aliens[state.currentAlien];
  alien.userData.completed = true;
  alien.visible = false;
  makeSparkles(alien.position, alien.userData.index);
  state.stars += 1;
  state.currentAlien = null;
  state.mode = "drive";
  questionPanel.classList.add("hidden");
  updateHud();

  if (state.stars >= aliens.length) {
    finishGame();
  } else {
    hintText.textContent = "得到一颗星！继续自由寻找下一位外星朋友。";
  }
}

function makeSparkles(position, seed) {
  const rng = mulberry32(seed + 100);
  const geometry = new THREE.BufferGeometry();
  const positions = [];
  for (let i = 0; i < 90; i += 1) {
    const radius = rng() * 1.8;
    const angle = rng() * Math.PI * 2;
    positions.push(Math.cos(angle) * radius, rng() * 1.5, Math.sin(angle) * radius);
  }
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: 0xffe790,
    size: 0.12,
    transparent: true,
    opacity: 1
  });
  const points = new THREE.Points(geometry, material);
  points.position.copy(position);
  scene.add(points);
  sparkleBursts.push({ points, life: 1.7, maxLife: 1.7 });
}

function finishGame() {
  state.mode = "finish";
  hintText.textContent = "你已经完成全部月球任务。";
  finishPanel.classList.remove("hidden");
}

function resetGame() {
  state.mode = "drive";
  state.keys.clear();
  state.rover.position.set(0, terrainHeight(0, 7) + ROVER_EYE_HEIGHT, 7);
  state.rover.yaw = 0;
  state.rover.speed = 0;
  state.stars = 0;
  state.currentAlien = null;
  state.selectedOption = 0;
  state.currentQuestion = null;
  state.usedQuestionIds.clear();
  aliens.forEach((alien) => {
    alien.userData.completed = false;
    alien.visible = true;
  });
  questionPanel.classList.add("hidden");
  finishPanel.classList.add("hidden");
  hintText.textContent = "自由驾驶月球车，寻找任意一位外星朋友。";
  updateHud();
  updateCamera();
}

function updateHud() {
  progressText.textContent = `外星朋友 ${state.stars} / ${aliens.length || 10}`;
  starText.textContent = `星星 ${state.stars}`;
}

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function mulberry32(seed) {
  return function random() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
