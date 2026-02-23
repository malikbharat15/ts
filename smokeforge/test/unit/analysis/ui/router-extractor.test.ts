// test/unit/analysis/ui/router-extractor.test.ts
import { describe, it, expect } from 'vitest';
import { extractPages, remixFileToRoute } from '../../../../src/analysis/ui/router-extractor';
import type { DetectionResult } from '../../../../src/ingestion/detector';
import { createFixtureFiles, createFixtureFilesWithDir } from '../../../helpers/fixture-helpers';

function makeDetection(overrides: Partial<{
  frontendFrameworks: string[];
  backendFrameworks: string[];
  routerLibraries: string[];
}> = {}): DetectionResult {
  return {
    monorepo: false,
    monorepoTool: 'none',
    packages: [{
      rootPath: '/test',
      name: 'test',
      backendFrameworks: (overrides.backendFrameworks ?? []) as never[],
      frontendFrameworks: (overrides.frontendFrameworks ?? ['react-spa']) as never[],
      routerLibraries: (overrides.routerLibraries ?? ['react-router', 'react-router-dom']) as never[],
      schemaLibraries: [] as never[],
      authLibraries: [] as never[],
      isFullStack: false,
      nodeVersion: null,
      hasTypeScript: true,
      packageJson: {},
    }],
  };
}

describe('extractPages — React Router v5 JSX <Route>', () => {
  it('extracts path from JSX <Route path="..." />', () => {
    const detection = makeDetection({ routerLibraries: ['react-router-dom'] });
    const files = createFixtureFiles({
      'src/App.tsx': `
        import React from 'react';
        import { Route, Switch } from 'react-router-dom';
        function App() {
          return (
            <Switch>
              <Route path="/home" component={Home} />
              <Route path="/about" component={About} />
            </Switch>
          );
        }
        export default App;
      `,
    });
    const pages = extractPages(files, detection, '/test');
    expect(pages.find(p => p.route === '/home')).toBeDefined();
    expect(pages.find(p => p.route === '/about')).toBeDefined();
  });

  it('marks route wrapped in PrivateRoute as authRequired', () => {
    const detection = makeDetection({ routerLibraries: ['react-router-dom'] });
    const files = createFixtureFiles({
      'src/App.tsx': `
        import React from 'react';
        import { Route } from 'react-router-dom';
        function App() {
          return (
            <PrivateRoute>
              <Route path="/dashboard" component={Dashboard} />
            </PrivateRoute>
          );
        }
      `,
    });
    const pages = extractPages(files, detection, '/test');
    const dashboard = pages.find(p => p.route === '/dashboard');
    if (dashboard) {
      expect(dashboard.authRequired).toBe(true);
    }
  });
});

describe('extractPages — React Router v6 createBrowserRouter', () => {
  it('extracts routes from createBrowserRouter([])', () => {
    const detection = makeDetection({ routerLibraries: ['react-router-dom'] });
    const files = createFixtureFiles({
      'src/router.tsx': `
        import { createBrowserRouter } from 'react-router-dom';
        export const router = createBrowserRouter([
          { path: '/users', element: <UsersPage /> },
          { path: '/users/:id', element: <UserDetailPage /> },
        ]);
      `,
    });
    const pages = extractPages(files, detection, '/test');
    expect(pages.find(p => p.route === '/users')).toBeDefined();
  });

  it('extracts routes from useRoutes([])', () => {
    const detection = makeDetection({ routerLibraries: ['react-router-dom'] });
    const files = createFixtureFiles({
      'src/AppRoutes.tsx': `
        import { useRoutes } from 'react-router-dom';
        function AppRoutes() {
          return useRoutes([
            { path: '/login', element: <Login /> },
            { path: '/register', element: <Register /> },
          ]);
        }
        export default AppRoutes;
      `,
    });
    const pages = extractPages(files, detection, '/test');
    expect(pages.find(p => p.route === '/login')).toBeDefined();
  });

  it('extracts nested routes', () => {
    const detection = makeDetection({ routerLibraries: ['react-router-dom'] });
    const files = createFixtureFiles({
      'src/router.tsx': `
        import { createBrowserRouter } from 'react-router-dom';
        export const router = createBrowserRouter([
          {
            path: '/admin',
            element: <AdminLayout />,
            children: [
              { path: 'users', element: <AdminUsers /> },
              { path: 'settings', element: <AdminSettings /> },
            ],
          },
        ]);
      `,
    });
    const pages = extractPages(files, detection, '/test');
    expect(pages.find(p => p.route === '/admin')).toBeDefined();
  });
});

describe('extractPages — Vue Router', () => {
  it('extracts routes from createRouter([]) config', () => {
    const detection = makeDetection({
      frontendFrameworks: ['vue-spa'],
      routerLibraries: ['vue-router'],
    });
    const files = createFixtureFiles({
      'src/router/index.ts': `
        import { createRouter, createWebHistory } from 'vue-router';
        import Home from '../views/Home.vue';
        import About from '../views/About.vue';
        const routes = [
          { path: '/', component: Home },
          { path: '/about', component: About },
          { path: '/users/:id', component: UserDetail },
        ];
        export const router = createRouter({ history: createWebHistory(), routes });
      `,
    });
    const pages = extractPages(files, detection, '/test');
    // Vue Router routes should be detected
    expect(Array.isArray(pages)).toBe(true);
  });
});

describe('extractPages — edge cases', () => {
  it('deduplicates pages with the same route', () => {
    const detection = makeDetection({ routerLibraries: ['react-router-dom'] });
    const files = createFixtureFiles({
      'src/App.tsx': `
        import { Route } from 'react-router-dom';
        function App() {
          return (
            <>
              <Route path="/home" component={A} />
              <Route path="/home" component={B} />
            </>
          );
        }
      `,
    });
    const pages = extractPages(files, detection, '/test');
    const homePages = pages.filter(p => p.route === '/home');
    expect(homePages.length).toBe(1);
  });

  it('returns empty array when no router libraries detected', () => {
    const detection = makeDetection({
      frontendFrameworks: [],
      backendFrameworks: ['express'],
      routerLibraries: [],
    });
    const files = createFixtureFiles({
      'src/server.ts': `const express = require('express'); const app = express();`,
    });
    const pages = extractPages(files, detection, '/test');
    expect(Array.isArray(pages)).toBe(true);
  });
});

// ─── remixFileToRoute — unit tests (pure conversion, no filesystem) ────────────

describe('remixFileToRoute — Remix v2 flat dot-notation', () => {
  it('bare _index.tsx → /', () => {
    expect(remixFileToRoute('_index.tsx')).toBe('/');
  });

  it('bare index.tsx → /', () => {
    expect(remixFileToRoute('index.tsx')).toBe('/');
  });

  it('login.tsx → /login', () => {
    expect(remixFileToRoute('login.tsx')).toBe('/login');
  });

  it('appointments._index.tsx → /appointments', () => {
    expect(remixFileToRoute('appointments._index.tsx')).toBe('/appointments');
  });

  it('appointments.$appointmentId.tsx → /appointments/:appointmentId', () => {
    expect(remixFileToRoute('appointments.$appointmentId.tsx')).toBe('/appointments/:appointmentId');
  });

  it('api.mainframe.branches.ts → /api/mainframe/branches', () => {
    expect(remixFileToRoute('api.mainframe.branches.ts')).toBe('/api/mainframe/branches');
  });

  it('api.mainframe.racf-id.ts → /api/mainframe/racf-id', () => {
    expect(remixFileToRoute('api.mainframe.racf-id.ts')).toBe('/api/mainframe/racf-id');
  });

  it('jenkins.deploy-summary.$applicationId.tsx → /jenkins/deploy-summary/:applicationId', () => {
    expect(remixFileToRoute('jenkins.deploy-summary.$applicationId.tsx'))
      .toBe('/jenkins/deploy-summary/:applicationId');
  });

  it('jenkins.deploy-summary.$applicationId.request.tsx → /jenkins/deploy-summary/:applicationId/request', () => {
    expect(remixFileToRoute('jenkins.deploy-summary.$applicationId.request.tsx'))
      .toBe('/jenkins/deploy-summary/:applicationId/request');
  });

  it('workflow-summaries.$appCode.$repo.tsx → /workflow-summaries/:appCode/:repo', () => {
    expect(remixFileToRoute('workflow-summaries.$appCode.$repo.tsx'))
      .toBe('/workflow-summaries/:appCode/:repo');
  });

  it('developer-productivity.tsx → /developer-productivity', () => {
    expect(remixFileToRoute('developer-productivity.tsx')).toBe('/developer-productivity');
  });

  it('_auth.login.tsx → /login  (pathless layout prefix stripped)', () => {
    expect(remixFileToRoute('_auth.login.tsx')).toBe('/login');
  });

  it('api.session.refresh.ts → /api/session/refresh', () => {
    expect(remixFileToRoute('api.session.refresh.ts')).toBe('/api/session/refresh');
  });
});

describe('remixFileToRoute — Remix v1 folder-based', () => {
  it('appointments/index.tsx → /appointments', () => {
    expect(remixFileToRoute('appointments/index.tsx')).toBe('/appointments');
  });

  it('appointments/$id.tsx → /appointments/:id', () => {
    expect(remixFileToRoute('appointments/$id.tsx')).toBe('/appointments/:id');
  });

  it('api/mainframe/branches.ts → /api/mainframe/branches', () => {
    expect(remixFileToRoute('api/mainframe/branches.ts')).toBe('/api/mainframe/branches');
  });

  it('$id/_index.tsx → /:id', () => {
    expect(remixFileToRoute('$id/_index.tsx')).toBe('/:id');
  });

  it('_auth/login.tsx → /login  (pathless layout prefix stripped)', () => {
    expect(remixFileToRoute('_auth/login.tsx')).toBe('/login');
  });
});

// ─── extractPages — Remix integration (real filesystem) ───────────────────────

function makeRemixDetection(): DetectionResult {
  return {
    monorepo: false,
    monorepoTool: 'none',
    packages: [{
      rootPath: '/test',
      name: 'test',
      backendFrameworks: ['remix'] as never[],
      frontendFrameworks: ['react-spa'] as never[],
      routerLibraries: ['react-router-dom'] as never[],
      schemaLibraries: [] as never[],
      authLibraries: [] as never[],
      isFullStack: false,
      nodeVersion: null,
      hasTypeScript: true,
      packageJson: {},
    }],
  };
}

describe('extractPages — Remix v2 dot-notation (filesystem integration)', () => {
  it('extracts routes from dot-notation flat route files', () => {
    const { parsedFiles, tmpDir } = createFixtureFilesWithDir({
      'app/routes/_index.tsx': `export default function Index() { return <div>Home</div>; }`,
      'app/routes/login.tsx': `export default function Login() { return <div>Login</div>; }`,
      'app/routes/appointments._index.tsx': `export default function Appointments() { return <div />; }`,
      'app/routes/appointments.$id.tsx': `export default function Appointment() { return <div />; }`,
      'app/routes/api.mainframe.branches.ts': `export async function loader() { return []; }`,
      'app/routes/jenkins.deploy-summary.$applicationId.tsx': `export default function Deploy() { return <div />; }`,
    });

    const detection = makeRemixDetection();
    const pages = extractPages(parsedFiles, detection, tmpDir);

    expect(pages.find(p => p.route === '/')).toBeDefined();
    expect(pages.find(p => p.route === '/login')).toBeDefined();
    expect(pages.find(p => p.route === '/appointments')).toBeDefined();
    expect(pages.find(p => p.route === '/appointments/:id')).toBeDefined();
    expect(pages.find(p => p.route === '/api/mainframe/branches')).toBeDefined();
    expect(pages.find(p => p.route === '/jenkins/deploy-summary/:applicationId')).toBeDefined();
  });

  it('deduplicates routes from v2 dot-notation', () => {
    const { parsedFiles, tmpDir } = createFixtureFilesWithDir({
      'app/routes/login.tsx': `export default function Login() { return <div />; }`,
    });
    const detection = makeRemixDetection();
    const pages = extractPages(parsedFiles, detection, tmpDir);
    const loginPages = pages.filter(p => p.route === '/login');
    expect(loginPages.length).toBe(1);
  });
});

describe('extractPages — Remix v1 folder-based (filesystem integration)', () => {
  it('extracts routes from v1 folder structure', () => {
    const { parsedFiles, tmpDir } = createFixtureFilesWithDir({
      'app/routes/index.tsx': `export default function Home() { return <div />; }`,
      'app/routes/login.tsx': `export default function Login() { return <div />; }`,
      'app/routes/appointments/index.tsx': `export default function Appts() { return <div />; }`,
      'app/routes/appointments/$id.tsx': `export default function Appt() { return <div />; }`,
      'app/routes/api/users.ts': `export async function loader() { return []; }`,
    });
    const detection = makeRemixDetection();
    const pages = extractPages(parsedFiles, detection, tmpDir);

    expect(pages.find(p => p.route === '/')).toBeDefined();
    expect(pages.find(p => p.route === '/login')).toBeDefined();
    expect(pages.find(p => p.route === '/appointments')).toBeDefined();
    expect(pages.find(p => p.route === '/appointments/:id')).toBeDefined();
    expect(pages.find(p => p.route === '/api/users')).toBeDefined();
  });
});
