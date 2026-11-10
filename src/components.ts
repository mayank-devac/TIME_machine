import { defineComponents } from '@iwsdk/core';
import {
  ArchivePhotoTag,
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
]);
