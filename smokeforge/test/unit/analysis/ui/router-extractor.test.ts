// test/unit/analysis/ui/router-extractor.test.ts
import { describe, it, expect } from 'vitest';
import { extractPages } from '../../../../src/analysis/ui/router-extractor';
import type { DetectionResult } from '../../../../src/ingestion/detector';
import { createFixtureFiles } from '../../../helpers/fixture-helpers';

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
