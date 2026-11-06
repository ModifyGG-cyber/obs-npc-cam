# OBS NPC Cam

Show an NPC's portrait in OBS with one click from Foundry VTT, on top of your own camera in the same scene, and hide it again to go back to your camera. Built for running NPCs "on camera" through the OBS virtual camera, without opening OBS to change images. Works with any game system.

## What you get

- **Show on cam** on a token's right-click menu (the HUD), on actor sheets, and on the right-click menu in the Actors list.
- Two buttons in the token controls on the left: **Show selected token on cam** and **Back to my camera**.
- Optional keybindings for both (Configure Controls > OBS NPC Cam; no keys are set by default).
- The portrait fades in, fits the screen, and can carry the NPC's name as a caption. OBS loads the image straight from Foundry and styles it with the Browser source's custom CSS.
- Everything happens in one OBS scene: the portrait source sits on top of your camera, Show on cam turns it on and hides your webcam source; Back to my camera does the reverse. A Stream Deck button that toggles the source's visibility keeps working too.

Only the GM sees the buttons. The connection runs from the GM's browser, so Foundry and OBS should be on the same computer (or set the OBS address in the settings).

## Setup

1. In OBS (28 or newer): **Tools > WebSocket Server Settings**, tick **Enable WebSocket server**, then **Show Connect Info** and copy the password.
2. In Foundry: **Configure Settings > OBS NPC Cam**, paste the password, and set the exact name of the OBS scene with your camera.
3. Click **Set up OBS**. It adds a Browser source called "NPC Portrait", sized to your canvas, on top of your camera in that scene (hidden until you show someone). It never changes or removes anything already in OBS.

Then right-click an NPC token and click the masked-figure icon.

## Settings

| Setting | Default | |
| --- | --- | --- |
| OBS address / port / password | localhost / 4455 / empty | From OBS's WebSocket Server Settings. Stored only in this browser. |
| OBS scene | Camera | The scene with your camera; the portrait sits on top of it. |
| Portrait source | NPC Portrait | The Browser source the module changes and shows or hides. |
| Camera source | Camera | Your webcam source, hidden while an NPC is shown. Empty: never touched. |
| Around the picture | Black | Black hides your camera behind the portrait; see-through lets it show around the picture. |
| Show the name | off | Caption with the token's name (what the players see). |
| Picture to use | Actor portrait | Or token art. Falls back to the other when one is the default silhouette. |

## Macro API

```js
const cam = game.modules.get('obs-npc-cam').api;
await cam.show(actorOrToken);                          // or cam.show({ img: 'path/to/image.webp', name: 'Caption' })
await cam.showSelected();
await cam.camera();
await cam.setup();
```

## Development

```
npm install
npm run all     # lint, tests (against a fake OBS) and build into dist/obs-npc-cam
```

MIT licensed.
