import {
  AlwaysStencilFunc,
  CanvasTexture,
  DoubleSide,
  ExtrudeGeometry,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  ReplaceStencilOp,
  SRGBColorSpace,
  Shape,
  Vector3,
} from '@iwsdk/core';
import { config } from '../config.js';
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

/** Slot names written to `PortalFrameTag.slot`, so systems and tools can tell parts apart. */
export const SLOT = {
  frame: 'frame',
  glass: 'glass',
  enter: 'enter',
  exit: 'exit',
} as const;

function labelTexture(text: string, bg: string, fg: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = Math.round((512 * BUTTON_H_M) / BUTTON_W_M);
  const g = canvas.getContext('2d')!;
  const r = canvas.height / 2;
  g.fillStyle = bg;
  g.beginPath();
  g.roundRect(0, 0, canvas.width, canvas.height, r);
  g.fill();
  g.fillStyle = fg;
  g.font = `600 ${Math.round(canvas.height * 0.42)}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/**
 * The portal's scene objects. The root is what the user grabs; everything else is a child,
 * so moving the root moves the opening, the mask and the buttons together.
 *
 *   root (frame mesh, grabbable)
 *     mask    invisible plane that writes `config.portal.stencilRef` into the stencil buffer
 *     enter   "STEP IN" button
 *     exit    "BACK TO ROOM" button
 *
 * Local axes: +Z is the room side (faces the viewer), the opening is centred on the origin.
 */
export class PortalWindow {
  readonly root: Mesh;
  readonly mask: Mesh;
  readonly enterButton: Mesh;
  readonly exitButton: Mesh;
  /** Updated by `syncPlane()`; read by the crossing detectors. Never reallocated. */
  readonly plane: WindowPlane = {
    origin: new Vector3(),
    normal: new Vector3(0, 0, 1),
    right: new Vector3(1, 0, 0),
    up: new Vector3(0, 1, 0),
    halfWidth: config.portal.windowWidthM / 2,
    halfHeight: config.portal.windowHeightM / 2,
  };

  private readonly disposables: { dispose(): void }[] = [];

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
    const frameMat = new MeshBasicMaterial({ color: 0xc9a36a });
    this.root = new Mesh(frameGeo, frameMat);
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

    const buttonGeo = new PlaneGeometry(BUTTON_W_M, BUTTON_H_M);
    const enterTex = labelTexture('STEP IN', '#2f9e6a', '#ffffff');
    const exitTex = labelTexture('BACK TO ROOM', '#2b2f36', '#ffffff');
    this.enterButton = new Mesh(buttonGeo, new MeshBasicMaterial({ map: enterTex, transparent: true }));
    this.exitButton = new Mesh(buttonGeo, new MeshBasicMaterial({ map: exitTex, transparent: true }));
    this.enterButton.name = 'PortalEnterButton';
    this.exitButton.name = 'PortalExitButton';
    const buttonY = -h / 2 - b - BUTTON_H_M / 2 - 0.04;
    const buttonZ = FRAME_DEPTH_M / 2 + 0.02;
    this.enterButton.position.set(-BUTTON_W_M / 2 - 0.03, buttonY, buttonZ);
    this.exitButton.position.set(BUTTON_W_M / 2 + 0.03, buttonY, buttonZ);
    this.root.add(this.enterButton, this.exitButton);

    this.root.visible = false;
    this.disposables.push(
      frameGeo,
      frameMat,
      maskGeo,
      maskMat,
      buttonGeo,
      enterTex,
      exitTex,
      this.enterButton.material as MeshBasicMaterial,
      this.exitButton.material as MeshBasicMaterial,
    );
  }

  /** Copy the root's world transform into `plane`. Call once per frame while open. */
  syncPlane(): void {
    const m = this.root.matrixWorld;
    (this.plane.origin as Vector3).setFromMatrixPosition(m);
    // Columns of the world matrix are the local axes (the frame is never scaled).
    (this.plane.right as Vector3).setFromMatrixColumn(m, 0).normalize();
    (this.plane.up as Vector3).setFromMatrixColumn(m, 1).normalize();
    (this.plane.normal as Vector3).setFromMatrixColumn(m, 2).normalize();
  }

  /** Hover feedback on a button. */
  setHighlight(obj: Object3D, on: boolean): void {
    obj.scale.setScalar(on ? 1.08 : 1);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
