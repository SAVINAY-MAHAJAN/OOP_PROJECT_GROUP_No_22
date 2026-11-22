const stop = new Set(
  'the a an to is are was were of in on for and or my our we i it its with not be this that make get some all users user as at by from has have been when since any now please cannot cant'.split(
    ' ',
  ),
);
const synonyms = new Map();
for (const [key, words] of Object.entries({
  fail: 'unavailable down outage offline unreachable crash crashed fail failed failing failure broken error unable unresponsive stuck dead',
  slow: 'slow sluggish lag lagging latency timeout timeouts',
  payment: 'pay payment payments checkout transaction transactions',
  login: 'login signin logon authenticate authentication sso',
}))
  for (const word of words.split(' ')) synonyms.set(word, key);

function stem(word) {
  if (synonyms.has(word)) return synonyms.get(word);
  let s = word;
  if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  return synonyms.get(s) || s;
}
export function tokens(text) {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 2 && !stop.has(w))
      .map(stem),
  );
}
export function categorize(title, description, categories, service) {
  const phrase = (title + ' ' + description).toLowerCase();
  const words = tokens(phrase);
  let category = service.defaultCategory,
    highScore = 0;
  for (const candidate of categories) {
    const score = candidate.keywords.filter((k) =>
      k.includes(' ') ? phrase.includes(k.toLowerCase()) : words.has(stem(k.toLowerCase())),
    ).length;
    if (score > highScore) {
      category = candidate.id;
      highScore = score;
    }
  }
  return category;
}
export function similarity(a, b) {
  const first = tokens(a.title + ' ' + a.description),
    second = tokens(b.title + ' ' + b.description);
  const overlap = [...first].filter((w) => second.has(w)).length;
  const size = first.size + second.size - overlap;
  return (
    (size ? 0.7 * (overlap / size) : 0) +
    (a.service === b.service ? 0.2 : 0) +
    (a.category && a.category === b.category ? 0.1 : 0)
  );
}
export function similar(incident, candidates, threshold, limit) {
  return candidates
    .filter((candidate) => candidate.id !== incident.id)
    .map((item) => ({ item, score: similarity(incident, item) }))
    .filter((candidate) => candidate.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
