/** Make a possibly relative link absolute. Pure, so it is tested directly. */
export function absolutise(url, base) {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  if (!base) return url;
  return `${base.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

export function isAbsoluteHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}
