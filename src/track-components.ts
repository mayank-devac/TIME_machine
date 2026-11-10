import { Types, createComponent } from '@iwsdk/core';

/**
 * Marker components, pre-registered in Phase 0 so tracks never edit `components.ts`.
 * Each track tags its entities with its own marker and keeps real state in its own classes.
 * Need more fields? Report it to the orchestrator.
 */
const marker = (name: string) =>
  createComponent(name, {
    slot: { type: Types.String, default: '' },
    value: { type: Types.Float32, default: 0 },
  });

export const MapTableTag = marker('MapTableTag');
export const PanoSphereTag = marker('PanoSphereTag');
export const TimeLensTag = marker('TimeLensTag');
export const PortalFrameTag = marker('PortalFrameTag');
export const ArchivePhotoTag = marker('ArchivePhotoTag');
export const HudTag = marker('HudTag');
