import { AssetType, defineAssets } from '@iwsdk/core';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

const uikitml = (fileName: string, name: string) => ({
  url: publicAssetUrl(`ui/${fileName}`),
  type: AssetType.UIKitML,
  name,
});

// Track G owns the files in public/ui/. One id per HUD panel (see `src/ui/README.md`).
export default defineAssets({
  'hud-street-bar': uikitml('street-bar.uikitml', 'Street Bar'),
  'hud-places': uikitml('places.uikitml', 'Places'),
  'hud-search': uikitml('search.uikitml', 'Search'),
  'hud-settings': uikitml('settings.uikitml', 'Settings'),
  'hud-credits': uikitml('credits.uikitml', 'Credits'),
  'hud-status': uikitml('status.uikitml', 'Status'),
});
