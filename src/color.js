const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value) {
  return typeof value === 'string' && HEX_COLOR.test(value);
}

export function hexToRgb(hex) {
  if (!isHexColor(hex)) throw new TypeError(`invalid hex color: ${hex}`);
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

export function parseBackground(value) {
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (typeof value === 'string' && /^#[0-9a-fA-F]{8}$/.test(value)) {
    const rgb = hexToRgb(value.slice(0, 7));
    return { ...rgb, a: parseInt(value.slice(7, 9), 16) / 255 };
  }
  const rgb = hexToRgb(value);
  return { ...rgb, a: 1 };
}

export const PROVENANCE_COLORS = [
  '#e4572e',
  '#17a398',
  '#4b7bec',
  '#b07d3c',
  '#8e44ad',
  '#d4a017',
  '#2d9d4f',
  '#d6457a',
  '#0f8b8d',
  '#7a5cff',
  '#c25e00',
  '#2b6cb0',
];

export function provenanceColor(index) {
  const n = PROVENANCE_COLORS.length;
  return PROVENANCE_COLORS[((index % n) + n) % n];
}
