import { defineComponents } from '@iwsdk/core';
import {
  ArchivePhotoTag,
  DragGrip,
  HoverFx,
  HudTag,
  MapTableTag,
  PanoSphereTag,
  PortalFrameTag,
  TimeLensTag,
} from './track-components.js';

export default defineComponents([
  MapTableTag,
  PanoSphereTag,
  TimeLensTag,
  PortalFrameTag,
  ArchivePhotoTag,
  HudTag,
  HoverFx,
  DragGrip,
]);
