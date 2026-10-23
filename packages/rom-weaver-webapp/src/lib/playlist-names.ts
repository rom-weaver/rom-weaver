/**
 * Maps the lines the `playlist` command wrote back to the files the user gave.
 *
 * The browser stages every file under a normalized virtual name (non-ASCII and
 * reserved characters become `_`, collisions gain a `-N` suffix), so the command
 * reports those staged names. The user's own files keep their real names.
 */

/** For each playlist line, the index of the staged file it names, or -1 when none matches. */
const matchPlaylistLines = (lines: readonly string[], stagedNames: readonly string[]): number[] =>
  lines.map((line) => stagedNames.indexOf(line));

/** The playlist lines under the user's real file names; an unmatched line is kept as written. */
const realPlaylistLines = (lines: readonly string[], indexes: readonly number[], realNames: readonly string[]) =>
  lines.map((line, position) => realNames[indexes[position] ?? -1] || line);

/** Rewrite playlist text so each staged name becomes the real name; other lines stay as written. */
const renamePlaylistText = (text: string, renames: ReadonlyMap<string, string>): string =>
  text
    .split("\n")
    .map((line) => renames.get(line) ?? line)
    .join("\n");

export { matchPlaylistLines, realPlaylistLines, renamePlaylistText };
