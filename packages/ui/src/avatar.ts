/** How many avatar colours the stylesheet defines (`.avatar-0` and up). */
export const AVATAR_COLOURS = 8;

/** A stable colour number for a name, so an agent keeps its colour everywhere and every day. */
export function avatarColour(name: string): number {
  let hash = 0;
  for (const char of name.toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash % AVATAR_COLOURS;
}

/** Up to two letters for an avatar: "Ada" gives "A", "Sock Shop" gives "SS". */
export function initials(name: string): string {
  const words = name
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  const letters = words.length > 1 ? [words[0]!, words[1]!] : words;
  return letters.map((word) => [...word][0]!.toUpperCase()).join('') || '?';
}
