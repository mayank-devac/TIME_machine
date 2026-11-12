import {
  AlwaysStencilFunc,
  BoxGeometry,
  CanvasTexture,
  DoubleSide,
  ExtrudeGeometry,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  ReplaceStencilOp,
  SRGBColorSpace,
  Shape,
  Vector3,
} from '@iwsdk/core';
import { config } from '../config.js';
import { HOVER_OUTLINE_NAME, setHoverTint } from '../hover.js';
import { currentTokens, hexNumber, onThemeChange } from '../theme.js';
import type { Tokens } from '../theme.js';
import type { WindowPlane } from './portal-logic.js';

/**
 * Below the stage sphere (-1000) so the mask writes the stencil before the sphere tests it.
 * Three sorts opaque objects by `renderOrder` first.
 */
export const MASK_RENDER_ORDER = -2000;

const FRAME_BORDER_M = 0.07;
const FRAME_DEPTH_M = 0.06;
const BUTTON_W_M = 0.36;
const BUTTON_H_M = 0.11;
const HANDLE_M = 0.1;
/** The hover outline is a slightly larger pill behind a button. */
const OUTLINE_GROW = 1.1;

/** Slot names written to `PortalFrameTag.slot`, so systems and tools can tell parts apart. */
export const SLOT = {
  frame: 'frame',
  glass: 'glass',
  enter: 'enter',
  exit: 'exit',
  resize: 'resize',
} as const;

function pillCanvas(): { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D; r: number } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = Math.round((512 * BUTTON_H_M) / BUTTON_W_M);
  return { canvas, g: canvas.getContext('2d')!, r: canvas.height / 2 };
}

/** A pill button face: fill, hairline, centred label. */
function drawLabel(canvas: HTMLCanvasElement, text: string, fill: string, ink: string, line: string): void {
  const g = canvas.getContext('2d')!;
  const r = canvas.height / 2;
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = fill;
  g.beginPath();
  g.roundRect(0, 0, canvas.width, canvas.height, r);
  g.fill();
  g.strokeStyle = line;
  g.lineWidth = 4;
  g.beginPath();
  g.roundRect(2, 2, canvas.width - 4, canvas.height - 4, r);
  g.stroke();
  g.fillStyle = ink;
  g.font = `500 ${Math.round(canvas.height * 0.4)}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
}

/** The hover outline: an empty pill with a ring in the `hover` colour. */
function drawOutline(canvas: HTMLCanvasElement, colour: string): void {
  const g = canvas.getContext('2d')!;
  const w = 10;
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.strokeStyle = colour;
  g.lineWidth = w;
  g.beginPath();
  g.roundRect(w / 2, w / 2, canvas.width - w, canvas.height - w, canvas.height / 2 - w / 2);
  g.stroke();
}

function texture(canvas: HTMLCanvasElement): CanvasTexture {
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/**
 * The portal's scene objects. The root is what the user grabs; everything else is a child,
 * so moving or scaling the root moves the opening, the mask and the buttons together.
 *
 *   root (frame mesh, grabbable)
 *     mask    invisible plane that writes `config.portal.stencilRef` into the stencil buffer.
 *             A press on it bubbles to the frame, so dragging the glass moves the window.
 *     enter   "STEP IN" button
 *     exit    "MAP" button (back to the room and its map table)
 *     handle  corner block; dragging it resizes the window (uniform scale of the root)
 *
 * Local axes: +Z is the room side (faces the viewer), the opening is centred on the origin.
 * All colours come from the theme and are redrawn when it changes.
 */
export class PortalWindow {
  readonly root: Mesh;
  readonly mask: Mesh;
  readonly enterButton: Mesh;
  readonly exitButton: Mesh;
  readonly handle: Mesh;
  /** Where the resize handle rests, in the root's local space (the bottom-right corner). */
  readonly handleRest = new Vector3();
  /** Updated by `syncPlane()`; read by the crossing detectors. Never reallocated. */
  readonly plane: WindowPlane = {
    origin: new Vector3(),
    normal: new Vector3(0, 0, 1),
    right: new Vector3(1, 0, 0),
    up: new Vector3(0, 1, 0),
    halfWidth: config.portal.windowWidthM / 2,
    halfHeight: config.portal.windowHeightM / 2,
  };

  private readonly frameMaterial: MeshBasicMaterial;
  private readonly handleMaterial: MeshBasicMaterial;
  private readonly enterCanvas: HTMLCanvasElement;
  private readonly exitCanvas: HTMLCanvasElement;
  private readonly outlineCanvas: HTMLCanvasElement;
  private readonly textures: CanvasTexture[];
  private readonly disposables: { dispose(): void }[] = [];
  private readonly offTheme: () => void;

  constructor() {
    const w = config.portal.windowWidthM;
    const h = config.portal.windowHeightM;
    const b = FRAME_BORDER_M;

    // Frame: one extruded rectangle with a rectangular hole, so one draw call.
    const outer = new Shape();
    outer.moveTo(-w / 2 - b, -h / 2 - b);
    outer.lineTo(w / 2 + b, -h / 2 - b);
    outer.lineTo(w / 2 + b, h / 2 + b);
    outer.lineTo(-w / 2 - b, h / 2 + b);
    outer.closePath();
    const hole = new Shape();
    hole.moveTo(-w / 2, -h / 2);
    hole.lineTo(-w / 2, h / 2);
    hole.lineTo(w / 2, h / 2);
    hole.lineTo(w / 2, -h / 2);
    hole.closePath();
    outer.holes.push(hole);
    const frameGeo = new ExtrudeGeometry(outer, {
      depth: FRAME_DEPTH_M,
      bevelEnabled: true,
      bevelThickness: 0.01,
      bevelSize: 0.01,
      bevelSegments: 2,
    });
    frameGeo.translate(0, 0, -FRAME_DEPTH_M / 2);
    this.frameMaterial = new MeshBasicMaterial();
    this.root = new Mesh(frameGeo, this.frameMaterial);
    this.root.name = 'PortalFrame';

    // Stencil mask: writes the ref wherever the opening covers a pixel; draws no colour
    // and no depth, so it is invisible and does not hide the sphere behind it.
    const maskGeo = new PlaneGeometry(w, h);
    const maskMat = new MeshBasicMaterial({
      side: DoubleSide,
      colorWrite: false,
      depthWrite: false,
      stencilWrite: true,
      stencilRef: config.portal.stencilRef,
      stencilFunc: AlwaysStencilFunc,
      stencilZPass: ReplaceStencilOp,
    });
    this.mask = new Mesh(maskGeo, maskMat);
    this.mask.name = 'PortalGlass';
    this.mask.renderOrder = MASK_RENDER_ORDER;
    this.root.add(this.mask);

    // Buttons: canvas-drawn pills, each with a hover outline pill behind it.
    this.enterCanvas = pillCanvas().canvas;
    this.exitCanvas = pillCanvas().canvas;
    this.outlineCanvas = pillCanvas().canvas;
    const enterTex = texture(this.enterCanvas);
    const exitTex = texture(this.exitCanvas);
    const outlineTex = texture(this.outlineCanvas);
    this.textures = [enterTex, exitTex, outlineTex];
    const buttonGeo = new PlaneGeometry(BUTTON_W_M, BUTTON_H_M);
    const outlineGeo = new PlaneGeometry(BUTTON_W_M * OUTLINE_GROW, BUTTON_H_M * OUTLINE_GROW * 1.15);
    const outlineMat = new MeshBasicMaterial({ map: outlineTex, transparent: true, depthWrite: false });
    const button = (name: string, tex: CanvasTexture): Mesh => {
      const mat = new MeshBasicMaterial({ map: tex, transparent: true });
      const mesh = new Mesh(buttonGeo, mat);
      mesh.name = name;
      const outline = new Mesh(outlineGeo, outlineMat);
      outline.name = HOVER_OUTLINE_NAME;
      outline.position.z = -0.002;
      outline.visible = false;
      outline.raycast = () => {}; // decoration only; the button itself takes the ray
      mesh.add(outline);
      this.disposables.push(mat);
      return mesh;
    };
    this.enterButton = button('PortalEnterButton', enterTex);
    this.exitButton = button('PortalExitButton', exitTex);
    const buttonY = -h / 2 - b - BUTTON_H_M / 2 - 0.04;
    const buttonZ = FRAME_DEPTH_M / 2 + 0.02;
    this.enterButton.position.set(-BUTTON_W_M / 2 - 0.03, buttonY, buttonZ);
    this.exitButton.position.set(BUTTON_W_M / 2 + 0.03, buttonY, buttonZ);
    this.root.add(this.enterButton, this.exitButton);

    // Resize handle: a block on the bottom-right corner of the frame.
    const handleGeo = new BoxGeometry(HANDLE_M, HANDLE_M, FRAME_DEPTH_M + 0.02);
    this.handleMaterial = new MeshBasicMaterial();
    this.handle = new Mesh(handleGeo, this.handleMaterial);
    this.handle.name = 'PortalResizeHandle';
    this.handleRest.set(w / 2 + b, -h / 2 - b, 0.01);
    this.handle.position.copy(this.handleRest);
    setHoverTint(this.handle, [this.handleMaterial], 'textSecondary');
    this.root.add(this.handle);

    this.root.visible = false;
    this.disposables.push(
      frameGeo,
      this.frameMaterial,
      maskGeo,
      maskMat,
      buttonGeo,
      outlineGeo,
      outlineMat,
      handleGeo,
      this.handleMaterial,
      ...this.textures,
    );

    this.applyTheme(currentTokens());
    this.offTheme = onThemeChange((t) => this.applyTheme(t));
  }

  /** Recolour the frame, the handle and the button faces. */
  private applyTheme(t: Readonly<Tokens>): void {
    this.frameMaterial.color.setHex(hexNumber(t.border));
    setHoverTint(this.handle, [this.handleMaterial], 'textSecondary');
    drawLabel(this.enterCanvas, 'STEP IN', t.accent, t.onAccent, t.accent);
    drawLabel(this.exitCanvas, 'MAP', t.surface, t.textPrimary, t.border);
    drawOutline(this.outlineCanvas, t.hover);
    for (const tex of this.textures) tex.needsUpdate = true;
  }

  /** Current uniform scale of the window (1 = `config.portal.window*M`). */
  get scale(): number {
    return this.root.scale.x;
  }

  /** Resize the whole window. The caller clamps; the handle goes back onto its corner. */
  setScale(scale: number): void {
    this.root.scale.setScalar(scale);
    this.root.updateMatrixWorld(true);
  }

  /** Put the resize handle back on the corner (after a drag ends). */
  restHandle(): void {
    this.handle.position.copy(this.handleRest);
  }

  /** Copy the root's world transform and size into `plane`. Call once per frame while open. */
  syncPlane(): void {
    const m = this.root.matrixWorld;
    (this.plane.origin as Vector3).setFromMatrixPosition(m);
    // Columns of the world matrix are the local axes; normalising drops the window's scale,
    // which goes into the half extents instead.
    (this.plane.right as Vector3).setFromMatrixColumn(m, 0).normalize();
    (this.plane.up as Vector3).setFromMatrixColumn(m, 1).normalize();
    (this.plane.normal as Vector3).setFromMatrixColumn(m, 2).normalize();
    this.plane.halfWidth = (config.portal.windowWidthM / 2) * this.root.scale.x;
    this.plane.halfHeight = (config.portal.windowHeightM / 2) * this.root.scale.y;
  }

  dispose(): void {
    this.offTheme();
    for (const d of this.disposables) d.dispose();
  }
}
