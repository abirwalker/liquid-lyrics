import { getSongwriters, isRecord } from '../types/types';

export function parseSpotifySongwriters(response: unknown): string[] | null {
  if (!isRecord(response) || (Array.isArray(response.errors) && response.errors.length)) return null;
  const track = isRecord(response.data) ? response.data.trackUnion : null;
  if (!isRecord(track) || track.__typename !== 'Track') return null;
  const trait = isRecord(track.creditsTrait) ? track.creditsTrait : null;
  const contributors = trait && isRecord(trait.contributors) ? trait.contributors.items : null;
  if (!Array.isArray(contributors)) return null;
  return getSongwriters(contributors.filter(contributor => {
    if (!isRecord(contributor)) return false;
    const role = typeof contributor.role === 'string' ? contributor.role.trim().toLowerCase() : '';
    const group = isRecord(contributor.roleGroup) ? contributor.roleGroup.name : null;
    return ['writer', 'songwriter', 'composer', 'lyricist'].includes(role) ||
      (typeof group === 'string' && group.trim().toLowerCase() === 'written by');
  }).map(contributor => contributor.name));
}

export function createSpotifyCreditsLookup(getApi = () => globalThis.Spicetify?.GraphQL) {
  const cache = new Map<string, string[]>();
  const pending = new Map<string, Promise<string[]>>();

  return async (id: string): Promise<string[]> => {
    if (!/^[a-zA-Z0-9]{22}$/.test(id)) return [];
    const cached = cache.get(id);
    if (cached) return [...cached];
    const inFlight = pending.get(id);
    if (inFlight) return [...await inFlight];
    const api = getApi();
    const definition = api?.Definitions?.queryTrackCreditsGroupedModal;
    if (!definition || typeof api?.Request !== 'function') return [];

    const request = Promise.resolve().then(() => api.Request!(definition, {
      trackUri: `spotify:track:${id}`, contributorsLimit: 100, contributorsOffset: 0,
    })).then(response => {
      const writers = parseSpotifySongwriters(response);
      if (writers) {
        if (cache.size >= 100) cache.delete(cache.keys().next().value!);
        cache.set(id, writers);
      }
      return writers ?? [];
    }).catch(() => []).finally(() => pending.delete(id));
    pending.set(id, request);
    return [...await request];
  };
}

export const fetchSpotifySongwriters = createSpotifyCreditsLookup();
