/**
 * Authorization middleware for role-based access control.
 * Protects routes based on user role and route access rules.
 */

const { canAccessRoute, canAssignRole } = require('./roles');

/**
 * Require user to be logged in.
 */
function requireUser(req, res, next) {
  if (!req.user || !req.authUid) {
    return res.status(401).json({ error: 'Please sign in to continue.', code: 'unauthenticated' });
  }
  next();
}

/**
 * Require specific role(s) to access route.
 * Usage: requireRole('admin'), requireRole(['admin', 'manager'])
 */
function requireRole(roles) {
  const roleArray = Array.isArray(roles) ? roles : [roles];
  
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Please sign in to continue.', code: 'unauthenticated' });
    }
    
    if (!roleArray.includes(req.user.role)) {
      return res.status(403).json({ 
        error: 'Access denied. You do not have permission to access this page.', 
        code: 'forbidden' 
      });
    }
    
    next();
  };
}

/**
 * Require role to create another role.
 * Prevents juniors from creating seniors.
 */
function requireCreateRole(allowedCreator) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Please sign in to continue.', code: 'unauthenticated' });
    }
    
    if (!canAssignRole(req.user.role, allowedCreator)) {
      return res.status(403).json({ 
        error: 'You cannot create a user with that role.', 
        code: 'forbidden' 
      });
    }
    
    next();
  };
}

/**
 * Check if route is accessible (for frontend navigation).
 */
function isRouteAccessible(role, route) {
  return canAccessRoute(role, route);
}

module.exports = {
  requireUser,
  requireRole,
  requireCreateRole,
  isRouteAccessible
};