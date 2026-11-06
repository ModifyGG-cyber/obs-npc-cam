# OBS NPC Cam

Show an NPC's portrait in OBS with one click from Foundry VTT, and switch OBS between the NPC and your own camera. Built for running NPCs "on camera" through the OBS virtual camera, without opening OBS to change images. Works with any game system.

## What you get

- **Show on cam** on a token's right-click menu (the HUD), on actor sheets, and on the right-click menu in the Actors list.
- Two buttons in the token controls on the left: **Show selected token on cam** and **Back to my camera**.
- Optional keybindings for both (Configure Controls > OBS NPC Cam; no keys are set by default).
- The portrait fades in, fits the screen, and can carry the NPC's name as a caption.
- Your Stream Deck scene toggles keep working: the module only changes one Browser source, and switching to the NPC scene is optional.

Only the GM sees the buttons. The connection runs from the GM's browser, so Foundry and OBS should be on the same computer (or set the OBS address in the settings).

## Setup

1. In OBS (28 or newer): **Tools > WebSocket Server Settings**, tick **Enable WebSocket server**, then **Show Connect Info** and copy the password.
2. In Foundry: **Configure Settings > OBS NPC Cam**, paste the password, and set the exact names of your **NPC scene** and **Camera scene**.
3. Click **Set up OBS**. It adds the NPC scene (if missing) and a Browser source called "NPC Portrait" sized to your canvas. It never changes or removes anything already in OBS. If your NPC scene already had an image source, hide or delete it yourself.

Then right-click an NPC token and click the masked-figure icon.

## Settings

| Setting | Default | |
| --- | --- | --- |
| OBS address / port / password | localhost / 4455 / empty | From OBS's WebSocket Server Settings. Stored only in this browser. |
| NPC scene | NPC | The scene that shows the portrait. |
| Portrait source | NPC Portrait | The Browser source the module changes. |
| Camera scene | Camera | Used by "Back to my camera". |
| Switch to the NPC scene | on | Turn off to only swap the picture and switch scenes yourself. |
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
