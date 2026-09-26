import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// chrome-launcher opens a log file inside the profile directory without creating it
// first, so `wxt dev` dies with ENOENT unless the directory is already there.
const chromeProfile = resolve('.wxt/chrome-profile');
mkdirSync(chromeProfile, { recursive: true });

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],

  // Not the WXT default of `.output`. macOS Finder hides dot-directories, so the
  // "Load unpacked" picker on chrome://extensions cannot see them without a hidden-file
  // toggle — a papercut every person loading this extension would otherwise hit.
  outDir: 'build',

  vite: () => ({
    plugins: [tailwindcss()],
  }),

  // `wxt dev` opens its own Chrome with the extension already installed, so there is no
  // Load-unpacked step while developing. Needs the optional `web-ext` dev dependency —
  // without it WXT silently falls back to printing "load it manually".
  webExt: {
    // A profile of our own, kept between runs. The extension's settings (Anthropic key,
    // Jira credentials) live in chrome.storage, and a throwaway profile would make you
    // re-enter them on every restart. `.wxt/` is gitignored.
    chromiumProfile: chromeProfile,
    keepProfileChanges: true,
    // Somewhere to record against on open, rather than an empty new tab.
    startUrls: ['https://example.com'],
  },

  manifest: {
    name: 'QA Bug Reporter',
    description:
      'Record a bug in your browser tab; get a written, evidence-backed bug report you can push to Jira.',
    permissions: [
      'tabCapture', // record the active tab's video stream
      'offscreen', // host MediaRecorder outside the service worker
      'storage', // settings + live recording state (storage.session)
      'unlimitedStorage', // IndexedDB holds multi-MB video blobs
      'activeTab', // gate tabCapture + captureVisibleTab on user invocation
      'scripting', // inject the MAIN-world console/network probe
      'tabs', // tab metadata and captureVisibleTab keyframes
      'webNavigation', // page loads and SPA history transitions
      'webRequest', // observe 4xx/5xx the page script cannot see
      'downloads', // save report .md / video locally
    ],
    host_permissions: [
      '<all_urls>', // the app under test can be any origin
      'https://api.anthropic.com/*', // report generation, Claude
      'https://generativelanguage.googleapis.com/*', // report generation, Gemini
      'https://*.atlassian.net/*', // Jira issue creation + attachments
    ],
    action: {
      default_title: 'QA Bug Reporter',
    },
  },
});
