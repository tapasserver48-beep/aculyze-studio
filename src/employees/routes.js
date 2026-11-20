/**
 * /api/employees — AI Employee management.
 *
 * GET  /api/employees                    → list all employees
 * GET  /api/employees/:id                → get one employee
 * GET  /api/employees/:id/status         → get employee status only
 * PATCH /api/employees/:id               → update employee (admin/founder)
 * PATCH /api/employees/:id/permissions   → update permissions (admin/founder)
 *
 * AI employees are NOT human login accounts — they are special agent identities.
 * Management endpoints require admin/founder role.
 */

const express = require('express');
const {
  listEmployees,
  findById,
  findByCode,
  initializeEmployee,
  updateEmployee,
  deleteEmployee,
  EMPLOYEE_CODES,
} = require('./store');
const { requireUser, requireRole } = require('../auth/authorize');

function createEmployeesRouter({ dataDir }) {
  const router = express.Router();

  // Public: list all AI employees (no auth needed, just read-only)
  router.get('/', async (req, res) => {
    try {
      const employees = await listEmployees(dataDir);
      res.json({ employees });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // Authentication: must be logged in
  router.use(requireUser);

  // Admin-only: create/update employees
  const adminOnly = requireRole(['admin', 'founder']);

  // Get specific employee
  router.get('/:id', adminOnly, async (req, res) => {
    try {
      const employee = await findById(dataDir, req.params.id);
      if (!employee) {
        return res.status(404).json({ error: 'Employee not found' });
      }
      res.json({ employee });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // Get employee status
  router.get('/:id/status', adminOnly, async (req, res) => {
    try {
      const employee = await findById(dataDir, req.params.id);
      if (!employee) {
        return res.status(404).json({ error: 'Employee not found' });
      }
      res.json({ id: employee.id, employee_code: employee.employee_code, status: employee.status });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // Initialize/bulk create AI employees (from predefined templates)
  router.post('/initialize', adminOnly, async (req, res) => {
    const body = req.body || {};
    const codes = body.codes || body.code ? (Array.isArray(body.codes) ? body.codes : [body.code || body.codes]) : [];

    if (!codes.length) {
      return res.status(422).json({ error: 'At least one employee code is required' });
    }

    const results = [];
    for (const code of codes) {
      if (!EMPLOYEE_CODES[code.toUpperCase()]) {
        results.push({ code, created: false, reason: 'unknown_code' });
        continue;
      }
      const result = await initializeEmployee(dataDir, code.toUpperCase());
      results.push({ code, ...result });
    }

    res.json({ results });
  });

  // Update employee
  router.patch('/:id', adminOnly, async (req, res) => {
    try {
      const body = req.body || {};
      const updates = {
        name: body.name,
        designation: body.designation,
        description: body.description,
        system_instructions: body.system_instructions,
        capabilities: body.capabilities,
        permissions: body.permissions,
        status: body.status,
      };
      // Remove undefined values
      Object.keys(updates).forEach(k => updates[k] === undefined && delete updates[k]);

      const employee = await updateEmployee(dataDir, req.params.id, updates);
      if (!employee) {
        return res.status(404).json({ error: 'Employee not found' });
      }
      res.json({ employee });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // Update permissions
  router.patch('/:id/permissions', adminOnly, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.permissions) {
        return res.status(422).json({ error: 'permissions field required' });
      }
      const employee = await updateEmployee(dataDir, req.params.id, { permissions: body.permissions });
      if (!employee) {
        return res.status(404).json({ error: 'Employee not found' });
      }
      res.json({ employee });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  // Delete employee
  router.delete('/:id', adminOnly, async (req, res) => {
    try {
      const deleted = await deleteEmployee(dataDir, req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: 'Employee not found' });
      }
      res.json({ deleted: true });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err).slice(0, 200) });
    }
  });

  return router;
}

module.exports = { createEmployeesRouter, EMPLOYEE_CODES };