/**
 * What the buttons do in OBS: put a portrait into the NPC source, switch scenes, and the one-time setup.
 * Kept free of Foundry globals so it can be tested against a fake OBS.
 */

import type { ObsClient } from './obsClient';
import { ObsError } from './obsClient';

export const MODULE_ID = 'obs-npc-cam';
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

/**
 * The address OBS loads: the image itself, served by Foundry. A new address every time, so OBS reloads
 * (and the fade plays) even when the same NPC is shown again.
 */
export function imageUrl(foundryBase: string, img: string, stamp = Date.now()): string {
  const url = new URL(img, foundryBase);
  url.searchParams.set('npc-cam', String(stamp));
  return url.href;
}

const cssString = (text: string): string => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;

/**
 * The Browser source's custom CSS: fits the image to the canvas on a transparent background, fades it in,
 * and draws the caption. The browser shows a bare image on a dark page by default; this overrides that.
 */
export function portraitCss(name?: string): string {
  const rules = [
    'html, body { margin: 0 !important; width: 100vw !important; height: 100vh !important; overflow: hidden !important; background: transparent !important; }',
    'img { position: fixed !important; inset: 0 !important; margin: 0 !important; width: 100vw !important; height: 100vh !important; object-fit: contain !important; background: transparent !important; cursor: default !important; animation: npc-cam-fade 0.6s ease both; }',
    '@keyframes npc-cam-fade { from { opacity: 0; } to { opacity: 1; } }'
  ];
  if (name) {
    rules.push(
      `body::after { content: ${cssString(name)}; position: fixed; left: 50%; bottom: 4vh; transform: translateX(-50%); padding: 0.4em 1.2em; font: 600 5vh/1.2 Georgia, "Times New Roman", serif; color: #f4ecd8; background: rgba(0, 0, 0, 0.6); border-radius: 0.3em; text-shadow: 0 2px 6px #000; white-space: nowrap; animation: npc-cam-fade 0.6s ease 0.2s both; }`
    );
  }
  return rules.join('\n');
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
  await client.request('SetInputSettings', {
    inputName: settings.sourceName,
    inputSettings: { url: imageUrl(foundryBase, portrait.img), css: portraitCss(shown.name), is_local_file: false },
    overlay: true
  });
  if (settings.switchScene && settings.npcScene) await switchScene(client, settings.npcScene);
}

/** Switches OBS back to the camera scene. */
export async function backToCamera(client: ObsClient, settings: CamSettings): Promise<void> {
  if (!settings.cameraScene) throw new ObsError('Set the camera scene name in the OBS NPC Cam settings first.');
  await switchScene(client, settings.cameraScene);
}

/** Switches the live output. In Studio Mode the preview follows too, so what you look at matches what goes out. */
async function switchScene(client: ObsClient, sceneName: string): Promise<void> {
  await client.request('SetCurrentProgramScene', { sceneName });
  const studio = await exists(client, 'GetStudioModeEnabled', {});
  if (studio?.['studioModeEnabled'] === true) await client.request('SetCurrentPreviewScene', { sceneName });
}

/**
 * Makes sure OBS has the NPC scene with a Browser source for the portrait in it. Only ever adds things;
 * nothing in OBS is changed or removed. Returns what it did, one line each.
 */
export async function setupObs(client: ObsClient, settings: CamSettings): Promise<string[]> {
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
      inputSettings: { url: 'about:blank', css: portraitCss(), width, height },
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
