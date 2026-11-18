/**
 * The table map's MapLibre style: a raster base map for the chosen kind, plus the Mapillary
 * panorama coverage, extruded buildings, curated spots and the pick marker, coloured from the
 * current theme tokens. Builds plain style objects only; the table applies them.
 */

import type { LayerSpecification, StyleSpecification } from "maplibre-gl";
import type { BaseMapKind } from "../prefs.js";
import { currentTokens, mix, opaque } from "../theme.js";

export const MAPILLARY_TILES =
  "https://tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}";
/** The coverage lines a tap snaps to. */
export const COVERAGE_LAYER = "mly-pano-sequences";
export const BUILDINGS_LAYER = "tm-buildings";
export const SPOTS_SOURCE = "tm-spots";
export const PICK_SOURCE = "tm-pick";

/** Rim credit line; names the imagery provider only when satellite imagery is showing. */
export function mapCredit(kind: BaseMapKind, buildings3d = false): string {
  const base =
    kind === "satellite"
      ? "Imagery © Esri, Maxar, Earthstar Geographics"
      : "Map © Esri, HERE, Garmin, OpenStreetMap contributors";
  const bld = buildings3d
    ? "  ·  Buildings © OpenStreetMap contributors, OpenFreeMap"
    : "";
  return `${base}${bld}  ·  Coverage © Mapillary`;
}

export interface SpotsData {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: { name: string };
    geometry: { type: "Point"; coordinates: number[] };
  }>;
}

export interface OverlayOptions {
  /** Mapillary token; without one there is no coverage layer. */
  token: string | undefined;
  buildings3d: boolean;
  spots: SpotsData;
}

/**
 * Base maps are plain raster tile layers. MapLibre only composes them with the Mapillary
 * coverage; no vector basemap is used because OpenFreeMap's ~400 KB vector tiles stalled in the
 * managed browser, leaving the table with no roads or water. Rasters are small and always load.
 */
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const esriTiles = (service: string): string[] => [
  `${ESRI}/${service}/MapServer/tile/{z}/{y}/{x}`,
];

function buildBaseStyle(kind: BaseMapKind): StyleSpecification {
  const sources: StyleSpecification["sources"] = {};
  const layers: LayerSpecification[] = [
    {
      id: "background",
      type: "background",
      paint: { "background-color": opaque(currentTokens().background) },
    },
  ];
  const raster = (
    id: string,
    service: string,
    maxzoom: number,
    attribution?: string,
  ): void => {
    sources[id] = {
      type: "raster",
      tiles: esriTiles(service),
      tileSize: 256,
      maxzoom,
      attribution,
    };
    layers.push({ id, type: "raster", source: id });
  };
  if (kind === "satellite") {
    raster(
      "base",
      "World_Imagery",
      19,
      "Imagery © Esri, Maxar, Earthstar Geographics",
    );
    raster("base-labels", "Reference/World_Boundaries_and_Places", 19);
  } else if (kind === "dark") {
    raster(
      "base",
      "Canvas/World_Dark_Gray_Base",
      16,
      "Map © Esri, HERE, Garmin, OpenStreetMap contributors",
    );
    raster("base-labels", "Canvas/World_Dark_Gray_Reference", 16);
  } else {
    raster(
      "base",
      "World_Street_Map",
      19,
      "Map © Esri, HERE, Garmin, OpenStreetMap contributors",
    );
  }
  return {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources,
    layers,
  };
}

/**
 * The full style: base map, with the coverage and buildings below the first label layer, and
 * spot and pick markers on top.
 */
export function buildMapStyle(
  kind: BaseMapKind,
  { token, buildings3d, spots }: OverlayOptions,
): StyleSpecification {
  const style = buildBaseStyle(kind);
  const t = currentTokens();
  // Over satellite imagery the buildings take the dark surface; on a drawn map, a tone
  // between the panel surface and its border so they read as raised blocks.
  const buildingColour = mix(t.surface, t.border, 0.5);
  const sources = style.sources;
  const layers = style.layers;
  const firstSymbol = layers.findIndex((l) => l.type === "symbol");
  const insertAt = firstSymbol < 0 ? layers.length : firstSymbol;
  if (token) {
    sources.mapillary = {
      type: "vector",
      tiles: [`${MAPILLARY_TILES}?access_token=${token}`],
      minzoom: 6,
      maxzoom: 14,
      attribution: "© Mapillary",
    };
    layers.splice(insertAt, 0, {
      id: COVERAGE_LAYER,
      type: "line",
      source: "mapillary",
      "source-layer": "sequence",
      filter: ["==", ["get", "is_pano"], true],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": t.success,
        "line-opacity": 0.9,
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          12,
          2.5,
          15,
          5,
          18,
          9,
        ],
      },
    });
  }
  // 3D buildings: OpenFreeMap vector tiles (OpenStreetMap data), extruded. The source is only
  // requested while the layer is visible, so flat mode costs nothing extra.
  sources[BUILDINGS_LAYER] = {
    type: "vector",
    url: "https://tiles.openfreemap.org/planet",
    attribution: "© OpenStreetMap contributors, OpenFreeMap",
  };
  layers.splice(insertAt, 0, {
    id: BUILDINGS_LAYER,
    type: "fill-extrusion",
    source: BUILDINGS_LAYER,
    "source-layer": "building",
    minzoom: 14,
    layout: { visibility: buildings3d ? "visible" : "none" },
    paint: {
      "fill-extrusion-color": buildingColour,
      "fill-extrusion-height": ["coalesce", ["get", "render_height"], 6],
      "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
      "fill-extrusion-opacity": 0.88,
      "fill-extrusion-vertical-gradient": true,
    },
  });
  sources[SPOTS_SOURCE] = { type: "geojson", data: spots };
  sources[PICK_SOURCE] = {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  };
  layers.push(
    {
      id: SPOTS_SOURCE,
      type: "circle",
      source: SPOTS_SOURCE,
      paint: {
        "circle-radius": 14,
        "circle-color": t.accent,
        "circle-stroke-color": t.onAccent,
        "circle-stroke-width": 4,
      },
    },
    {
      id: "tm-spots-label",
      type: "symbol",
      source: SPOTS_SOURCE,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Bold"],
        "text-size": 30,
        "text-offset": [0, 1.2],
        "text-anchor": "top",
      },
      paint: {
        "text-color": t.textPrimary,
        "text-halo-color": opaque(t.background),
        "text-halo-width": 3,
      },
    },
    {
      id: PICK_SOURCE,
      type: "circle",
      source: PICK_SOURCE,
      paint: {
        "circle-radius": 18,
        "circle-opacity": 0,
        "circle-stroke-color": t.accent,
        "circle-stroke-width": 6,
      },
    },
  );
  return style;
}
