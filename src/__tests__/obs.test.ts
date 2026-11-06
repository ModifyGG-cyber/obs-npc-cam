import { createHash } from 'node:crypto';
import { FakeObs, nodeSockets } from './fakeObs';
import { ObsClient } from '../obsClient';
import { backToCamera, pickImage, portraitUrl, setupObs, showPortrait, type CamSettings } from '../cam';
import { obsAuthentication, sha256Fallback } from '../sha256';

const BASE = 'http://localhost:30000/';
const settings: CamSettings = { npcScene: 'NPC', sourceName: 'NPC Portrait', cameraScene: 'Camera', switchScene: true, showName: true };

describe('sha256', () => {
  it('matches Node for many lengths', () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 200, 1000]) {
      const data = new Uint8Array(length).map((_, i) => (i * 31 + 7) & 0xff);
      expect(Buffer.from(sha256Fallback(data)).toString('hex')).toBe(createHash('sha256').update(data).digest('hex'));
    }
  });
  it('answers the OBS challenge like the spec', async () => {
    const b64 = (s: string): string => createHash('sha256').update(s).digest('base64');
    expect(await obsAuthentication('pässword', 'salt', 'chal')).toBe(b64(b64('pässword' + 'salt') + 'chal'));
  });
});

describe('portraits', () => {
  it('builds the page address with the image and name', () => {
    const url = new URL(portraitUrl(BASE, { img: 'worlds/nyarlathotep/actors/Jackson Elias.webp', name: 'Jackson Elias' }, 5));
    expect(url.pathname).toBe('/modules/obs-npc-cam/portrait.html');
    expect(url.searchParams.get('img')).toBe('http://localhost:30000/worlds/nyarlathotep/actors/Jackson%20Elias.webp');
    expect(url.searchParams.get('name')).toBe('Jackson Elias');
    expect(url.searchParams.get('t')).toBe('5');
  });
  it('keeps full image addresses and route prefixes', () => {
    const url = new URL(portraitUrl('http://example.com/game/', { img: 'https://cdn.example.com/a.png' }));
    expect(url.pathname).toBe('/game/modules/obs-npc-cam/portrait.html');
    expect(url.searchParams.get('img')).toBe('https://cdn.example.com/a.png');
    expect(url.searchParams.has('name')).toBe(false);
  });
  it('skips the default silhouette', () => {
    expect(pickImage('icons/svg/mystery-man.svg', 'tokens/cultist.webp', 'portrait')).toBe('tokens/cultist.webp');
    expect(pickImage('actors/a.webp', 'tokens/a.webp', 'portrait')).toBe('actors/a.webp');
    expect(pickImage('actors/a.webp', 'tokens/a.webp', 'token')).toBe('tokens/a.webp');
    expect(pickImage('icons/svg/mystery-man.svg', null, 'portrait')).toBe('icons/svg/mystery-man.svg');
    expect(pickImage(null, undefined, 'portrait')).toBeNull();
  });
});

describe('with a fake OBS', () => {
  let obs: FakeObs;
  let client: ObsClient;
  afterEach(async () => {
    client.disconnect();
    await obs.stop();
  });
  const start = async (password = ''): Promise<void> => {
    obs = new FakeObs(password);
    await obs.start();
    client = new ObsClient(nodeSockets);
  };

  it('logs in with the right password', async () => {
    await start('secret');
    await client.connect({ host: 'localhost', port: obs.port, password: 'secret' });
    expect(client.connected).toBe(true);
  });

  it('explains a wrong password', async () => {
    await start('secret');
    await expect(client.connect({ host: 'localhost', port: obs.port, password: 'nope' })).rejects.toThrow(/rejected the password/);
  });

  it('explains when OBS is not running', async () => {
    await start();
    const port = obs.port;
    await obs.stop();
    obs = new FakeObs();
    await obs.start();
    await expect(client.connect({ host: 'localhost', port, password: '' })).rejects.toThrow(/Could not reach OBS/);
  });

  it('shares one login between quick clicks', async () => {
    await start('secret');
    const connection = { host: 'localhost', port: obs.port, password: 'secret' };
    await Promise.all([client.connect(connection), client.connect(connection)]);
    expect(client.connected).toBe(true);
  });

  it('sets up, shows an NPC and goes back to the camera', async () => {
    await start('secret');
    await client.connect({ host: 'localhost', port: obs.port, password: 'secret' });

    await expect(showPortrait(client, settings, BASE, { img: 'a.webp' })).rejects.toThrow(/Set up OBS/);

    const report = await setupObs(client, settings, BASE);
    expect(report).toEqual([
      'Created the scene "NPC".',
      'Created the Browser source "NPC Portrait" (1280x720) in "NPC".',
      'Found the camera scene "Camera".'
    ]);
    expect(obs.inputs.get('NPC Portrait')).toEqual({
      kind: 'browser_source',
      settings: { url: 'http://localhost:30000/modules/obs-npc-cam/portrait.html', width: 1280, height: 720 }
    });

    await showPortrait(client, settings, BASE, { img: 'worlds/w/elias.webp', name: 'Jackson Elias' });
    const url = new URL(String(obs.inputs.get('NPC Portrait')?.settings['url']));
    expect(url.searchParams.get('img')).toBe('http://localhost:30000/worlds/w/elias.webp');
    expect(url.searchParams.get('name')).toBe('Jackson Elias');
    expect(obs.program).toBe('NPC');

    await backToCamera(client, settings);
    expect(obs.program).toBe('Camera');

    // Running setup again adds nothing.
    expect(await setupObs(client, settings, BASE)).toEqual([
      'Found the scene "NPC".',
      'Found the source "NPC Portrait" in "NPC".',
      'Found the camera scene "Camera".'
    ]);
  });

  it('can leave the scene alone and hide the name', async () => {
    await start();
    await client.connect({ host: 'localhost', port: obs.port, password: '' });
    await setupObs(client, settings, BASE);
    await showPortrait(client, { ...settings, switchScene: false, showName: false }, BASE, { img: 'b.webp', name: 'Secret' });
    expect(obs.program).toBe('Camera');
    expect(new URL(String(obs.inputs.get('NPC Portrait')?.settings['url'])).searchParams.has('name')).toBe(false);
  });

  it('refuses to use a source that is not a Browser source, and warns about a wrong camera scene', async () => {
    await start();
    await client.connect({ host: 'localhost', port: obs.port, password: '' });
    await expect(setupObs(client, { ...settings, sourceName: 'Webcam' }, BASE)).rejects.toThrow(/not a Browser source/);
    const report = await setupObs(client, { ...settings, cameraScene: 'Me' }, BASE);
    expect(report[2]).toMatch(/no scene called "Me".*Camera, NPC/);
    await expect(backToCamera(client, { ...settings, cameraScene: 'Me' })).rejects.toThrow(/No scene was found/);
  });
});
