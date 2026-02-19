const js = require("@eslint/js");

module.exports = [
  js.configs.recommended,

  // Ignore dependencies and generated files
  { ignores: ["node_modules/", "icons/"] },

  // Shared rules for all files
  {
    rules: {
      // Allow unused vars prefixed with _ (common "intentionally ignored" convention)
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      // Allow empty catch blocks (used for intentional error swallowing in cleanup code)
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  // Chrome extension files (service worker + popup)
  {
    files: ["background.js", "popup.js"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "script",
      globals: {
        // Browser globals
        window: "readonly",
        document: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        requestAnimationFrame: "readonly",
        fetch: "readonly",
        atob: "readonly",
        Blob: "readonly",
        Uint8Array: "readonly",
        URL: "readonly",
        Image: "readonly",
        navigator: "readonly",
        ClipboardItem: "readonly",
        // Chrome extension
        chrome: "readonly",
        importScripts: "readonly",
        // Provided by lib.js loaded before popup.js
        isRestrictedUrl: "readonly",
      },
    },
  },

  // Shared library (runs in browser, service worker, and injected into pages)
  {
    files: ["lib.js"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "script",
      globals: {
        // Browser globals
        window: "readonly",
        document: "readonly",
        console: "readonly",
        getComputedStyle: "readonly",
        // Conditional Node.js export
        module: "readonly",
      },
    },
  },

  // Node.js dev scripts
  {
    files: ["generate-icons.js"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "script",
      globals: {
        require: "readonly",
        module: "readonly",
        __dirname: "readonly",
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
      },
    },
  },

  // Tests
  {
    files: ["test/**/*.js"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "script",
      globals: {
        require: "readonly",
        __dirname: "readonly",
        console: "readonly",
        setTimeout: "readonly",
      },
    },
  },

  // This config file itself
  {
    files: ["eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "script",
      globals: {
        require: "readonly",
        module: "writable",
      },
    },
  },
];
