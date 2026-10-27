type EmulatorGames = { get: (url: string) => Blob | null };

/** The Blob behind each live game URL, which the emulator document reads instead of fetching the URL. */
const games = new Map<string, Blob>();

const createEmulatorGameUrl = (blob: Blob): string => {
  const url = URL.createObjectURL(blob);
  games.set(url, blob);
  const host = globalThis as typeof globalThis & { __romWeaverEmulatorGames?: EmulatorGames };
  host.__romWeaverEmulatorGames ??= { get: (gameUrl) => games.get(gameUrl) ?? null };
  return url;
};

const revokeEmulatorGameUrl = (url: string) => {
  games.delete(url);
  URL.revokeObjectURL(url);
};

export { createEmulatorGameUrl, revokeEmulatorGameUrl };
