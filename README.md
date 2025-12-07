# Strudel IDE

Write [Strudel](https://strudel.cc/) music in your editor with hot reload.

## Setup

```bash
npm install
npm run dev
```

## Usage

1. Select a song from the dropdown
2. Click **Play**
3. Edit songs in `src/songs/` — changes hot reload automatically

## Adding Songs

1. Copy `src/songs/_template.ts` to a new file (e.g., `my-song.ts`)
2. Edit the song
3. Done! Songs are auto-discovered.

## Song Structure

```typescript
import type { Song } from ".";

const song: Song = {
  name: "My Song",
  createPattern() {
    const kick = s("bd*4").bank("RolandTR808");
    const bass = note("<c2 f2 g2 a2>").sound("sawtooth").lpf(400);
    return stack(kick, bass);
  },
};

export default song;
```

## Docs

- [Strudel Documentation](https://strudel.cc/)
- [Mini Notation](https://strudel.cc/learn/mini-notation/)
