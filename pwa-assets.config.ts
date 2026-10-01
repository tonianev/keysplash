import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

// `npm run icons` regenerates the PNG icon set in public/ from public/logo.svg
// (pwa-64/192/512, maskable-icon-512, apple-touch-icon-180).
//
// The logo already carries its own matte blue tile and safe padding, so the maskable
// and Apple icons only need any transparent edge filled with the same tile
// colour (the generator's default is 30% padding on white).
//
// favicon.ico is deliberately left out: it is rendered from the simpler
// public/favicon.svg, which stays legible at 48 px. To rebuild it:
//   node -e "require('sharp-ico').sharpsToIco([require('sharp')('public/favicon.svg',{density:288}).resize(48,48)],'public/favicon.ico',{sizes:[48]})"
const tile = { fit: 'contain', background: '#4A86D8' } as const;

export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: {
    ...minimal2023Preset,
    transparent: { ...minimal2023Preset.transparent, padding: 0.04, favicons: [] },
    maskable: { ...minimal2023Preset.maskable, padding: 0, resizeOptions: tile },
    apple: { ...minimal2023Preset.apple, padding: 0, resizeOptions: tile },
  },
  images: ['public/logo.svg'],
});
