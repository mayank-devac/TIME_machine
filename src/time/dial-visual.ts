import {
  CanvasTexture,
  CircleGeometry,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import { TIME } from './constants.js';

const PX = 256;
const TICKS = 12;
const TICK_RAD = (Math.PI * 2) / TICKS;

/**
 * The visible wrist dial: a small round face that floats just above the dial hand and
 * always faces the viewer. It shows the dialled year, the stops either side, and a bead
 * that travels round the ring as the wrist rolls; when the bead reaches the next tick the
 * year clicks over. XR only (the desktop page uses the mouse wheel and Track G's label).
 *
 * Two draw calls while visible (face + bead). The canvas is repainted only when the year
 * changes, never per frame. Its texture is a 256 px label, not a panorama, so it does not
 * count against the two-panorama budget.
 */
export class DialVisual {
  readonly mesh: Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D | null;
  private readonly texture: CanvasTexture;
  private readonly face: MeshBasicMaterial;
  private readonly beadMat: MeshBasicMaterial;
  private readonly bead: Mesh;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = PX;
    this.canvas.height = PX;
    this.g = this.canvas.getContext('2d');
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.face = new MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false });
    this.mesh = new Mesh(new PlaneGeometry(TIME.dialSizeM, TIME.dialSizeM), this.face);
    this.mesh.name = 'TimeWristDial';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;

    this.beadMat = new MeshBasicMaterial({ color: 0xffe9b0, transparent: true, depthWrite: false });
    this.bead = new Mesh(new CircleGeometry(TIME.dialSizeM * 0.035, 16), this.beadMat);
    this.bead.renderOrder = 11;
    this.mesh.add(this.bead);
    this.paint(null, null, null, false);
  }

  /** Repaint the face. Call only when something changed. */
  paint(year: number | null, earlier: number | null, later: number | null, archive: boolean): void {
    const g = this.g;
    if (!g) return;
    const c = PX / 2;
    g.clearRect(0, 0, PX, PX);
    g.beginPath();
    g.arc(c, c, c - 6, 0, Math.PI * 2);
    g.fillStyle = 'rgba(12, 14, 22, 0.88)';
    g.fill();
    g.lineWidth = 5;
    g.strokeStyle = archive ? '#8cb3ff' : '#ffd173';
    g.stroke();
    g.lineWidth = 3;
    for (let i = 0; i < TICKS; i++) {
      const a = i * TICK_RAD;
      const r0 = c - 22;
      const r1 = c - 10;
      g.beginPath();
      g.moveTo(c + Math.sin(a) * r0, c - Math.cos(a) * r0);
      g.lineTo(c + Math.sin(a) * r1, c - Math.cos(a) * r1);
      g.stroke();
    }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.font = '600 62px system-ui, sans-serif';
    g.fillText(year === null ? '----' : String(year), c, c - 4);
    g.font = '500 22px system-ui, sans-serif';
    g.fillStyle = 'rgba(255, 255, 255, 0.72)';
    if (earlier !== null) g.fillText(`‹ ${earlier}`, c - 48, c + 50);
    if (later !== null) g.fillText(`${later} ›`, c + 48, c + 50);
    if (archive) g.fillText('archive', c, c - 52);
    this.texture.needsUpdate = true;
  }

  hide(): void {
    this.mesh.visible = false;
  }

  /**
   * Per-frame, allocation-free.
   * @param grip     world position of the dial hand
   * @param head     world position of the viewer's head
   * @param held     the dial hand is pinching
   * @param progress twist since the last click as a fraction of one step; positive is later
   */
  update(grip: Vector3, head: Vector3, held: boolean, progress: number): void {
    const mesh = this.mesh;
    mesh.visible = true;
    mesh.position.set(grip.x, grip.y + TIME.dialLiftM, grip.z);
    mesh.lookAt(head);
    const opacity = held ? 1 : 0.85;
    this.face.opacity = opacity;
    this.beadMat.opacity = opacity;
    // Clockwise (as the viewer sees the face) is later. The bead starts at twelve o'clock.
    const a = (held ? progress : 0) * TICK_RAD;
    const r = TIME.dialSizeM * 0.5 - TIME.dialSizeM * 0.062;
    this.bead.position.set(Math.sin(a) * r, Math.cos(a) * r, 0.0005);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.bead.geometry.dispose();
    this.face.dispose();
    this.beadMat.dispose();
    this.texture.dispose();
  }
}
