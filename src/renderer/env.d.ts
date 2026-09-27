import type { AdeRendererApi } from '../shared/contracts/ipc';

declare global {
  interface Window { readonly ade: AdeRendererApi }
}

export {};
