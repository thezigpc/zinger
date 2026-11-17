// The swear filter (on by default; the host can switch it off). Masks words in answers and
// names on the server, so phones and TVs only ever get the masked text.
//
// Two lists, to avoid the "Scunthorpe problem":
//   STEMS match the start of a word ("fuck" → "fucking", "fucker").
//   WORDS match whole words only ("ass" but not "class" or "assume").
// Common letter swaps (@ → a, 0 → o, $ → s, 1/! → i, 3 → e) are undone before matching.

const STEMS = [
  "fuck", "fuk", "fck", "shit", "sh1t", "bitch", "cunt", "bastard", "asshole", "arsehole", "dickhead",
  "motherf", "bullshit", "horseshit", "jackass", "dumbass", "fatass", "wanker", "twat", "pussy",
  "whore", "slut", "cocksuck", "blowjob", "handjob", "jizz", "dildo", "faggot",
  "spastic", "wetback", "tranny", "nigger", "nigga",
];
const WORDS = [
  "ass", "asses", "arse", "dick", "dicks", "cock", "cocks", "tits", "titty", "titties", "boob", "boobs",
  "piss", "pissed", "crap", "damn", "goddamn", "fag", "fags", "spic", "spics", "cum", "prick", "pricks",
  "douche", "skank", "kike", "kikes", "retard", "retards", "retarded", "porn", "nude", "nudes", "anal", "penis", "vagina", "boner",
];

const UNLEET: Record<string, string> = { "@": "a", "4": "a", "0": "o", $: "s", "5": "s", "1": "i", "!": "i", "3": "e", "7": "t" };
const norm = (w: string) =>
  w
    .toLowerCase()
    .replace(/[@4$5!0137]/g, (c) => UNLEET[c] ?? c)
    .replace(/(.)\1{2,}/g, "$1$1");
const WORD_SET = new Set(WORDS);

const bad = (raw: string): boolean => {
  const w = norm(raw);
  if (WORD_SET.has(w)) return true;
  return STEMS.some((s) => w.startsWith(s) || (s.length >= 5 && w.includes(s)));
};

/** "What the fuck" → "What the f***". Letters, digits and leet symbols count as a word. */
export function maskProfanity(text: string): string {
  return text.replace(/[\p{L}\p{N}@$!]+/gu, (w) => (w.length > 1 && bad(w) ? w[0] + "*".repeat(w.length - 1) : w));
}
