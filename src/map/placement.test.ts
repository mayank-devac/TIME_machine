import { describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { DEFAULT_TABLE_POSE, TABLE_DISTANCE_M, tableHeightFor, tablePoseFor } from './placement.js';

describe('tableHeightFor', () => {
  it('keeps the standing height for a 1.6 m eye line', () => {
    expect(tableHeightFor(1.6)).toBeCloseTo(0.85);
  });
  it('lowers the table for a seated viewer, within limits', () => {
    expect(tableHeightFor(1.2)).toBeCloseTo(0.6);
    expect(tableHeightFor(1.45)).toBeCloseTo(0.7);
    expect(tableHeightFor(2.2)).toBeCloseTo(1.1);
  });
  it('falls back to the configured height when the eye height is missing or implausible', () => {
    expect(tableHeightFor(0)).toBe(config.map.tableHeightM);
    expect(tableHeightFor(Number.NaN)).toBe(config.map.tableHeightM);
  });
});

describe('tablePoseFor', () => {
  it('a standing viewer at the origin facing north gets the default pose', () => {
    const pose = tablePoseFor({ x: 0, y: 1.6, z: 0 }, { x: 0, y: -0.3, z: -1 });
    expect(pose.yaw).toBeCloseTo(DEFAULT_TABLE_POSE.yaw);
    expect(pose.position.x).toBeCloseTo(DEFAULT_TABLE_POSE.position.x);
    expect(pose.position.y).toBeCloseTo(DEFAULT_TABLE_POSE.position.y);
    expect(pose.position.z).toBeCloseTo(DEFAULT_TABLE_POSE.position.z);
  });
  it('follows the heading and the seat height', () => {
    const pose = tablePoseFor({ x: 1, y: 1.2, z: 2 }, { x: -1, y: 0, z: 0 }); // facing -X
    expect(pose.yaw).toBeCloseTo(Math.PI / 2);
    expect(pose.position.x).toBeCloseTo(1 - TABLE_DISTANCE_M);
    expect(pose.position.y).toBeCloseTo(0.6);
    expect(pose.position.z).toBeCloseTo(2);
  });
  it('looking straight down still opens the table to the north', () => {
    const pose = tablePoseFor({ x: 0, y: 1.6, z: 0 }, { x: 0, y: -1, z: 0 });
    expect(pose.yaw).toBe(0);
    expect(pose.position.z).toBeCloseTo(-TABLE_DISTANCE_M);
  });
});
