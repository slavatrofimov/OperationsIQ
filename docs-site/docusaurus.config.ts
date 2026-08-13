import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

// Hosting is target-agnostic and driven by environment variables so the same
// source can build for Fabric Apps (Rayfin) static hosting or GitHub Pages.
//
//   Default (no env)         -> Fabric App (Rayfin) static hosting, served at
//                               the domain root (baseUrl '/').
//   DOCS_URL / DOCS_BASE_URL -> override for any host (set both).
//
// Rayfin serves the app at the root of its generated webapp origin
// (e.g. https://<app>.webapp.fabricapps.net/), so the base path is '/'.
// The real origin is only known after `rayfin up`; it does not affect routing
// because all in-site links use root-relative paths.
const url = process.env.DOCS_URL ?? 'https://operations-iq-docs.webapp.fabricapps.net';
const baseUrl = process.env.DOCS_BASE_URL ?? '/';

const config: Config = {
  title: 'Operations IQ',
  tagline: 'Turn operational time-series data into business-ready intelligence',
  favicon: 'img/favicon.svg',

  future: {
    v4: true,
  },

  url,
  baseUrl,

  // Used for the GitHub link/edit URLs (repo owner + name).
  organizationName: 'slavatrofimov',
  projectName: 'OperationsIQ',
  trailingSlash: false,

  onBrokenLinks: 'throw',

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          id: 'user',
          path: 'docs/user',
          routeBasePath: 'user',
          sidebarPath: './sidebars/user.ts',
          editUrl:
            'https://github.com/slavatrofimov/OperationsIQ/tree/main/docs-site/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    [
      '@docusaurus/plugin-content-docs',
      {
        id: 'admin',
        path: 'docs/admin',
        routeBasePath: 'admin',
        sidebarPath: './sidebars/admin.ts',
        editUrl: 'https://github.com/slavatrofimov/OperationsIQ/tree/main/docs-site/',
      },
    ],
    [
      '@docusaurus/plugin-content-docs',
      {
        id: 'dev',
        path: 'docs/dev',
        routeBasePath: 'dev',
        sidebarPath: './sidebars/dev.ts',
        editUrl: 'https://github.com/slavatrofimov/OperationsIQ/tree/main/docs-site/',
      },
    ],
  ],

  themes: [
    // Offline / local search (no external service). Fully static — works on
    // Fabric Apps (Rayfin) static hosting and any static host.
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        indexBlog: false,
        docsRouteBasePath: ['user', 'admin', 'dev'],
        // Search defaults to the user guide when no other context exists.
        docsPluginIdForPreferredVersion: 'user',
        highlightSearchTermsOnTargetPage: true,
      },
    ],
  ],

  themeConfig: {
    image: 'img/docusaurus-social-card.jpg',
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'Operations IQ',
      logo: {
        alt: 'Operations IQ Logo',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          docsPluginId: 'user',
          sidebarId: 'userSidebar',
          position: 'left',
          label: 'User Guide',
        },
        {
          type: 'docSidebar',
          docsPluginId: 'admin',
          sidebarId: 'adminSidebar',
          position: 'left',
          label: 'Admin Guide',
        },
        {
          type: 'docSidebar',
          docsPluginId: 'dev',
          sidebarId: 'devSidebar',
          position: 'left',
          label: 'Developer Guide',
        },
        {
          href: 'https://github.com/slavatrofimov/OperationsIQ',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Documentation',
          items: [
            {label: 'User Guide', to: '/user/'},
            {label: 'Admin Guide', to: '/admin/'},
            {label: 'Developer Guide', to: '/dev/'},
          ],
        },
        {
          title: 'Product',
          items: [
            {label: 'Getting started', to: '/user/getting-started/overview'},
            {label: 'Personas', to: '/user/personas/'},
            {label: 'Glossary', to: '/user/glossary'},
          ],
        },
        {
          title: 'More',
          items: [
            {label: 'GitHub', href: 'https://github.com/slavatrofimov/OperationsIQ'},
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Operations IQ.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['powershell', 'bash', 'json', 'python'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
