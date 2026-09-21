/**
 * Works out what KIND of design an image is, without any AI and without
 * touching the internet. Two signals are available offline:
 *
 *   1. The filename  - if you saved it as "checkout-dashboard.png", that is a
 *                      far better answer than anything we could infer.
 *   2. The shape     - phone screens, Instagram posts and A4 pages all have
 *                      giveaway aspect ratios.
 *
 * Shape cannot tell a dashboard from any other desktop screen: that is about
 * what is IN the picture, not its outline. So "dashboard" only ever comes from
 * the filename, and every guess carries a confidence so the UI can flag the
 * ones worth a second look.
 */

const path = require('path');

// ---------------------------------------------------------------- the kinds

const KINDS = [
  { id: 'mobile', label: 'Mobile' },
  { id: 'desktop', label: 'Desktop / Web' },
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'ui', label: 'UI Component' },
  // Brand identity and the posts that come out of it are the same shelf: a
  // colour palette and the Instagram grid built from it belong together.
  { id: 'branding', label: 'Brand & Social' },
  { id: 'print', label: 'Print' },
  { id: 'illustration', label: 'Illustration' },
  { id: 'other', label: 'Other' },
];

const KIND_IDS = new Set(KINDS.map((k) => k.id));

// --------------------------------------------------------- filename signals

// Checked in order, so the more specific patterns come first: a file called
// "mobile-dashboard" is a dashboard that happens to be on a phone.
const NAME_RULES = [
  [
    'dashboard',
    /dashboard|analytic|admin[ _-]?panel|\bkpi\b|\bchart\b|\bgraph\b|metrics?|report(ing)?|data[ _-]?viz|back[ _-]?office|\bcrm\b/i,
  ],
  // Kept ahead of print so that "brand poster" reads as brand work, while a
  // plain "poster" with no brand words still lands in print.
  [
    'branding',
    /instagram|\binsta\b|\big[ _-]|story|stories|reels?|tiktok|twitter|linked[ _-]?in|facebook|social|thumbnail|carousel|logo|brand(ing)?|identity|wordmark|monogram|typeface|type[ _-]?spec|colou?r[ _-]?palette|style[ _-]?guide/i,
  ],
  [
    'print',
    /print|poster|flyer|brochure|magazine|editorial|packag|label|business[ _-]?card|letterhead|booklet|\ba[3-6]\b|billboard/i,
  ],
  ['illustration', /illustrat|\bicon(s|[ _-]set)?\b|artwork|pattern|texture|\b3d\b|render|character/i],
  // Named after one piece of an interface rather than a whole screen. Deliberately
  // no bare "ui": "app ui" and "mobile ui" describe screens, not components.
  [
    'ui',
    /component|\bmodal\b|dialog|drawer|dropdown|\bmenu\b|\bnav(bar|igation)?\b|side[ _-]?bar|\bform\b|\binput\b|checkbox|toggle|slider|stepper|\btabs?\b|accordion|tooltip|popover|\btoast\b|snackbar|\bbadges?\b|\bchips?\b|avatar|breadcrumb|pagination|date[ _-]?picker|\btables?\b|data[ _-]?grid|\bcards?\b|\bbuttons?\b|empty[ _-]?state|ui[ _-]?kit|design[ _-]?system|widget/i,
  ],
  ['mobile', /mobile|phone|iphone|android|\bios\b|app[ _-]?(screen|shot|ui)|\bpwa\b/i],
  [
    'desktop',
    /desktop|website|web[ _-]?(page|site|app)|landing|home[ _-]?page|\bsaas\b|\bhero\b|marketing[ _-]?site|checkout|pricing/i,
  ],
];

function fromName(filename) {
  // Uploads get a timestamp prefix whose digits could collide with patterns
  // like \ba[3-6]\b, so strip it before matching.
  const base = path
    .basename(filename, path.extname(filename))
    .replace(/^\d{4}-\d{2}-\d{2}T[\d-]+__/, '');

  for (const [kind, pattern] of NAME_RULES) {
    if (pattern.test(base)) return kind;
  }
  return null;
}

// ------------------------------------------------------------ shape signals

/**
 * Aspect ratio (width / height) to a kind. The ranges are deliberately
 * generous: screenshots pick up window chrome and browser bars, so a "9:16"
 * phone shot is rarely exactly 0.5625.
 */
function fromShape(width, height) {
  if (!width || !height) return null;
  const r = width / height;

  // --- Portrait ------------------------------------------------------------

  if (r < 0.42) {
    // Very tall: either a full-page scroll capture or a long phone screen.
    // Width is the tiebreak - nobody's phone mockup is 1600px across.
    return width >= 900
      ? { kind: 'desktop', confidence: 'low', why: 'very tall capture at desktop width' }
      : { kind: 'mobile', confidence: 'low', why: 'very tall and narrow' };
  }
  if (r < 0.6) {
    // 9:19.5 (0.462) through 9:16 (0.5625) - the modern phone band.
    return { kind: 'mobile', confidence: 'high', why: 'phone screen ratio' };
  }
  if (r < 0.66) {
    return { kind: 'mobile', confidence: 'low', why: 'tall portrait' };
  }
  if (r < 0.74) {
    // A4, A3 and A5 are all 1:root-2 (0.707).
    return { kind: 'print', confidence: 'high', why: 'A-series paper ratio' };
  }
  if (r < 0.785) {
    // US Letter is 0.773 - close enough to 4:5 (0.8) to be worth flagging.
    return { kind: 'print', confidence: 'low', why: 'letter paper ratio' };
  }
  if (r < 0.86) {
    // 4:5 - the Instagram portrait post.
    return { kind: 'branding', confidence: 'high', why: '4:5 social post' };
  }
  if (r < 0.96) {
    return { kind: 'other', confidence: 'low', why: 'near-square portrait' };
  }

  // --- Square --------------------------------------------------------------

  if (r <= 1.06) {
    return { kind: 'branding', confidence: 'high', why: 'square post' };
  }

  // --- Landscape -----------------------------------------------------------

  if (r < 1.2) {
    return { kind: 'other', confidence: 'low', why: 'near-square landscape' };
  }
  if (r < 1.5) {
    // 4:3 and 1.41 (A4 landscape). Genuinely ambiguous territory.
    return { kind: 'desktop', confidence: 'low', why: 'shallow landscape' };
  }
  if (r < 2.1) {
    // 16:10 (1.6) and 16:9 (1.78) - the screen band.
    return width >= 1000
      ? { kind: 'desktop', confidence: 'high', why: 'widescreen at screen resolution' }
      : { kind: 'desktop', confidence: 'low', why: 'widescreen but small' };
  }
  if (r < 3.2) {
    return { kind: 'branding', confidence: 'low', why: 'banner ratio' };
  }
  return { kind: 'other', confidence: 'low', why: 'extremely wide' };
}

// ------------------------------------------------------------------ combine

/**
 * Returns { kind, confidence, why }. Never throws - an image we cannot read
 * simply lands in "other", where the user can set it themselves.
 */
function classify(filename, width, height) {
  const named = fromName(filename);
  if (named) {
    return { kind: named, confidence: 'high', why: 'named in the filename' };
  }

  const shaped = fromShape(width, height);
  if (shaped) return shaped;

  return { kind: 'other', confidence: 'low', why: 'could not read the image size' };
}

module.exports = { KINDS, KIND_IDS, classify, fromName, fromShape };
