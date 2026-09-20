import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { bounds } from './geometry.js';

export class Viewer {
  constructor(host, onPlaneChange) {
    this.host = host;
    this.onPlaneChange = onPlaneChange;
    this.meshes = new Map();
    this.explode = 0;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    host.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.01, 10000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(100, -140, 100);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0, 20);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x54657a, 2.2));
    const key = new THREE.DirectionalLight(0xfff5e7, 2.2);
    key.position.set(-30, -80, 140);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xbedbff, 1.1);
    fill.position.set(60, 50, 60);
    this.scene.add(fill);
    this.grid = new THREE.GridHelper(200, 20, 0x607486, 0x3a4b5d);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.3;
    this.scene.add(this.grid);
    this.plane = new THREE.Group();
    this.planeFill = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: 0xf8b868,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.planeOutline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
      new THREE.LineBasicMaterial({ color: 0xf8bc75, transparent: true, opacity: 0.9 }),
    );
    this.plane.add(this.planeFill, this.planeOutline);
    this.scene.add(this.plane);
    this.plane.visible = false;
    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.setSize(0.8);
    this.transform.setSpace('local');
    this.scene.add(this.transform.getHelper());
    this.transform.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value;
    });
    this.transform.addEventListener('objectChange', () => {
      if (this.settingPlane) return;
      const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(this.plane.quaternion).normalize();
      this.onPlaneChange(normal.toArray(), this.plane.position.dot(normal));
    });
    this.setMode('translate');
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }
  resize() {
    const { width, height } = this.host.getBoundingClientRect();
    if (!width || !height) return;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
  load(pieces, palette, selectedId, fit = true) {
    for (const mesh of this.meshes.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.meshes.clear();
    this.pieces = pieces;
    this.palette = palette;
    this.box = bounds(pieces);
    for (const piece of pieces) {
      const positions = new Float32Array(piece.faces.length * 9),
        colors = new Float32Array(positions.length);
      let i = 0;
      const colorCache = palette.map((c) => new THREE.Color(c));
      for (const face of piece.faces) {
        const color = colorCache[face.material - 1] || colorCache[0];
        for (const id of face.v) {
          positions.set(piece.vertices[id], i);
          colors.set([color.r, color.g, color.b], i);
          i += 3;
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geometry.computeVertexNormals();
      const material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.88,
        metalness: 0.02,
        flatShading: true,
        side: THREE.DoubleSide,
        wireframe: !!this.wireframe,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.pieceId = piece.id;
      this.meshes.set(piece.id, mesh);
      this.scene.add(mesh);
    }
    this.grid.position.set(this.box.center[0], this.box.center[1], this.box.min[2] - 0.1);
    const extent = Math.max(...this.box.size, 20);
    this.grid.scale.setScalar(Math.max(1, extent / 100));
    this.select(selectedId);
    this.setExplode(this.explode);
    if (fit) this.fit();
  }
  select(id) {
    this.selectedId = id;
    for (const [key, mesh] of this.meshes)
      mesh.material.emissive.setHex(key === id ? 0x101915 : 0x000000);
  }
  setPalette(palette) {
    if (this.pieces) this.load(this.pieces, palette, this.selectedId, false);
  }
  setPlane(normal, offset, center, visible = true) {
    this.settingPlane = true;
    this.plane.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(...normal),
    );
    const c = new THREE.Vector3(...center),
      n = new THREE.Vector3(...normal);
    this.plane.position.copy(c).addScaledVector(n, offset - c.dot(n));
    const piece = this.pieces?.find((p) => p.id === this.selectedId),
      box = piece ? bounds([piece]) : this.box;
    const size = Math.max(...(box?.size || [50])) * 1.35;
    this.planeFill.scale.set(size, size, 1);
    this.planeOutline.scale.copy(this.planeFill.scale);
    this.plane.visible = visible;
    if (visible) this.transform.attach(this.plane);
    else this.transform.detach();
    this.settingPlane = false;
  }
  setMode(mode) {
    this.transform.setMode(mode);
    this.transform.showX = mode === 'rotate';
    this.transform.showY = mode === 'rotate';
    this.transform.showZ = true;
  }
  setExplode(value) {
    this.explode = value;
    if (!this.pieces) return;
    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i],
        center = bounds([p]).center,
        delta = new THREE.Vector3(...center).sub(new THREE.Vector3(...this.box.center));
      if (delta.length() < 0.01) delta.set(i % 2 ? 1 : -1, 0, 0);
      delta.normalize().multiplyScalar(this.pieces.length > 1 ? value : 0);
      this.meshes.get(p.id).position.copy(delta);
    }
  }
  fit(view = 'iso') {
    if (!this.box) return;
    const center = new THREE.Vector3(...this.box.center),
      size = Math.max(...this.box.size, 1) + this.explode * 2;
    const dirs = { iso: [1, -1.5, 0.95], top: [0, 0, 1], front: [0, -1, 0], right: [1, 0, 0] },
      direction = new THREE.Vector3(...dirs[view]).normalize();
    this.camera.up.set(0, view === 'top' ? 1 : 0, view === 'top' ? 0 : 1);
    const distance =
      ((size / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)))) * 1.4) /
      Math.min(this.camera.aspect, 1);
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.near = Math.max(0.001, distance / 10000);
    this.camera.far = Math.max(10000, distance * 20);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
  }
  setWireframe(value) {
    this.wireframe = value;
    for (const mesh of this.meshes.values()) mesh.material.wireframe = value;
  }
}
