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
 * Get public user data including role.
 */
function publicUserWithRole(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role || 'employee',
    managerId: user.managerId || null,
    createdAt: user.createdAt
  };
}

module.exports = {
  ROLES,
  ROLE_LIST,
  canAssignRole,
  assignableRoles,
  canAccessRoute,
  publicUserWithRole
};