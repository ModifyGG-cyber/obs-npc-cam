/**
 * OBS NPC Cam: show an NPC's portrait in OBS with one click, from a token's HUD, an actor's sheet,
 * the Actors list or a keybinding, over your camera in OBS, and hide it again to go back to your camera.
 *
 * Talks straight to OBS's built-in remote control (Tools > WebSocket Server Settings) from the GM's browser.
 * Macro API:
 *   const cam = game.modules.get('obs-npc-cam').api;
 *   await cam.show(actorOrToken);            // or cam.show({ img: 'path/to/image.webp', name: 'Caption' })
 *   await cam.showSelected();
 *   await cam.camera();
 *
 * Hooks for other modules: 'obsNpcCam.show' (portrait { img, name }, subject) after a portrait is shown,
 * and 'obsNpcCam.camera' after going back to the camera.
 */

import { MODULE_ID, backToCamera, pickImage, setupObs, showPortrait, type CamSettings, type Portrait } from './cam';
import { ObsClient, type SocketLike } from './obsClient';

interface TokenDocLike {
  name?: string;
  texture?: { src?: string | null };
  actor?: ActorLike | null;
}
interface ActorLike {
  documentName?: string;
  name?: string;
  img?: string | null;
  prototypeToken?: { name?: string; texture?: { src?: string | null } };
}
interface TokenLike {
  document?: TokenDocLike;
  actor?: ActorLike | null;
}
interface Notifications {
  error(msg: string): void;
  warn(msg: string): void;
  info(msg: string): void;
}
interface Globals {
  game: {
    settings: {
      register(module: string, key: string, data: Record<string, unknown>): void;
      registerMenu(module: string, key: string, data: Record<string, unknown>): void;
      get(module: string, key: string): unknown;
    };
    keybindings?: { register(module: string, key: string, data: Record<string, unknown>): void };
    user?: { isGM?: boolean } | null;
    actors?: { get(id: string): ActorLike | undefined };
    modules: { get(id: string): { api?: Record<string, unknown> } | undefined };
  };
  canvas?: { tokens?: { controlled?: TokenLike[] } } | null;
  Hooks: {
    on(hook: string, fn: (...args: unknown[]) => unknown): number;
    once(hook: string, fn: (...args: unknown[]) => unknown): number;
    callAll?(hook: string, ...args: unknown[]): boolean;
  };
  ui: { notifications?: Notifications };
  foundry?: {
    utils?: { getRoute?(path: string): string };
    applications?: { api?: { DialogV2?: { prompt(options: Record<string, unknown>): Promise<unknown> } } };
  };
  WebSocket: new (url: string) => unknown;
}

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev';
const g = (): Globals => globalThis as unknown as Globals;
const isGM = (): boolean => g().game.user?.isGM === true;
const setting = (key: string): unknown => g().game.settings.get(MODULE_ID, key);
const text = (key: string): string => {
  const value = setting(key);
  return typeof value === 'string' ? value.trim() : '';
};
const client = new ObsClient(url => new (g().WebSocket)(url) as SocketLike);

function camSettings(): CamSettings {
  return {
    npcScene: text('npcScene'),
    sourceName: text('sourceName'),
    cameraSource: text('cameraSource'),
    showName: setting('showName') === true
  };
}

function foundryBase(): string {
  const route = g().foundry?.utils?.getRoute?.('/') ?? '/';
  return new URL(route, window.location.origin).href;
}

async function connected(): Promise<ObsClient> {
  await client.connect({ host: text('host') || 'localhost', port: Number(setting('port')) || 4455, password: typeof setting('password') === 'string' ? (setting('password') as string) : '' });
  return client;
}

function report(error: unknown): void {
  g().ui.notifications?.error(`OBS NPC Cam: ${error instanceof Error ? error.message : String(error)}`);
}

/** Works out the image and caption for a token, an actor, or a plain { img, name }. */
function portraitOf(subject: unknown): Portrait | null {
  const prefer = setting('imageChoice') === 'token' ? 'token' : 'portrait';
  const s = subject as (TokenLike & TokenDocLike & ActorLike & { img?: string | null }) | null | undefined;
  if (!s) return null;
  const tokenDoc: TokenDocLike | undefined = s.document ?? (s.texture && s.actor !== undefined ? s : undefined);
  if (tokenDoc) {
    const actor = tokenDoc.actor ?? s.actor ?? null;
    const img = pickImage(actor?.img, tokenDoc.texture?.src, prefer);
    if (!img) return null;
    const name = tokenDoc.name ?? actor?.name;
    return name ? { img, name } : { img };
  }
  if (s.documentName === 'Actor' || s.prototypeToken) {
    const img = pickImage(s.img, s.prototypeToken?.texture?.src, prefer);
    if (!img) return null;
    const name = s.prototypeToken?.name || s.name;
    return name ? { img, name } : { img };
  }
  if (typeof s.img === 'string' && s.img) return s.name ? { img: s.img, name: s.name } : { img: s.img };
  return null;
}

async function show(subject: unknown): Promise<void> {
  const portrait = portraitOf(subject);
  if (!portrait) throw new Error('That has no image to show.');
  const settings = camSettings();
  await showPortrait(await connected(), settings, foundryBase(), portrait);
  // Lets other modules follow along (Discord Speaking Portraits speaks as whoever is on cam).
  g().Hooks.callAll?.('obsNpcCam.show', portrait, subject);
}

async function showSelected(): Promise<void> {
  const token = g().canvas?.tokens?.controlled?.[0];
  if (!token) throw new Error('Select an NPC token first.');
  await show(token);
}

async function camera(): Promise<void> {
  const settings = camSettings();
  await backToCamera(await connected(), settings);
  g().Hooks.callAll?.('obsNpcCam.camera');
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

async function setup(): Promise<string[]> {
  const lines = await setupObs(await connected(), camSettings());
  const dialog = g().foundry?.applications?.api?.DialogV2;
  const content = `<ul>${lines.map(line => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`;
  if (dialog) await dialog.prompt({ window: { title: 'OBS NPC Cam setup' }, content, ok: { label: 'OK' } });
  else g().ui.notifications?.info(lines.join(' '));
  return lines;
}

const run = (action: () => Promise<unknown>): void => {
  void action().catch(report);
};

type AppClass = new (...args: unknown[]) => { render(...args: unknown[]): unknown };

/**
 * The settings button. Foundry only accepts an Application class here and opens it with `new type().render()`,
 * so this subclass runs the setup instead of drawing a window.
 */
function setupRunnerClass(): AppClass | null {
  const Base = (g().foundry?.applications?.api as { ApplicationV2?: AppClass } | undefined)?.ApplicationV2;
  if (!Base) return null;
  return class SetupRunner extends Base {
    override render(): Promise<this> {
      run(setup);
      return Promise.resolve(this);
    }
  };
}

const SHOW_LABEL = 'Show on cam';
const SHOW_ICON = 'fa-solid fa-user-secret';
const CAMERA_ICON = 'fa-solid fa-video';

g().Hooks.once('init', () => {
  console.log(`OBS NPC Cam | version ${VERSION}`);
  const { settings } = g().game;
  const reconnect = (): void => {
    client.disconnect();
  };
  const textSetting = (key: string, name: string, hint: string, fallback: string, onChange?: () => void): void => {
    settings.register(MODULE_ID, key, { name, hint, scope: 'client', config: true, type: String, default: fallback, ...(onChange ? { onChange } : {}) });
  };
  textSetting('host', 'OBS address', 'Where OBS runs. Leave as localhost when OBS is on this computer.', 'localhost', reconnect);
  settings.register(MODULE_ID, 'port', {
    name: 'OBS port',
    hint: 'OBS: Tools > WebSocket Server Settings > Server Port (normally 4455).',
    scope: 'client',
    config: true,
    type: Number,
    default: 4455,
    onChange: reconnect
  });
  textSetting('password', 'OBS password', 'OBS: Tools > WebSocket Server Settings > Show Connect Info > Server Password. Stored only in this browser.', '', reconnect);
  textSetting('npcScene', 'OBS scene', 'The exact name of the OBS scene with your camera. The portrait sits on top of the camera in this scene.', 'Camera');
  textSetting('sourceName', 'Portrait source', 'The OBS Browser source that shows the portrait. "Set up OBS" creates it. Show on cam turns it on, Back to my camera turns it off (the eye icon in OBS).', 'NPC Portrait');
  textSetting('cameraSource', 'Camera source', 'Your webcam source in the same scene. It is hidden while an NPC is shown and comes back with Back to my camera. Leave empty to never touch it.', 'Camera');
  settings.register(MODULE_ID, 'showName', {
    name: 'Show the name',
    hint: "Show the token's name under the portrait (the name the players see on the token).",
    scope: 'client',
    config: true,
    type: Boolean,
    default: false
  });
  settings.register(MODULE_ID, 'imageChoice', {
    name: 'Picture to use',
    hint: 'Which art goes on cam. Falls back to the other one when the first is the default silhouette.',
    scope: 'client',
    config: true,
    type: String,
    choices: { portrait: 'Actor portrait', token: 'Token art' },
    default: 'portrait'
  });

  // Last, so a problem with the button can never stop the settings above from loading.
  try {
    const SetupRunner = setupRunnerClass();
    if (SetupRunner) {
      settings.registerMenu(MODULE_ID, 'setup', {
        name: 'Set up OBS',
        label: 'Set up OBS',
        hint: 'Connects to OBS and adds the portrait source on top of your camera scene if it is missing. It never changes or removes anything already in OBS.',
        icon: 'fa-solid fa-plug',
        type: SetupRunner,
        restricted: true
      });
    }
  } catch (error) {
    console.warn('OBS NPC Cam | Could not add the Set up OBS button; use game.modules.get("obs-npc-cam").api.setup() instead.', error);
  }

  g().game.keybindings?.register(MODULE_ID, 'showSelected', {
    name: 'Show selected token on cam',
    editable: [],
    restricted: true,
    onDown: (): boolean => {
      run(showSelected);
      return true;
    }
  });
  g().game.keybindings?.register(MODULE_ID, 'camera', {
    name: 'Back to my camera',
    editable: [],
    restricted: true,
    onDown: (): boolean => {
      run(camera);
      return true;
    }
  });

  // Token controls: show the selected token, and back to the camera.
  g().Hooks.on('getSceneControlButtons', (controls: unknown) => {
    if (!isGM()) return;
    const tools: Record<string, Record<string, unknown>> = {
      'obs-npc-cam-show': { title: 'Show selected token on cam (OBS)', icon: SHOW_ICON, action: showSelected },
      'obs-npc-cam-camera': { title: 'Back to my camera (OBS)', icon: CAMERA_ICON, action: camera }
    };
    try {
      let order = 60;
      for (const [name, def] of Object.entries(tools)) {
        const action = def['action'] as () => Promise<void>;
        const tool = {
          name,
          title: def['title'],
          icon: def['icon'],
          button: true,
          visible: true,
          order: order++,
          onClick: (): void => {
            run(action);
          },
          onChange: (): void => {
            run(action);
          }
        };
        if (Array.isArray(controls)) {
          const tokens = controls.find((c: { name?: string }) => c.name === 'token') as { tools?: unknown[] } | undefined;
          tokens?.tools?.push(tool);
        } else if (controls && typeof controls === 'object') {
          const tokens = (controls as Record<string, { tools?: Record<string, unknown> }>)['tokens'];
          if (tokens?.tools) tokens.tools[name] = tool;
        }
      }
    } catch (error) {
      console.warn('OBS NPC Cam | Could not add the token control buttons:', error);
    }
  });

  // Actors list: right-click an actor.
  const contextEntry = {
    name: SHOW_LABEL,
    icon: `<i class="${SHOW_ICON}"></i>`,
    condition: (): boolean => isGM(),
    callback: (li: unknown): void => {
      const el = li instanceof HTMLElement ? li : (li as { [0]?: unknown } | null)?.[0];
      const id = el instanceof HTMLElement ? (el.dataset['entryId'] ?? el.dataset['documentId']) : undefined;
      const actor = id ? g().game.actors?.get(id) : undefined;
      run(() => show(actor));
    }
  };
  const addContext = (_app: unknown, options: unknown): void => {
    if (Array.isArray(options) && !options.some((o: { name?: string }) => o.name === SHOW_LABEL)) options.push(contextEntry);
  };
  g().Hooks.on('getActorDirectoryEntryContext', addContext);
  g().Hooks.on('getActorContextOptions', addContext);

  // Actor sheets: a header button (classic sheets) or a menu entry (new-style sheets).
  g().Hooks.on('getActorSheetHeaderButtons', (app: unknown, buttons: unknown) => {
    if (!isGM() || !Array.isArray(buttons)) return;
    buttons.unshift({ label: 'On cam', class: 'obs-npc-cam', icon: SHOW_ICON, onclick: (): void => {
      run(() => show((app as { actor?: unknown; document?: unknown }).actor ?? (app as { document?: unknown }).document));
    } });
  });
  g().Hooks.on('getHeaderControlsApplicationV2', (app: unknown, controls: unknown) => {
    const sheet = app as { document?: ActorLike; options?: { actions?: Record<string, unknown> } };
    if (!isGM() || sheet.document?.documentName !== 'Actor' || !Array.isArray(controls)) return;
    if (controls.some((c: { action?: string }) => c.action === 'obsNpcCamShow')) return;
    const handler = (): void => {
      run(() => show(sheet.document));
    };
    if (sheet.options) sheet.options.actions = { ...(sheet.options.actions ?? {}), obsNpcCamShow: handler };
    controls.push({ action: 'obsNpcCamShow', icon: SHOW_ICON, label: SHOW_LABEL, visible: true, onClick: handler });
  });
});

g().Hooks.once('ready', () => {
  const mod = g().game.modules.get(MODULE_ID);
  if (mod) mod.api = { show, showSelected, camera, setup };
});
