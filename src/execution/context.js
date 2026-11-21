/**
 * AI Execution Context — trusted server-side context for AI employee operations.
 * 
 * This module provides a secure way to execute AI employee tasks without
 * exposing AI identity to the browser. The context is created server-side
 * after validating human permissions and task assignment.
 * 
 * Key security principles:
 * - Never accept AI identity from the browser
 * - Always validate employee exists and is active
 * - Always validate task is assigned to the employee
 * - Always log all actions with verified actor identity
 */

const crypto = require('crypto');

/**
 * Execution ID generator
 */
function generateExecutionId() {
  return 'exec-' + crypto.randomUUID().substring(0, 12);
}

/**
 * Create a trusted execution context for AI employee operations.
 * 
 * @param {Object} options
 * @param {string} options.employeeId - Verified AI employee ID (emp-ai-*)
 * @param {string} options.employeeCode - AI employee code (AI-CHIEF-001, etc.)
 * @param {string} options.initiatingUserId - Human user who triggered the action
 * @param {string} [options.taskId] - Task being executed (if applicable)
 * @param {string[]} [options.allowedTools] - Tools this employee can use
 * @returns {Object} Trusted execution context
 */
function createContext({ employeeId, employeeCode, initiatingUserId, taskId, allowedTools = [] }) {
  return {
    executionId: generateExecutionId(),
    actorType: 'ai',
    employeeId,
    employeeCode,
    initiatingUserId,
    taskId,
    allowedTools,
    createdAt: Date.now(),
    status: 'pending',
    stepsCompleted: 0,
    maxSteps: 20, // Prevent infinite loops
    timeoutMs: 300000, // 5 minute default timeout
  };
}

/**
 * Validate and resolve an AI employee.
 * Returns null if employee is invalid or not active.
 */
async function resolveEmployee(dataDir, employeeId) {
  const { findById, EMPLOYEE_CODES } = require('../employees/store');
  
  // Validate employee exists
  const employee = await findById(dataDir, employeeId);
  if (!employee) {
    return { valid: false, reason: 'Employee not found' };
  }
  
  // Check status
  if (employee.status !== 'active') {
    return { valid: false, reason: 'Employee not active' };
  }
  
  // Verify this is an AI employee
  if (employee.employee_type !== 'ai') {
    return { valid: false, reason: 'Not an AI employee' };
  }
  
  return { valid: true, employee };
}

/**
 * Validate task assignment for an AI employee.
 */
async function validateTaskAssignment(dataDir, employeeId, taskId) {
  const { getTask } = require('../tasks/store');
  
  const task = await getTask(dataDir, taskId);
  if (!task) {
    return { valid: false, reason: 'Task not found' };
  }
  
  // Only AI-type tasks for AI employees
  if (task.assigned_to_type !== 'ai') {
    return { valid: false, reason: 'Task not assigned to AI' };
  }
  
  // Must be assigned to this employee
  if (task.assigned_to_id !== employeeId) {
    return { valid: false, reason: 'Not assigned to this employee' };
  }
  
  // Check task is not in terminal state
  if (['completed', 'cancelled'].includes(task.status)) {
    return { valid: false, reason: 'Task in terminal state' };
  }
  
  return { valid: true, task };
}

/**
 * Get tool capability for an employee based on their defined capabilities.
 */
function getToolCapability(employee) {
  const capabilities = employee.capabilities || [];
  const capabilityMap = {
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
    if (capabilityMap[cap]) {
      tools.push(...capabilityMap[cap]);
    }
  }
  return tools;
}

module.exports = {
  generateExecutionId,
  createContext,
  resolveEmployee,
  validateTaskAssignment,
  getToolCapability,
};