// Avatar URLs derived from commit emails. Pure, so the Node test runner covers it.
//
// GitHub noreply addresses carry the account name; for other addresses the local part is the best
// guess. Every attempt is allowed to fail: the UI falls back to initials.

export function avatarUrl(email) {
  const value = String(email ?? "").trim();
  if (!value) return null;
  const noreply = value.match(/^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i);
  if (noreply) return `https://github.com/${encodeURIComponent(noreply[1])}.png?size=64`;
  const local = value.split("@")[0]?.trim();
  if (!local) return null;
  return `https://github.com/${encodeURIComponent(local)}.png?size=64`;
}

export function avatarKey(email) {
  let hash = 5381;
  for (const ch of String(email ?? "")) hash = ((hash * 33) ^ ch.codePointAt(0)) >>> 0;
  return hash.toString(16);
}
