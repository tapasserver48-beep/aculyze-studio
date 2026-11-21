/**
 * AI Agent Runtime — shared execution engine for all AI employees.
 * 
 * This module provides a secure, trusted execution environment for AI employees.
 * It is called by server-side code only, never directly from the browser.
 * 
 * Responsibilities:
 * - Load employee profile and system instructions
 * - Load task context
 * - Select appropriate model through the AI Router
 * - Generate properly formatted prompts with system instructions
 * - Validate model responses and tool calls
 * - Execute permitted tools
 * - Update task progress
 * - Record activity and audit logs
 * - Send Inbox notifications
 */

const { createRouterFromEnv } = require('../services/ai/router');
const { createContext, resolveEmployee, validateTaskAssignment, getToolCapability } = require('./context');
const { getTask, updateTask, addActivity, addComment } = require('../tasks/store');
const { sendMessage } = require('../inbox/store');
const { checkPermissions } = require('../employees/store');

/**
 * Default system instructions for different AI employee types
 */
const SYSTEM_INSTRUCTIONS = {
  default: `You are an AI employee of Aculyze Studio. Execute your assigned tasks 
following your role's capabilities and permissions. Always validate tool calls 
against your allowed list. Be efficient and clear in your responses.`,
  
  chiefOfStaff: `You are the Aculyze Chief of Staff AI. Lead the AI workforce, 
coordinate tasks, prepare reports, and serve as the primary interface between 
human managers and AI agents. You have access to task management, delegation, 
reporting, and limited computer operations. Do not make unauthorized changes 
to user accounts or system settings.`,
  
  customerExecutive: `You are the Aculyze Customer Executive AI. Create, customize, 
and deploy customer-facing chatbots for company websites. Analyze website 
content, extract company knowledge, and generate chatbot responses. 
Specialize in customer service automation and can preview chatbots before deployment.`,
  
  executive: `You are the Aculyze Executive AI. Manage task creation, assignment, 
and follow-up. Communicate via Inbox, monitor employee activities, and produce 
detailed operational reports. Help managers track progress and ensure team 
productivity.`
};

/**
 * Select the appropriate model based on employee type and task complexity
 */
async function selectModel(router, employee, task) {
  const capabilities = employee.capabilities || [];
  const isComplex = task.priority === 'urgent' || task.priority === 'high' || 
                     task.description?.includes('analyze') || 
                     task.description?.includes('research') ||
                     task.description?.includes('complex');
  
  // Use NVIDIA for complex reasoning, LM Studio for routine tasks
  if (isComplex && router.providers.nvidia.isConfigured) {
    return router.providers.nvidia.defaultModel;
  }
  
  if (router.providers.lmstudio) {
    return router.providers.lmstudio.defaultModel || 'default';
  }
  
  return router.providers.nvidia.defaultModel;
}

/**
 * Build the prompt with employee system instructions
 */
function buildPrompt(employee, task, messages = []) {
  const systemInstructions = SYSTEM_INSTRUCTIONS[employee.employee_code?.toLowerCase().replace(/-/g, '')] || 
                            SYSTEM_INSTRUCTIONS.default;
  
  const systemMessage = {
    role: 'system',
    content: systemInstructions
  };
  
  const taskContext = task ? `
TASK CONTEXT:
Title: ${task.title}
Description: ${task.description || 'No description'}
Priority: ${task.priority}
Status: ${task.status}
Due: ${task.due_date ? new Date(task.due_date).toISOString() : 'Not set'}
` : '';
  
  const humanMessage = {
    role: 'user',
    content: taskContext + (messages.length > 0 ? '\n\nCONVERSATION:\n' + 
      messages.map(m => `${m.role}: ${m.content}`).join('\n') : '')
  };
  
  return [systemMessage, humanMessage, ...messages.filter(m => m.role !== 'system')];
}

/**
 * Execute a task for an AI employee.
 * This is the main entry point for the trusted execution context.
 */
async function executeTask(dataDir, { employeeId, taskId, initiatingUserId, maxSteps = 20, timeoutMs = 300000 }) {
  const startTime = Date.now();
  const executionId = `exec-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  
  // Step 1: Resolve and validate employee
  const empResult = await resolveEmployee(dataDir, employeeId);
  if (!empResult.valid) {
    throw new Error(`Invalid employee: ${empResult.reason}`);
  }
  const employee = empResult.employee;
  
  // Step 2: Validate task assignment
  const taskResult = await validateTaskAssignment(dataDir, employeeId, taskId);
  if (!taskResult.valid) {
    throw new Error(`Task validation failed: ${taskResult.reason}`);
  }
  const task = taskResult.task;
  
  // Step 3: Get AI router
  const router = createRouterFromEnv(process.env);
  
  // Step 4: Resolve appropriate model
  let model;
  try {
    model = await selectModel(router, employee, task);
  } catch (e) {
    console.warn(`[AI Runtime] Model selection failed, using default: ${e.message}`);
    model = router.active.defaultModel || '';
  }
  
  // Step 5: Acknowledge task
  await updateTask(dataDir, taskId, {
    status: 'in_progress',
    updated_at: Date.now()
  });
  
  // Step 6: Add activity
  await addActivity(dataDir, {
    taskId,
    actorType: 'ai',
    actorId: employeeId,
    action: 'execution_started',
    details: {
      model,
      provider: router.providerName,
      executionId,
      initiatingUserId
    }
  });
  
  // Step 7: Build prompt
  const prompt = buildPrompt(employee, task);
  
  // Step 8: Call AI model
  let response;
  try {
    response = await Promise.race([
      router.active.sendMessage({
        messages: prompt,
        model,
        temperature: 0.7,
        max_tokens: 2000
      }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), timeoutMs)
      )
    ]);
  } catch (err) {
    // Mark as blocked on error
    await updateTask(dataDir, taskId, {
      status: 'pending',
      pending_reason: 'blocked',
      updated_at: Date.now()
    });
    await addActivity(dataDir, {
      taskId,
      actorType: 'ai',
      actorId: employeeId,
      action: 'execution_failed',
      details: { error: err.message, executionId }
    });
    throw err;
  }
  
  // Step 9: Record execution
  await addActivity(dataDir, {
    taskId,
    actorType: 'ai',
    actorId: employeeId,
    action: 'execution_progress',
    details: {
      executionId,
      provider: router.providerName,
      model: response.model || model,
      stepsCompleted: 1
    }
  });
  
  // Step 10: Return result
  return {
    executionId,
    employeeId,
    employeeCode: employee.employee_code,
    taskId,
    status: 'in_progress',
    response: response.content,
    model: response.model || model,
    provider: router.providerName,
    startTime,
    elapsedMs: Date.now() - startTime
  };
}

/**
 * Complete a task execution after successful AI work
 */
async function completeTask(dataDir, { employeeId, taskId, result, initiatingUserId }) {
  const task = await getTask(dataDir, taskId);
  if (!task) throw new Error('Task not found');
  
  // Verify this AI owns the task
  if (task.assigned_to_type !== 'ai' || task.assigned_to_id !== employeeId) {
    throw new Error('Not authorized to complete this task');
  }
  
  // Update task
  await updateTask(dataDir, taskId, {
    status: 'completed',
    completed_at: Date.now(),
    updated_at: Date.now()
  });
  
  // Add activity
  await addActivity(dataDir, {
    taskId,
    actorType: 'ai',
    actorId: employeeId,
    action: 'completed',
    details: { result }
  });
  
  // Add comment with results
  await addComment(dataDir, {
    taskId,
    authorType: 'ai',
    authorId: employeeId,
    content: `Task completed.\n\n${result}`
  });
  
  return { success: true, taskId };
}

module.exports = {
  executeTask,
  completeTask,
  buildPrompt,
  selectModel,
};