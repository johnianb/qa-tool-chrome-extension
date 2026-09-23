import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

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
      'https://api.anthropic.com/*', // report generation
      'https://*.atlassian.net/*', // Jira issue creation + attachments
    ],
    action: {
      default_title: 'QA Bug Reporter',
    },
  },
});
