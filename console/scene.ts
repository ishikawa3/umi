// かいしょう — three.js の 3D 海図（地球儀）
//
// PLAN4 0.4 A案・0.6 の painterly ライト意匠に沿う。硬い光沢やネオングローは避け、
// 半球光によるやわらかい陰影＋淡い霞（atmospheric haze）で「にじむ光」を作る。

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { latLonToVec3, vec3ToLatLon, EARTH_RADIUS } from "./geo";

// 0.6 の配色トークン（3D側でも同じ値を使う）
const SEA = new THREE.Color("#2fa5a0"); // 基調ティール（海）
const SKY_LIGHT = new THREE.Color("#eef4f2"); // 空の淡色（半球光の上）
const HAZE = new THREE.Color("#bfe0dc"); // 霞のパステル
const GRATICULE = new THREE.Color("#3c6e69"); // 経緯線（低コントラスト）

/** 日本近海に初期カメラを寄せるための代表点 */
const JAPAN_LAT = 37;
const JAPAN_LON = 137;

export class Globe {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;

  private readonly ocean: THREE.Mesh;
  private readonly raycaster = new THREE.Raycaster();
  private readonly el: HTMLElement;
  private readonly frameCbs: ((tMs: number) => void)[] = [];

  constructor(container: HTMLElement) {
    this.el = container;
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(38, w / h, 0.01, 100);
    this.camera.position.copy(latLonToVec3(JAPAN_LAT, JAPAN_LON, 2.7));

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.rotateSpeed = 0.5;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 4.2;

    // --- 光: 半球光でやわらかく（空=淡色, 地=海ティール）＋弱い方向光 ---
    const hemi = new THREE.HemisphereLight(SKY_LIGHT, SEA.clone().multiplyScalar(0.28), 0.85);
    this.scene.add(hemi);
    // やわらかい方向光で球にゆるい明暗（終端線）を作り、立体に見せる
    const key = new THREE.DirectionalLight(0xffffff, 0.6);
    key.position.set(-1.1, 0.9, 0.7);
    this.scene.add(key);

    // --- 海（地球本体）: つや消しのティール球 ---
    const oceanGeo = new THREE.SphereGeometry(EARTH_RADIUS, 96, 96);
    const oceanMat = new THREE.MeshStandardMaterial({
      color: SEA,
      roughness: 1,
      metalness: 0,
    });
    this.ocean = new THREE.Mesh(oceanGeo, oceanMat);
    this.scene.add(this.ocean);

    // --- 経緯線（30°ごと。低コントラストの細線） ---
    this.scene.add(this.buildGraticule());

    // --- 霞（背側フレネルのパステル。ネオンにしない） ---
    this.scene.add(this.buildHaze());
  }

  private buildGraticule(): THREE.LineSegments {
    const pts: THREE.Vector3[] = [];
    const R = EARTH_RADIUS * 1.001;
    const seg = 120;
    // 緯線
    for (let lat = -60; lat <= 60; lat += 30) {
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * 360;
        const b = ((i + 1) / seg) * 360;
        pts.push(latLonToVec3(lat, a, R), latLonToVec3(lat, b, R));
      }
    }
    // 経線
    for (let lon = 0; lon < 360; lon += 30) {
      for (let i = 0; i < seg; i++) {
        const a = -90 + (i / seg) * 180;
        const b = -90 + ((i + 1) / seg) * 180;
        pts.push(latLonToVec3(a, lon, R), latLonToVec3(b, lon, R));
      }
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: GRATICULE, transparent: true, opacity: 0.22 });
    return new THREE.LineSegments(geo, mat);
  }

  private buildHaze(): THREE.Mesh {
    const geo = new THREE.SphereGeometry(EARTH_RADIUS * 1.12, 64, 64);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { uColor: { value: HAZE } },
      vertexShader: /* glsl */ `
        varying vec3 vN;
        varying vec3 vP;
        void main() {
          vN = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vP = mv.xyz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying vec3 vN;
        varying vec3 vP;
        void main() {
          vec3 v = normalize(-vP);
          float f = pow(1.0 - abs(dot(vN, v)), 2.2);
          gl_FragColor = vec4(uColor, f * 0.5);
        }
      `,
    });
    return new THREE.Mesh(geo, mat);
  }

  /** ポインタ位置(canvas内CSS座標)の海面が指す緯度経度。海に当たらなければ null */
  latLonAtPointer(cssX: number, cssY: number): { lat: number; lon: number } | null {
    this.raycaster.setFromCamera(this.pointerToNdc(cssX, cssY), this.camera);
    const hit = this.raycaster.intersectObject(this.ocean, false)[0];
    return hit ? vec3ToLatLon(hit.point) : null;
  }

  private pointerToNdc(cssX: number, cssY: number): THREE.Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((cssX - rect.left) / rect.width) * 2 - 1,
      -((cssY - rect.top) / rect.height) * 2 + 1
    );
  }

  /** レイヤが自前のオブジェクトを載せる（Group等） */
  add(obj: THREE.Object3D): void {
    this.scene.add(obj);
  }

  /**
   * ポインタ位置で対象オブジェクト群にレイキャストし、最も手前の交差を返す。
   * 地球儀の裏側（海の陰）に隠れた点は呼び出し側で isFacingCamera により除外する。
   */
  raycastAt(cssX: number, cssY: number, objects: THREE.Object3D[]): THREE.Intersection[] {
    this.raycaster.setFromCamera(this.pointerToNdc(cssX, cssY), this.camera);
    return this.raycaster.intersectObjects(objects, false);
  }

  /** 毎フレーム呼ばれるコールバックを登録（レイヤのアニメーション用） */
  onFrame(cb: (tMs: number) => void): void {
    this.frameCbs.push(cb);
  }

  /** カメラ距離（ズーム指標。UIのステータスバー表示に使う） */
  get cameraDistance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  resize(): void {
    const w = this.el.clientWidth || 1;
    const h = this.el.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private frame = (tMs: number): void => {
    this.controls.update();
    for (const cb of this.frameCbs) cb(tMs);
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.frame);
  };

  start(): void {
    requestAnimationFrame(this.frame);
  }
}
