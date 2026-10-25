/**
 * Shared setup of the oracle test files (one file per topology so Vitest runs them in parallel):
 * a 2,000-element grid scene in groups of 100 and the in-process subject. Test-only module.
 */
import { createLoroEngine } from '@staticflux/document/loro-crdt';
import { gridSceneSnapshot } from '../scene.js';
import { createInProcessSequencingSubject, ORACLE_PEER } from './oracle-subject.js';

/** CI scale (S2 ran 10,000 gestures on 10,000 elements). */
export const ORACLE_GESTURES = 2_000;
export const ORACLE_ELEMENTS = 2_000;
/** Vitest timeout per oracle case (a case is one full replay). */
export const ORACLE_CASE_TIMEOUT_MS = 240_000;

/** A fresh in-process subject over the CI scene. Throws if the scene cannot be built (test setup). */
export function createOracleSubject(): ReturnType<typeof createInProcessSequencingSubject> {
  const engine = createLoroEngine();
  const scene = gridSceneSnapshot(engine, { elements: ORACLE_ELEMENTS }, ORACLE_PEER);
  if (!scene.ok) throw scene.error;
  return createInProcessSequencingSubject({ engine, scene: scene.value });
}
