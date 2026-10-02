/**
 * Copyright (c) Microsoft Corporation.
 * Modifications copyright (c) playwright-extended-report contributors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Mirrors packages/html-reporter/vite.config.ts from Playwright:
// builds the report UI into dist/web/{index.html,report.js,report.css}.

import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

function stripLicenseComment(): Plugin {
  return {
    name: 'strip-license-comment',
    transformIndexHtml: {
      handler(html, ctx) {
        if (!ctx || !ctx.bundle)
          return html;
        return html.replace(/(?=<!--)([\s\S]*?)-->/, '');
      },
    },
  };
}

export default defineConfig({
  root: __dirname,
  base: '',
  plugins: [
    react(),
    stripLicenseComment(),
  ],
  resolve: {
    alias: {
      '@web': path.resolve(__dirname, 'vendor/web'),
      '@isomorphic': path.resolve(__dirname, 'vendor/isomorphic'),
      '@testIsomorphic': path.resolve(__dirname, 'vendor/testIsomorphic'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, '../dist/web'),
    emptyOutDir: true,
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000000,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        manualChunks: undefined,
        inlineDynamicImports: true,
        entryFileNames: 'report.js',
        assetFileNames: (assetInfo: any) => (assetInfo.names ?? [assetInfo.name]).some((n: string) => n?.endsWith('.css')) ? 'report.css' : '[name][extname]',
      },
    },
  },
});
