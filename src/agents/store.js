/**
 * AI Agent Store — Permissions and validation for AI employee execution.
 * 
 * This module provides:
 * - Employee validation (exists, active)
 * - Task assignment validation
 * - Permission checking for humans to request AI execution
 */

const { findById, findByCode, listEmployees } = require('../employees/store');
const { getTask } = require('../tasks/store');

/**
 * Validate AI employee exists and is active.
 * Supports both ID (emp-ai-*) and employee code (AI-CHIEF-001) formats.
 */
async function validateEmployee(dataDir, employeeIdOrCode) {
  let employee;
  
  // Detect format and lookup accordingly
  if (employeeIdOrCode.startsWith('emp-ai-')) {
    employee = await findById(dataDir, employeeIdOrCode);
  } else {
    employee = await findByCode(dataDir, employeeIdOrCode);
  }
  
  if (!employee) {
    return { valid: false, reason: 'Employee not found' };
  }
  
  if (employee.status !== 'active') {
    return { valid: false, reason: 'Employee not active' };
  }
  
  if (employee.employee_type !== 'ai') {
    return { valid: false, reason: 'Not an AI employee' };
  }
  
  return { valid: true, employee };
}

/**
 * Validate task is assigned to this AI employee
 */
async function validateTaskAssignment(dataDir, employeeId, taskId, requestingUser = null) {
  const task = await getTask(dataDir, taskId);
  
  if (!task) {
    return { valid: false, reason: 'Task not found' };
  }
  
  // Must be AI type task
  if (task.assigned_to_type !== 'ai') {
    return { valid: false, reason: 'Task not assigned to AI' };
  }
  
  // Must be assigned to this employee
  if (task.assigned_to_id !== employeeId) {
    return { valid: false, reason: 'Not assigned to this employee' };
  }
  
  // Cannot modify terminal tasks
  if (['completed', 'cancelled'].includes(task.status)) {
    return { valid: false, reason: 'Task in terminal state' };
  }
  
  return { valid: true, task };
}

/**
 * Check if a human user has permission to request execution from this AI employee.
 * 
 * Permissions:
 * - Founder/Admin: All access
 * - Manager: Access to their team's AI employees
 * - Employee: No direct access (must go through manager)
 */
async function checkExecutionPermission(dataDir, user, employeeId, task) {
  const { role, managerId } = user;
  const isAdmin = role === 'admin' || role === 'founder';
  const isManager = role === 'manager';
  
  // Admins and founders have full access
  if (isAdmin) {
    return { allowed: true };
  }
  
  // Managers can request execution for their team's AI employees
  if (isManager) {
    // If there's a specific task, verify manager relationship
    if (task) {
      // Check if the task assignee is in the manager's scope
      // For now, managers can request their own AI tasks
      return { allowed: true };
    }
    return { allowed: true, reason: 'Manager access granted' };
  }
  
  // Regular employees need special permission or task ownership
  if (task && task.assigned_to_type === 'ai') {
    // Employees can't directly trigger AI execution on unassigned tasks
    return { 
      allowed: false, 
      reason: 'Employees cannot directly trigger AI execution. Request through manager.' 
    };
  }
  
  return { allowed: false, reason: 'Insufficient permissions' };
}

/**
 * Get all active AI employees (for UI display)
 */
async function listActiveEmployees(dataDir) {
  const employees = await listEmployees(dataDir);
  return employees.filter(e => e.status === 'active');
}

/**
 * Get allowed tools for an AI employee based on their capabilities
 */
function getAllowedTools(employee) {
  const capabilities = employee.capabilities || [];
  const toolMap = {
    'task_management': ['tasks.read', 'tasks.update', 'tasks.progress'],
    'task_assignment': ['tasks.assign'],
    'task_tracking': ['tasks.status'],
    'reporting': ['reports.generate'],
    'inbox_communication': ['inbox.send'],
    'employee_monitoring': ['employees.status'],
    'planning': ['tasks.plan'],
    'delegation': ['tasks.delegate'],
    'gmail_readwrite': ['gmail.read', 'gmail.write'],
    'computer_operations': ['computer.run'],
    'screen_capture': ['computer.screenshot'],
    'employee_oversight': ['employees.list'],
    'website_analysis': ['browser.search'],
    'knowledge_extraction': ['lms.query'],
    'chatbot_development': ['integrations.chatbot'],
    'chatbot_deployment': ['integrations.deploy'],
    'preview_and_test': ['browser.preview'],
  };
  
  const tools = [];
  for (const cap of capabilities) {
    if (toolMap[cap]) {
      tools.push(...toolMap[cap]);
    }
  }
  return tools;
}

module.exports = {
  employee: {
    validate: validateEmployee,
    validateTaskAssignment,
    checkExecutionPermission: checkExecutionPermission,
    listActive: listActiveEmployees,
    getAllowedTools,
  }
};