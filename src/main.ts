/**
 * OBS NPC Cam: show an NPC's portrait in OBS with one click, from a token's HUD, an actor's sheet,
 * the Actors list or a keybinding, and switch OBS between the NPC scene and your camera.
 *
 * Talks straight to OBS's built-in remote control (Tools > WebSocket Server Settings) from the GM's browser.
 * Macro API:
 *   const cam = game.modules.get('obs-npc-cam').api;
 *   await cam.show(actorOrToken);            // or cam.show({ img: 'path/to/image.webp', name: 'Caption' })
 *   await cam.showSelected();
 *   await cam.camera();
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
  Hooks: { on(hook: string, fn: (...args: unknown[]) => unknown): number; once(hook: string, fn: (...args: unknown[]) => unknown): number };
  ui: { notifications?: Notifications };
  foundry?: {
    utils?: { getRoute?(path: string): string };
    applications?: { api?: { DialogV2?: { prompt(options: Record<string, unknown>): Promise<unknown> } } };
  };
  WebSocket: new (url: string) => unknown;
}

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
    cameraScene: text('cameraScene'),
    switchScene: setting('switchScene') === true,
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
  await showPortrait(await connected(), camSettings(), foundryBase(), portrait);
}

async function showSelected(): Promise<void> {
  const token = g().canvas?.tokens?.controlled?.[0];
  if (!token) throw new Error('Select an NPC token first.');
  await show(token);
}

async function camera(): Promise<void> {
  await backToCamera(await connected(), camSettings());
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

async function setup(): Promise<string[]> {
  const lines = await setupObs(await connected(), camSettings(), foundryBase());
  const dialog = g().foundry?.applications?.api?.DialogV2;
  const content = `<ul>${lines.map(line => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`;
  if (dialog) await dialog.prompt({ window: { title: 'OBS NPC Cam setup' }, content, ok: { label: 'OK' } });
  else g().ui.notifications?.info(lines.join(' '));
  return lines;
}

const run = (action: () => Promise<unknown>): void => {
  void action().catch(report);
};

/** The settings button: Foundry opens settings menus with `new type().render()`, so this runs the setup instead of a form. */
class SetupRunner {
  render(): this {
    run(setup);
    return this;
  }
}

const SHOW_LABEL = 'Show on cam';
const SHOW_ICON = 'fa-solid fa-user-secret';
const CAMERA_ICON = 'fa-solid fa-video';

g().Hooks.once('init', () => {
  const { settings } = g().game;
  const reconnect = (): void => {
    client.disconnect();
  };
  const textSetting = (key: string, name: string, hint: string, fallback: string, onChange?: () => void): void => {
    settings.register(MODULE_ID, key, { name, hint, scope: 'client', config: true, type: String, default: fallback, ...(onChange ? { onChange } : {}) });
  };
  settings.registerMenu(MODULE_ID, 'setup', {
    name: 'Set up OBS',
    label: 'Set up OBS',
    hint: 'Connects to OBS and adds the NPC scene and portrait source if they are missing. It never changes or removes anything already in OBS.',
    icon: 'fa-solid fa-plug',
    type: SetupRunner,
    restricted: true
  });
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
  textSetting('npcScene', 'NPC scene', 'The exact name of the OBS scene that shows the NPC.', 'NPC');
  textSetting('sourceName', 'Portrait source', 'The OBS Browser source that shows the portrait. "Set up OBS" creates it.', 'NPC Portrait');
  textSetting('cameraScene', 'Camera scene', 'The exact name of your OBS scene with your own camera, for "Back to my camera".', 'Camera');
  settings.register(MODULE_ID, 'switchScene', {
    name: 'Switch to the NPC scene',
    hint: 'After showing a portrait, switch OBS to the NPC scene. Turn off to only swap the picture and keep switching scenes yourself (for example with your Stream Deck).',
    scope: 'client',
    config: true,
    type: Boolean,
    default: true
  });
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

  // Token HUD (right-click a token): a button in the right-hand column.
  g().Hooks.on('renderTokenHUD', (hud: unknown, html: unknown) => {
    if (!isGM()) return;
    const root = html instanceof HTMLElement ? html : (html as { [0]?: unknown } | null)?.[0];
    if (!(root instanceof HTMLElement)) return;
    const column = root.querySelector('.col.right');
    if (!column || column.querySelector('.obs-npc-cam')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'control-icon obs-npc-cam';
    button.title = SHOW_LABEL;
    button.innerHTML = `<i class="${SHOW_ICON}"></i>`;
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      run(() => show((hud as { object?: TokenLike }).object));
    });
    column.appendChild(button);
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
