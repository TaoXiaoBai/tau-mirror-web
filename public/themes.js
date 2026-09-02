/**
 * Theme system — three light and three dark palettes, with an independent
 * appearance mode controlling when the preferred light/dark palette is used.
 */

export const themes = {
  night: {
    name: 'Dusk',
    dark: true,
    colors: ['#212121', '#a0a0a0', '#777777', '#666666'],
    vars: {},
  },
  dawn: {
    name: 'Dawn',
    dark: true,
    colors: ['#1a1d26', '#7a8ab0', '#6a5a80', '#5a7a9a'],
    vars: {},
  },
  midnight: {
    name: 'Midnight',
    dark: true,
    colors: ['#000000', '#5a7a9a', '#4a5565', '#4a5a72'],
    vars: {},
  },
  clean: {
    name: 'Clean',
    dark: false,
    colors: ['#ffffff', '#0580c4', '#007aff', '#5ac8fa'],
    vars: {},
  },
  terracotta: {
    name: 'Terracotta',
    dark: false,
    colors: ['#f4f1ec', '#b06a48', '#5c2860', '#3a6a9b'],
    vars: {},
  },
  sage: {
    name: 'Sage',
    dark: false,
    colors: ['#f0f2ec', '#6a7d5a', '#4a3860', '#3a6a7a'],
    vars: {},
  },
};

const THEME_KEY = 'tau-theme';
const LIGHT_THEME_KEY = 'tau-theme-light';
const DARK_THEME_KEY = 'tau-theme-dark';
const APPEARANCE_KEY = 'tau-appearance-mode';
const VALID_MODES = new Set(['manual', 'system', 'time', 'light', 'dark']);
const DEFAULT_LIGHT = 'terracotta';
const DEFAULT_DARK = 'night';
const TIME_DARK_START = 19;
const TIME_DARK_END = 7;

function normalizeTheme(themeId) {
  if (themeId === 'dark') return DEFAULT_DARK;
  if (themeId === 'light') return DEFAULT_LIGHT;
  return themes[themeId] ? themeId : '';
}

function storedPalette(kind) {
  const key = kind === 'dark' ? DARK_THEME_KEY : LIGHT_THEME_KEY;
  const fallback = kind === 'dark' ? DEFAULT_DARK : DEFAULT_LIGHT;
  const saved = normalizeTheme(localStorage.getItem(key));
  return saved && themes[saved].dark === (kind === 'dark') ? saved : fallback;
}

function rememberPalette(themeId) {
  if (!themes[themeId]) return;
  localStorage.setItem(themes[themeId].dark ? DARK_THEME_KEY : LIGHT_THEME_KEY, themeId);
}

function systemWantsDark() {
  return !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

function localTimeWantsDark(date = new Date()) {
  const hour = date.getHours();
  return hour >= TIME_DARK_START || hour < TIME_DARK_END;
}

export function getAppearanceMode() {
  const saved = localStorage.getItem(APPEARANCE_KEY);
  if (VALID_MODES.has(saved)) return saved;
  // Existing Tau users chose a concrete palette. Preserve that behavior until
  // they explicitly select an automatic mode; new users follow the OS.
  return localStorage.getItem(THEME_KEY) ? 'manual' : 'system';
}

export function resolveTheme(mode = getAppearanceMode(), date = new Date()) {
  const saved = normalizeTheme(localStorage.getItem(THEME_KEY));
  if (mode === 'manual') return saved || (systemWantsDark() ? DEFAULT_DARK : DEFAULT_LIGHT);
  if (mode === 'dark') return storedPalette('dark');
  if (mode === 'light') return storedPalette('light');
  if (mode === 'time') return storedPalette(localTimeWantsDark(date) ? 'dark' : 'light');
  return storedPalette(systemWantsDark() ? 'dark' : 'light');
}

export function applyTheme(themeId, options = {}) {
  const root = document.documentElement;
  const normalized = normalizeTheme(themeId) || DEFAULT_DARK;
  root.setAttribute('data-theme', normalized);
  if (options.remember !== false) {
    localStorage.setItem(THEME_KEY, normalized);
    rememberPalette(normalized);
  }
  return normalized;
}

export function applyAppearanceMode(mode = getAppearanceMode()) {
  const normalizedMode = VALID_MODES.has(mode) ? mode : 'system';
  localStorage.setItem(APPEARANCE_KEY, normalizedMode);
  const resolved = resolveTheme(normalizedMode);
  applyTheme(resolved, { remember: false });
  return resolved;
}

export function setAppearanceMode(mode) {
  return applyAppearanceMode(mode);
}

export function selectTheme(themeId) {
  const normalized = normalizeTheme(themeId) || DEFAULT_DARK;
  applyTheme(normalized);
  // Choosing a swatch means “keep this exact palette” until the user selects
  // another appearance mode.
  localStorage.setItem(APPEARANCE_KEY, 'manual');
  return normalized;
}

export function getCurrentTheme() {
  return normalizeTheme(document.documentElement.getAttribute('data-theme')) || resolveTheme();
}

export function refreshAutomaticTheme() {
  const mode = getAppearanceMode();
  if (mode === 'manual') return getCurrentTheme();
  return applyAppearanceMode(mode);
}

const systemScheme = window.matchMedia?.('(prefers-color-scheme: dark)');
systemScheme?.addEventListener?.('change', () => {
  if (getAppearanceMode() === 'system') applyAppearanceMode('system');
});
