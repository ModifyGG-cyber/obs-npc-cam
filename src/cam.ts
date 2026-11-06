/**
 * What the buttons do in OBS: put a portrait into the NPC source, switch scenes, and the one-time setup.
 * Kept free of Foundry globals so it can be tested against a fake OBS.
 */

import type { ObsClient } from './obsClient';
import { ObsError } from './obsClient';

export const MODULE_ID = 'obs-npc-cam';
export const PORTRAIT_PAGE = `modules/${MODULE_ID}/portrait.html`;

export interface CamSettings {
  npcScene: string;
  sourceName: string;
  cameraScene: string;
  switchScene: boolean;
  showName: boolean;
}

export interface Portrait {
  img: string;
  name?: string;
}

/** The address OBS loads: this module's portrait page with the image and caption in the query. */
export function portraitUrl(foundryBase: string, portrait: Portrait | null, stamp = Date.now()): string {
  const page = new URL(PORTRAIT_PAGE, foundryBase);
  if (portrait) {
    page.searchParams.set('img', new URL(portrait.img, foundryBase).href);
    if (portrait.name) page.searchParams.set('name', portrait.name);
    // A new address every time, so OBS reloads even when the same NPC is shown again.
    page.searchParams.set('t', String(stamp));
  }
  return page.href;
}

const DEFAULT_ART = /(^|\/)icons\/svg\/mystery-man\.svg$/;

/** The actor's portrait, or its token art when the portrait is still Foundry's default silhouette. */
export function pickImage(actorImg: string | null | undefined, tokenImg: string | null | undefined, prefer: 'portrait' | 'token'): string | null {
  const [first, second] = prefer === 'token' ? [tokenImg, actorImg] : [actorImg, tokenImg];
  if (first && !DEFAULT_ART.test(first)) return first;
  if (second && !DEFAULT_ART.test(second)) return second;
  // Only the silhouette (or nothing) is left: show it rather than nothing.
  return first || second || null;
}

async function exists(client: ObsClient, requestType: string, data: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    return await client.request(requestType, data);
  } catch (error) {
    if (error instanceof ObsError) return null;
    throw error;
  }
}

/** Puts a portrait into the NPC source and, if wanted, switches OBS to the NPC scene. */
export async function showPortrait(client: ObsClient, settings: CamSettings, foundryBase: string, portrait: Portrait): Promise<void> {
  const input = await exists(client, 'GetInputSettings', { inputName: settings.sourceName });
  if (!input) throw new ObsError(`OBS has no source called "${settings.sourceName}". Click "Set up OBS" in the OBS NPC Cam settings to create it.`);
  if (input['inputKind'] !== 'browser_source') {
    throw new ObsError(`"${settings.sourceName}" in OBS is not a Browser source. Pick another source name in the OBS NPC Cam settings and click "Set up OBS".`);
  }
  const shown: Portrait = { img: portrait.img };
  if (settings.showName && portrait.name) shown.name = portrait.name;
  await client.request('SetInputSettings', { inputName: settings.sourceName, inputSettings: { url: portraitUrl(foundryBase, shown) }, overlay: true });
  if (settings.switchScene && settings.npcScene) await client.request('SetCurrentProgramScene', { sceneName: settings.npcScene });
}

/** Switches OBS back to the camera scene. */
export async function backToCamera(client: ObsClient, settings: CamSettings): Promise<void> {
  if (!settings.cameraScene) throw new ObsError('Set the camera scene name in the OBS NPC Cam settings first.');
  await client.request('SetCurrentProgramScene', { sceneName: settings.cameraScene });
}

/**
 * Makes sure OBS has the NPC scene with a Browser source for the portrait in it. Only ever adds things;
 * nothing in OBS is changed or removed. Returns what it did, one line each.
 */
export async function setupObs(client: ObsClient, settings: CamSettings, foundryBase: string): Promise<string[]> {
  const report: string[] = [];
  const list = await client.request('GetSceneList');
  const scenes = ((list['scenes'] as { sceneName?: string }[] | undefined) ?? []).map(s => s.sceneName ?? '');

  if (!settings.npcScene) throw new ObsError('Set the NPC scene name in the OBS NPC Cam settings first.');
  if (scenes.includes(settings.npcScene)) report.push(`Found the scene "${settings.npcScene}".`);
  else {
    await client.request('CreateScene', { sceneName: settings.npcScene });
    report.push(`Created the scene "${settings.npcScene}".`);
  }

  const input = await exists(client, 'GetInputSettings', { inputName: settings.sourceName });
  if (input && input['inputKind'] !== 'browser_source') {
    throw new ObsError(`OBS already has a source called "${settings.sourceName}", but it is a ${String(input['inputKind'])}, not a Browser source. Choose another source name in the settings.`);
  }
  if (!input) {
    const video = await client.request('GetVideoSettings');
    const width = Number(video['baseWidth']) || 1920;
    const height = Number(video['baseHeight']) || 1080;
    await client.request('CreateInput', {
      sceneName: settings.npcScene,
      inputName: settings.sourceName,
      inputKind: 'browser_source',
      inputSettings: { url: portraitUrl(foundryBase, null), width, height },
      sceneItemEnabled: true
    });
    report.push(`Created the Browser source "${settings.sourceName}" (${String(width)}x${String(height)}) in "${settings.npcScene}".`);
  } else {
    const item = await exists(client, 'GetSceneItemId', { sceneName: settings.npcScene, sourceName: settings.sourceName });
    if (item) report.push(`Found the source "${settings.sourceName}" in "${settings.npcScene}".`);
    else {
      await client.request('CreateSceneItem', { sceneName: settings.npcScene, sourceName: settings.sourceName, sceneItemEnabled: true });
      report.push(`Added the existing source "${settings.sourceName}" to "${settings.npcScene}".`);
    }
  }

  if (!settings.cameraScene) report.push('No camera scene is set, so "Back to my camera" will not work yet.');
  else if (scenes.includes(settings.cameraScene)) report.push(`Found the camera scene "${settings.cameraScene}".`);
  else report.push(`OBS has no scene called "${settings.cameraScene}". Set your camera scene's exact name in the settings. Your scenes: ${scenes.join(', ')}.`);
  return report;
}
