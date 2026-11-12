import { InputComponent, Quaternion, Vector3, VisibilityState, createSystem } from '@iwsdk/core';
import { TIME } from './constants.js';
import { DialTracker, WheelAccumulator, twistAboutAxis } from './dial.js';
import { clientToNdcX, clientToNdcY, directionBetween, ndcToDirection } from './lens-math.js';
import type { TimeMachine } from './time-machine.js';

type Side = 'left' | 'right';

/**
 * Samples input once per frame and hands it to `TimeMachine.frame()`.
 *
 * In an XR session (headset or the IWER emulator):
 *  - lens direction: from the head to the lens hand's GRIP pose (where the hand or controller
 *    physically is), not its target ray (where it points);
 *  - push-through: hold a pinch, or the trigger, on the lens hand;
 *  - dial: pinch (or hold the trigger) on the other hand and roll the wrist; or flick either
 *    thumbstick left / right.
 * On the flat desktop page:
 *  - lens direction: the view ray through the mouse pointer;
 *  - dial: mouse wheel, or ArrowLeft / ArrowRight, or [ and ];
 *  - push-through: hold Space.
 */
export class TimeLensSystem extends createSystem({}) {
  private tm: TimeMachine | null = null;
  private head!: Vector3;
  private hand!: Vector3;
  private forward!: Vector3;
  private target!: Vector3;
  private dialPos!: Vector3;
  private dialAxis!: Vector3;
  private dialStart!: Quaternion;
  private dialNow!: Quaternion;
  private dial!: DialTracker;
  private wheel!: WheelAccumulator;
  private mouseX = 0;
  private mouseY = 0;
  private mouseSeen = false;
  private rectLeft = 0;
  private rectTop = 0;
  private rectWidth = 0;
  private rectHeight = 0;
  private rectStale = true;

  bind(tm: TimeMachine | null): void {
    this.tm = tm;
  }

  init(): void {
    this.head = new Vector3();
    this.hand = new Vector3();
    this.forward = new Vector3(0, 0, -1);
    this.target = new Vector3(0, 0, -1);
    this.dialPos = new Vector3();
    this.dialAxis = new Vector3(0, 0, -1);
    this.dialStart = new Quaternion();
    this.dialNow = new Quaternion();
    this.dial = new DialTracker(TIME.dialStepRad);
    this.wheel = new WheelAccumulator(TIME.wheelStepPx);

    const onMove = (e: PointerEvent): void => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      this.mouseSeen = true;
    };
    const onWheel = (e: WheelEvent): void => {
      if (this.tm?.machine.isActive) this.wheel.add(e.deltaY);
    };
    const onResize = (): void => {
      this.rectStale = true;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('scroll', onResize, { passive: true });
    this.cleanupFuncs.push(() => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize);
    });
  }

  update(delta: number, time: number): void {
    const tm = this.tm;
    if (!tm) return;
    const active = tm.machine.isActive;
    let pushHeld = false;
    let dialHeld = false;
    let yearDelta = 0;
    let dialGrip: Vector3 | null = null;

    if (this.visibilityState.peek() === VisibilityState.NonImmersive) {
      this.dial.end();
      this.sampleDesktop();
      if (active) {
        const kb = this.input.keyboard;
        pushHeld = kb.getKeyPressed('Space');
        yearDelta = this.wheel.take();
        if (kb.getKeyDown('ArrowLeft') || kb.getKeyDown('BracketLeft')) yearDelta -= 1;
        if (kb.getKeyDown('ArrowRight') || kb.getKeyDown('BracketRight')) yearDelta += 1;
      }
    } else {
      const lensSide = this.sampleXr();
      if (active) {
        const dialSide: Side = lensSide === 'right' ? 'left' : 'right';
        const xr = this.input.xr;
        pushHeld = xr.getSelectState(lensSide).active;
        const dialTracked = xr.getPrimaryInputSource(dialSide) !== undefined;
        dialHeld = dialTracked && xr.getSelectState(dialSide).active;
        yearDelta = this.sampleDial(dialSide, dialHeld) + this.sampleThumbsticks();
        if (dialTracked) {
          this.player.gripSpaces[dialSide].getWorldPosition(this.dialPos);
          dialGrip = this.dialPos;
        }
      } else {
        this.dial.end();
        // Keep the present-year label on the dial hand while the machine is off.
        const dialSide: Side = lensSide === 'right' ? 'left' : 'right';
        if (this.input.xr.getPrimaryInputSource(dialSide) !== undefined) {
          this.player.gripSpaces[dialSide].getWorldPosition(this.dialPos);
          dialGrip = this.dialPos;
        }
      }
    }

    tm.frame(delta, time, this.head, this.target, pushHeld, dialHeld, yearDelta);
    tm.dialFrame(dialGrip, this.head, dialHeld, (this.dial.offset * TIME.dialDirection) / TIME.dialStepRad);
  }

  /** Mouse lens: head is the camera, direction is the view ray through the pointer. */
  private sampleDesktop(): void {
    const cam = this.camera;
    const canvas = this.renderer.domElement;
    if (this.rectStale) {
      const r = canvas.getBoundingClientRect();
      this.rectLeft = r.left;
      this.rectTop = r.top;
      this.rectWidth = r.width;
      this.rectHeight = r.height;
      this.rectStale = r.width === 0; // keep asking until the canvas has a size
    }
    // Until the mouse has moved, the lens sits a little right of and below the view centre.
    const nx = this.mouseSeen ? clientToNdcX(this.mouseX, this.rectLeft, this.rectWidth) : 0.25;
    const ny = this.mouseSeen ? clientToNdcY(this.mouseY, this.rectTop, this.rectHeight) : -0.1;
    this.head.setFromMatrixPosition(cam.matrixWorld);
    ndcToDirection(nx, ny, cam.projectionMatrix.elements, cam.matrixWorld.elements, this.target);
  }

  /** Hand lens. Returns the side that carries the lens this frame. */
  private sampleXr(): Side {
    const player = this.player;
    const xr = this.input.xr;
    player.head.getWorldPosition(this.head);
    player.head.getWorldDirection(this.forward).negate(); // Object3D "direction" is +Z; view is -Z
    let side: Side = TIME.lensHand;
    if (xr.getPrimaryInputSource(side) === undefined) {
      const other: Side = side === 'right' ? 'left' : 'right';
      if (xr.getPrimaryInputSource(other) !== undefined) side = other;
      else {
        // No hand or controller tracked: the lens floats straight ahead.
        this.target.copy(this.forward);
        return side;
      }
    }
    player.gripSpaces[side].getWorldPosition(this.hand);
    directionBetween(this.head, this.hand, this.forward, this.target);
    return side;
  }

  /**
   * Pinch and twist: roll of the dial hand since the pinch began, about the direction it
   * was pointing (its target ray) at that moment.
   */
  private sampleDial(side: Side, held: boolean): number {
    if (!held) {
      this.dial.end();
      return 0;
    }
    const grip = this.player.gripSpaces[side];
    if (!this.dial.isActive) {
      grip.getWorldQuaternion(this.dialStart);
      this.player.raySpaces[side].getWorldDirection(this.dialAxis).negate(); // ray points along -Z
      this.dial.begin(0);
      return 0;
    }
    grip.getWorldQuaternion(this.dialNow);
    const a = this.dialAxis;
    return this.dial.update(twistAboutAxis(this.dialStart, this.dialNow, a.x, a.y, a.z)) * TIME.dialDirection;
  }

  /** Controller fallback: a flick of either thumbstick. Left is earlier, right is later. */
  private sampleThumbsticks(): number {
    const pads = this.input.xr.gamepads;
    let d = 0;
    const l = pads.left;
    const r = pads.right;
    if (l) {
      if (l.getAxesEnteringLeft(InputComponent.Thumbstick)) d -= 1;
      if (l.getAxesEnteringRight(InputComponent.Thumbstick)) d += 1;
    }
    if (r) {
      if (r.getAxesEnteringLeft(InputComponent.Thumbstick)) d -= 1;
      if (r.getAxesEnteringRight(InputComponent.Thumbstick)) d += 1;
    }
    return d;
  }
}
