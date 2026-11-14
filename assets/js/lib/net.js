/* ==========================================================================
   Tiny JSON fetch helper with an optional fallback.
   `cache: 'no-cache'` keeps GitHub Pages' CDN honest after you push changes.
   ========================================================================== */

export async function loadJSON(path, fallback = undefined) {
  try {
    const response = await fetch(path, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw error;
  }
}
