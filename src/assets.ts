import { AssetType, defineAssets } from '@iwsdk/core';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

const uikitml = (fileName: string, name: string) => ({
  url: publicAssetUrl(`ui/${fileName}`),
  type: AssetType.UIKitML,
  name,
});

// Track G owns the files in public/ui/. The ids below are fixed in Phase 0.
export default defineAssets({
  'hud-time-button': uikitml('time-button.uikitml', 'Time Machine Button'),
  'hud-year-label': uikitml('year-label.uikitml', 'Year Label'),
  'hud-credits': uikitml('credits.uikitml', 'Credits'),
  'hud-status': uikitml('status.uikitml', 'Status'),
  'hud-portal-button': uikitml('portal-button.uikitml', 'Portal Button'),
  'hud-year-list': uikitml('year-list.uikitml', 'Year List'),
  'hud-info-button': uikitml('info-button.uikitml', 'Info Button'),
  'hud-places': uikitml('places.uikitml', 'Places'),
  'hud-map-button': uikitml('map-button.uikitml', 'Map Button'),
});
