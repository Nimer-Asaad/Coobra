import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  IMPERSONATION_ROUTE_POLICY,
  IMPERSONATION_TARGET_ROLES,
  type ImpersonationRoutePolicy,
  type UserRole,
} from '@coobra/shared';
import { IS_PUBLIC_KEY, ROLES_KEY } from '../common/decorators.js';
import { API_PREFIX, API_PREFIX_EXCLUDE } from '../configure-app.js';

/*
 * Route coverage for impersonation (ADR 0003 §4). Every route the API registers must have a
 * classification in IMPERSONATION_ROUTE_POLICY, and every classification must name a route that
 * exists. The classification must also agree with the route's own @Public/@Roles decorators.
 */

interface DiscoveredRoute {
  key: string;
  file: string;
  isPublic: boolean;
  /** Method roles override controller roles (Reflector.getAllAndOverride); null = any signed-in user. */
  roles: UserRole[] | null;
}

const srcDir = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

/** Handler names on a class and its base classes (inherited routes count too). */
function methodNames(prototype: object): string[] {
  const names = new Set<string>();
  for (
    let p: object | null = prototype;
    p && p !== Object.prototype;
    p = Object.getPrototypeOf(p)
  ) {
    for (const name of Object.getOwnPropertyNames(p)) if (name !== 'constructor') names.add(name);
  }
  return [...names];
}

function controllerFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return controllerFiles(path);
    return entry.name.endsWith('.controller.ts') ? [path] : [];
  });
}

function joinPath(...parts: string[]): string {
  const path = parts
    .flatMap((part) => part.split('/'))
    .filter(Boolean)
    .join('/');
  return `/${path}`;
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return [typeof value === 'string' ? value : '/'];
}

async function discoverRoutes(): Promise<DiscoveredRoute[]> {
  const routes: DiscoveredRoute[] = [];
  for (const file of controllerFiles(srcDir)) {
    const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    for (const exported of Object.values(module)) {
      if (typeof exported !== 'function') continue;
      const controllerPath: unknown = Reflect.getMetadata(PATH_METADATA, exported);
      if (controllerPath === undefined) continue; // not a controller
      const prototype = (exported as { prototype: Record<string, unknown> }).prototype;
      for (const name of methodNames(prototype)) {
        const handler = prototype[name];
        if (typeof handler !== 'function') continue;
        const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
        if (method === undefined) continue; // not a route handler
        const verb = RequestMethod[method as RequestMethod];
        const isPublic =
          (Reflect.getMetadata(IS_PUBLIC_KEY, handler) ??
            Reflect.getMetadata(IS_PUBLIC_KEY, exported)) === true;
        const roles =
          (Reflect.getMetadata(ROLES_KEY, handler) as UserRole[] | undefined) ??
          (Reflect.getMetadata(ROLES_KEY, exported) as UserRole[] | undefined) ??
          null;
        for (const base of asList(controllerPath)) {
          for (const sub of asList(Reflect.getMetadata(PATH_METADATA, handler))) {
            const path = joinPath(base, sub);
            const prefixed = API_PREFIX_EXCLUDE.includes(path.slice(1))
              ? path
              : joinPath(API_PREFIX, path);
            routes.push({
              key: `${verb} ${prefixed}`,
              file: relative(srcDir, file).replaceAll('\\', '/'),
              isPublic,
              roles,
            });
          }
        }
      }
    }
  }
  return routes;
}

const policy = IMPERSONATION_ROUTE_POLICY as Record<string, ImpersonationRoutePolicy>;
const reachableByTarget = (roles: UserRole[] | null) =>
  roles === null || IMPERSONATION_TARGET_ROLES.some((role) => roles.includes(role));

describe('impersonation route classification', () => {
  let routes: DiscoveredRoute[];

  beforeAll(async () => {
    routes = await discoverRoutes();
  });

  it('finds controllers only in *.controller.ts files, so discovery cannot miss one', () => {
    const elsewhere = sourceFiles(srcDir)
      .filter((file) => !file.endsWith('.controller.ts'))
      .filter((file) => readFileSync(file, 'utf8').includes('@Controller('))
      .map((file) => relative(srcDir, file));
    expect(elsewhere).toEqual([]);
  });

  it('discovers every controller route exactly once', () => {
    expect(routes.length).toBeGreaterThan(0);
    const keys = routes.map((route) => route.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('classifies every registered route, and only registered routes', () => {
    const registered = new Set(routes.map((route) => route.key));
    const classified = new Set(Object.keys(policy));
    const unclassified = [...registered].filter((key) => !classified.has(key)).sort();
    const stale = [...classified].filter((key) => !registered.has(key)).sort();
    expect({ unclassified, stale }).toEqual({ unclassified: [], stale: [] });
  });

  it('marks exactly the @Public routes as PUBLIC', () => {
    for (const route of routes) {
      expect(policy[route.key]?.access === 'PUBLIC', route.key).toBe(route.isPublic);
    }
  });

  it('forbids every route a merchant or driver cannot reach by role, as STAFF_ONLY', () => {
    for (const route of routes) {
      if (route.isPublic || reachableByTarget(route.roles)) continue;
      expect(policy[route.key], route.key).toEqual({ access: 'FORBIDDEN', basis: 'STAFF_ONLY' });
    }
  });

  it('uses STAFF_ONLY only for routes a merchant or driver cannot reach by role', () => {
    for (const route of routes) {
      if (policy[route.key]?.basis !== 'STAFF_ONLY') continue;
      expect(reachableByTarget(route.roles), route.key).toBe(false);
    }
  });

  it('permits only routes the target role can already reach', () => {
    for (const route of routes) {
      const access = policy[route.key]?.access;
      if (access === 'ALLOWED' || access === 'SAFEGUARDED') {
        expect(reachableByTarget(route.roles), route.key).toBe(true);
      }
    }
  });

  it('matches the route counts recorded in ADR 0003', () => {
    const count = (predicate: (route: DiscoveredRoute) => boolean) =>
      routes.filter(predicate).length;
    expect({
      total: routes.length,
      staffOnly: count((route) => policy[route.key]?.basis === 'STAFF_ONLY'),
      reachable: count((route) => policy[route.key]?.basis !== 'STAFF_ONLY'),
    }).toEqual({ total: 104, staffOnly: 72, reachable: 32 });
  });
});
