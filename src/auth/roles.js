/**
 * Role-based access control for employee hierarchy.
 *
 * Roles:
 * - founder: CEO level, full access, can create any role
 * - admin: System admin, full user management, can create admin/manager/employee
 * - manager: Team lead, can only see and manage employees, can create employees
 * - employee: Normal user, inbox only, sales agent hidden
 */

const ROLES = {
  founder: {
    level: 0,
    label: 'Founder',
    description: 'CEO - Full system access',
    canCreate: true,
    canDelete: true,
    canAssign: ['founder', 'admin', 'manager', 'employee'],
    routes: '/' // All routes
  },
  admin: {
    level: 1,
    label: 'Admin',
    description: 'System Administrator',
    canCreate: true,
    canDelete: true,
    canAssign: ['admin', 'manager', 'employee'],
    routes: '/' // All routes
  },
  manager: {
    level: 2,
    label: 'Manager',
    description: 'Team Manager',
    canCreate: true,
    canDelete: false,
    canAssign: ['employee'],
    routes: ['/apps', '/inbox', '/settings']
  },
  employee: {
    level: 3,
    label: 'Employee',
    description: 'Standard user',
    canCreate: false,
    canDelete: false,
    canAssign: [],
    routes: ['/inbox']
  }
};

const ROLE_LIST = Object.keys(ROLES);

// ---------- Per-page permissions ----------
// Canonical list of app pages a permission can be granted against. This is
// the single source of truth for the admin matrix, API validation and the
// client's nav gating — keep it in sync with VIEW_META in the client.
const PAGE_LIST = ['home', 'inbox', 'zara', 'sales', 'apps', 'store', 'command', 'settings', 'admin', 'tasks', 'chief', 'customer', 'executive', 'automations'];

// Role → default allowed pages BEFORE per-user overrides. founder/admin get
// everything; manager/employee mirror the documented intent of ROLES above
// ("manager: apps/inbox/settings", "employee: inbox only"), plus `home`
// which is the landing page every role needs. The admin page is deliberately
// absent here — it can never be granted by an override (see effectivePages).
// The tasks page is granted to all authenticated roles (employee, manager, admin, founder)
// — task visibility is controlled by backend data permissions, not frontend nav visibility.
const ROLE_PAGES = {
  founder: [...PAGE_LIST],
  admin: [...PAGE_LIST],
  manager: ['home', 'apps', 'inbox', 'settings', 'tasks', 'command', 'chief', 'customer', 'executive', 'automations'],
  employee: ['home', 'inbox', 'tasks', 'automations'],
};

/** Keep only known pages with boolean values — the stored override shape. */
function normalizePermissions(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const page of PAGE_LIST) {
    if (typeof raw[page] === 'boolean') out[page] = raw[page];
  }
  return out;
}

/**
 * Resolve the pages a user can actually see.
 * Precedence: hard rules (admin page = admin/founder only) → per-user
 * override → role default. Never returns an unknown page.
 */
function effectivePages(role, permissions) {
  const defaults = ROLE_PAGES[role] || ROLE_PAGES.employee;
  const overrides = normalizePermissions(permissions);
  const out = {};
  for (const page of PAGE_LIST) {
    if (page === 'admin') {
      // The Admin page is locked to admin/founder; no override can grant it.
      out[page] = role === 'admin' || role === 'founder';
      continue;
    }
    if (page === 'chief') {
      // Delegation is a privilege, not a preference: an override can never
      // grant the Chief of Staff page to an employee (brief §4).
      out[page] = role === 'admin' || role === 'founder' || role === 'manager';
      continue;
    }
    out[page] = page in overrides ? overrides[page] : defaults.includes(page);
  }
  return out;
}

/**
 * Check if a role can be assigned by the actor role.
 */
function canAssignRole(actorRole, targetRole) {
  const actor = ROLES[actorRole];
  if (!actor) return false;
  return actor.canAssign.includes(targetRole);
}

/**
 * Get all roles a user can assign.
 */
function assignableRoles(userRole) {
  const role = ROLES[userRole];
  return role ? role.canAssign : [];
}

/**
 * Check if route is accessible by role.
 */
function canAccessRoute(role, route) {
  const roleDef = ROLES[role];
  if (!roleDef) return false;
  
  if (roleDef.routes === '/' || roleDef.routes.includes(route)) return true;
  
  // Check if route is at root level
  const rootRoute = route.split('?')[0].split('/')[1];
  if (roleDef.routes.includes('/' + rootRoute)) return true;
  if (roleDef.routes.includes('/')) return true;
  
  return false;
}

/**
 * Get public user data including role + resolved page access.
 */
function publicUserWithRole(user) {
  if (!user) return null;
  const role = user.role || 'employee';
  const permissions = normalizePermissions(user.permissions);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role,
    managerId: user.managerId || null,
    permissions,
    pages: effectivePages(role, permissions),
    createdAt: user.createdAt
  };
}

module.exports = {
  ROLES,
  ROLE_LIST,
  PAGE_LIST,
  ROLE_PAGES,
  normalizePermissions,
  effectivePages,
  canAssignRole,
  assignableRoles,
  canAccessRoute,
  publicUserWithRole
};