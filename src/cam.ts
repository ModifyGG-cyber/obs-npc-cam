/**
 * What the buttons do in OBS: put a portrait into the portrait source, show or hide it over the camera, and the one-time setup.
 * Kept free of Foundry globals so it can be tested against a fake OBS.
 */

import type { ObsClient } from './obsClient';
import { ObsError } from './obsClient';

export const MODULE_ID = 'obs-npc-cam';
/** What fills the screen around the picture: black hides the camera completely, transparent lets it show. */
export type Backdrop = 'black' | 'transparent';

export interface CamSettings {
  npcScene: string;
  sourceName: string;
  showName: boolean;
  backdrop: Backdrop;
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
export function portraitCss(name?: string, backdrop: Backdrop = 'black'): string {
  const rules = [
    `html, body { margin: 0 !important; width: 100vw !important; height: 100vh !important; overflow: hidden !important; background: ${backdrop === 'black' ? '#000' : 'transparent'} !important; }`,
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

/** Puts a portrait into the portrait source and turns the source on, over the camera. */
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
    inputSettings: { url: imageUrl(foundryBase, portrait.img), css: portraitCss(shown.name, settings.backdrop), is_local_file: false },
    overlay: true
  });
  await setSourceVisible(client, settings, true);
}

/** Back to your own camera: hides the portrait source, so the camera underneath shows again. */
export async function backToCamera(client: ObsClient, settings: CamSettings): Promise<void> {
  await setSourceVisible(client, settings, false);
}

/** Shows or hides the portrait source in the camera scene (the eye icon in OBS). */
async function setSourceVisible(client: ObsClient, settings: CamSettings, visible: boolean): Promise<void> {
  const item = await exists(client, 'GetSceneItemId', { sceneName: settings.npcScene, sourceName: settings.sourceName });
  if (!item) throw new ObsError(`The scene "${settings.npcScene}" has no source called "${settings.sourceName}". Check both names in the OBS NPC Cam settings, or click "Set up OBS".`);
  await client.request('SetSceneItemEnabled', { sceneName: settings.npcScene, sceneItemId: item['sceneItemId'], sceneItemEnabled: visible });
}


/**
 * Makes sure your camera scene has a Browser source for the portrait on top. Only ever adds things;
 * nothing in OBS is changed or removed. Returns what it did, one line each.
 */
export async function setupObs(client: ObsClient, settings: CamSettings): Promise<string[]> {
  const report: string[] = [];
  const list = await client.request('GetSceneList');
  const scenes = ((list['scenes'] as { sceneName?: string }[] | undefined) ?? []).map(s => s.sceneName ?? '');

  if (!settings.npcScene) throw new ObsError('Set the OBS scene name in the OBS NPC Cam settings first.');
  if (!scenes.includes(settings.npcScene)) {
    throw new ObsError(`OBS has no scene called "${settings.npcScene}". Enter the exact name of the scene with your camera in the settings. Your scenes: ${scenes.join(', ')}.`);
  }
  report.push(`Found the scene "${settings.npcScene}".`);

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
      inputSettings: { url: 'about:blank', css: portraitCss(undefined, settings.backdrop), width, height },
      sceneItemEnabled: false
    });
    report.push(`Created the Browser source "${settings.sourceName}" (${String(width)}x${String(height)}) on top of "${settings.npcScene}", hidden until you click Show on cam.`);
  } else {
    const item = await exists(client, 'GetSceneItemId', { sceneName: settings.npcScene, sourceName: settings.sourceName });
    if (item) report.push(`Found the source "${settings.sourceName}" in "${settings.npcScene}".`);
    else {
      await client.request('CreateSceneItem', { sceneName: settings.npcScene, sourceName: settings.sourceName, sceneItemEnabled: false });
      report.push(`Added the existing source "${settings.sourceName}" to "${settings.npcScene}".`);
    }
  }

  return report;
}
