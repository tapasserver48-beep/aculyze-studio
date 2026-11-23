/**
 * AI Employee Registry — stores AI employee definitions and capabilities.
 *
 * Unlike human users, AI employees are special agents with:
 * - Fixed IDs (emp-ai-*)
 * - System instructions for their persona
 * - Defined capabilities (what tools/tasks they can perform)
 * - Status (active/inactive)
 * - Permissions (which pages/tasks they can access)
 *
 * Storage: data/ai-employees.json (JSON fallback) or PostgreSQL table
 * when DATABASE_URL is configured.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pg = require('../db/pg');

const EMPLOYEE_CODES = {
  CHIEF_OF_STAFF: 'AI-CHIEF-001',
  CUSTOMER_EXECUTIVE: 'AI-CUSTOMER-001',
  EXECUTIVE: 'AI-EXEC-001',
};

const EMPLOYEE_TEMPLATES = {
  [EMPLOYEE_CODES.CHIEF_OF_STAFF]: {
    name: 'Chief of Staff',
    employee_code: EMPLOYEE_CODES.CHIEF_OF_STAFF,
    designation: 'Chief of Staff',
    employee_type: 'ai',
    description: 'Leads the AI workforce with planning, delegation, and oversight.',
    system_instructions: 'You are the Aculyze Chief of Staff AI. Lead the AI workforce, coordinate tasks, prepare reports, and serve as the primary interface between human managers and AI agents. You have access to Gmail (read/write drafts/send) and approved computer operations (app launch, window management, screenshots). Do not make unauthorized changes to user accounts or system settings.',
    capabilities: ['planning', 'delegation', 'reporting', 'gmail_readwrite', 'computer_operations', 'screen_capture', 'employee_oversight', 'task_management', 'task_assignment'],
    permissions: { home: true, inbox: true, apps: true, settings: true, command: true, tasks: true, sales: true },
    status: 'active',
  },
  [EMPLOYEE_CODES.CUSTOMER_EXECUTIVE]: {
    name: 'Customer Executive',
    employee_code: EMPLOYEE_CODES.CUSTOMER_EXECUTIVE,
    designation: 'Customer Executive Agent',
    employee_type: 'ai',
    description: 'Creates and manages customer-facing company chatbots.',
    system_instructions: 'You are the Aculyze Customer Executive AI. Create, customize, and deploy customer-facing chatbots for company websites. Analyze website content, extract company knowledge, and generate chatbot responses. You specialize in customer service automation and can preview chatbots before deployment.',
    capabilities: ['website_analysis', 'knowledge_extraction', 'chatbot_development', 'chatbot_deployment', 'preview_and_test', 'task_management'],
    permissions: { home: true, apps: true, sales: true, tasks: true },
    status: 'active',
  },
  [EMPLOYEE_CODES.EXECUTIVE]: {
    name: 'Executive Agent',
    employee_code: EMPLOYEE_CODES.EXECUTIVE,
    designation: 'Executive Agent',
    employee_type: 'ai',
    description: 'Manages tasks, assigns work, and generates operational reports.',
    system_instructions: 'You are the Aculyze Executive AI. Manage task creation, assignment, and follow-up. Communicate via Inbox, monitor employee activities, and produce detailed operational reports. Help managers track progress and ensure team productivity.',
    capabilities: ['task_management', 'task_assignment', 'task_tracking', 'reporting', 'inbox_communication', 'employee_monitoring'],
    permissions: { home: true, inbox: true, command: true, sales: true, tasks: true },
    status: 'active',
  },
};

const employeesFile = (dataDir) => path.join(dataDir, 'ai-employees.json');

// ---------- JSON backend ----------

function readEmployees(dataDir) {
  try {
    const doc = JSON.parse(fs.readFileSync(employeesFile(dataDir), 'utf8'));
    return { employees: Array.isArray(doc.employees) ? doc.employees : [] };
  } catch {
    return { employees: [] };
  }
}

function writeEmployees(dataDir, doc) {
  const file = employeesFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---------- PostgreSQL backend ----------

async function ensureSchema() {
  if (!pg.enabled()) {
    // Initialize JSON file if it doesn't exist
    const dataDir = process.env.ACULYZE_DATA_DIR;
    const file = employeesFile(dataDir);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ employees: [] }, null, 2), 'utf8');
    }
    return;
  }
  await pg.query(`
    CREATE TABLE IF NOT EXISTS ai_employees (
      id                    TEXT PRIMARY KEY,
      employee_code         TEXT NOT NULL,
      name                  TEXT NOT NULL,
      designation           TEXT NOT NULL,
      employee_type         TEXT NOT NULL DEFAULT 'ai',
      description           TEXT,
      system_instructions   TEXT,
      capabilities          JSONB NOT NULL DEFAULT '[]',
      permissions           JSONB NOT NULL DEFAULT '{}',
      status                TEXT NOT NULL DEFAULT 'active',
      created_at            BIGINT NOT NULL,
      updated_at            BIGINT NOT NULL
    )
  `);
  await pg.query('CREATE UNIQUE INDEX IF NOT EXISTS ai_employees_code_idx ON ai_employees (employee_code)');
  
  // Migrate from JSON if table is empty
  const { rows } = await pg.query('SELECT COUNT(*) AS cnt FROM ai_employees');
  if (Number(rows[0].cnt) === 0) {
    const dataDir = process.env.ACULYZE_DATA_DIR;
    const jsonData = readEmployees(dataDir);
    for (const emp of jsonData.employees || []) {
      await pg.query(
        `INSERT INTO ai_employees (id, employee_code, name, designation, employee_type, 
          description, system_instructions, capabilities, permissions, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [emp.id, emp.employee_code, emp.name, emp.designation, emp.employee_type,
         emp.description, emp.system_instructions, toJson(emp.capabilities, []), toJson(emp.permissions, {}),
         emp.status, emp.created_at, emp.updated_at]
      );
    }
  }
}

async function pgUpsertEmployees(dataDir, employees) {
  if (!pg.enabled()) return;
  const now = Date.now();
  for (const emp of employees) {
    await pg.query(
      `INSERT INTO ai_employees (id, employee_code, name, designation, employee_type,
        description, system_instructions, capabilities, permissions, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         designation = EXCLUDED.designation,
         description = EXCLUDED.description,
         system_instructions = EXCLUDED.system_instructions,
         capabilities = EXCLUDED.capabilities,
         permissions = EXCLUDED.permissions,
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at`,
      [emp.id, emp.employee_code, emp.name, emp.designation, emp.employee_type,
       emp.description, emp.system_instructions, toJson(emp.capabilities, []), toJson(emp.permissions, {}),
       emp.status, emp.created_at || now, emp.updated_at || now]
    );
  }
}

/** Postgres row → employee (JSONB may arrive parsed or as text). */
function rowToEmployee(r) {
  const parse = (v, fb) => {
    if (v === null || v === undefined) return fb;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fb; } }
    return v;
  };
  return {
    id: r.id, employee_code: r.employee_code, name: r.name, designation: r.designation,
    employee_type: r.employee_type, description: r.description, system_instructions: r.system_instructions,
    capabilities: parse(r.capabilities, []), permissions: parse(r.permissions, {}), status: r.status,
    created_at: Number(r.created_at), updated_at: Number(r.updated_at),
  };
}

/** JSONB parameter: send JSON text, never a raw JS array (see above). */
function toJson(value, fallback) {
  if (value === undefined || value === null) return JSON.stringify(fallback);
  if (typeof value === 'string') {
    try { JSON.parse(value); return value; } catch { return JSON.stringify(fallback); }
  }
  return JSON.stringify(value);
}

// ---------- Main functions ----------

function generateAiId() {
  return 'emp-ai-' + crypto.randomUUID().substring(0, 8);
}

async function listEmployees(dataDir) {
  if (pg.enabled()) {
    const { rows } = await pg.query('SELECT * FROM ai_employees ORDER BY created_at');
    return rows.map(rowToEmployee);
  }
  const doc = readEmployees(dataDir);
  return doc.employees || [];
}

async function findById(dataDir, id) {
  if (pg.enabled()) {
    const { rows } = await pg.query('SELECT * FROM ai_employees WHERE id = $1', [id]);
    if (!rows.length) return null;
    return rowToEmployee(rows[0]);
  }
  const doc = readEmployees(dataDir);
  return doc.employees.find(e => e.id === id) || null;
}

async function findByCode(dataDir, code) {
  if (pg.enabled()) {
    const { rows } = await pg.query('SELECT * FROM ai_employees WHERE employee_code = $1', [code]);
    if (!rows.length) return null;
    return rowToEmployee(rows[0]);
  }
  const doc = readEmployees(dataDir);
  return doc.employees.find(e => e.employee_code === code) || null;
}

async function initializeEmployee(dataDir, code) {
  const existing = await findByCode(dataDir, code);
  if (existing) return { created: false, employee: existing, reason: 'already_exists' };

  const template = EMPLOYEE_TEMPLATES[code];
  if (!template) return { created: false, reason: 'unknown_code' };

  const employee = {
    ...template,
    id: generateAiId(),
    created_at: Date.now(),
    updated_at: Date.now(),
  };

  // Save to both backends
  if (pg.enabled()) {
    await pg.query(
      `INSERT INTO ai_employees (id, employee_code, name, designation, employee_type,
        description, system_instructions, capabilities, permissions, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [employee.id, employee.employee_code, employee.name, employee.designation, employee.employee_type,
       employee.description, employee.system_instructions, toJson(employee.capabilities, []), toJson(employee.permissions, {}),
       employee.status, employee.created_at, employee.updated_at]
    );
  } else {
    const doc = readEmployees(dataDir);
    doc.employees = [...(doc.employees || []), employee];
    writeEmployees(dataDir, doc);
  }

  return { created: true, employee };
}

async function updateEmployee(dataDir, id, updates) {
  const now = Date.now();
  const updatesWithTs = { ...updates, updated_at: now };

  if (pg.enabled()) {
    const current = await findById(dataDir, id);
    if (!current) return null;
    const next = { ...current, ...Object.fromEntries(Object.entries(updates || {}).filter(([, v]) => v !== undefined)) };
    const result = await pg.query('UPDATE ai_employees SET name = $1, designation = $2, description = $3, system_instructions = $4, capabilities = $5, permissions = $6, status = $7, updated_at = $8 WHERE id = $9 RETURNING *',
      [next.name, next.designation, next.description, next.system_instructions,
       toJson(next.capabilities, []), toJson(next.permissions, {}), next.status, now, id]);
    if (!result.rows.length) return null;
    const r = result.rows[0];
    return { id: r.id, employee_code: r.employee_code, name: r.name, designation: r.designation, employee_type: r.employee_type, description: r.description, system_instructions: r.system_instructions, capabilities: r.capabilities, permissions: r.permissions, status: r.status, created_at: Number(r.created_at), updated_at: Number(r.updated_at) };
  }

  const doc = readEmployees(dataDir);
  const idx = doc.employees.findIndex(e => e.id === id);
  if (idx === -1) return null;
  doc.employees[idx] = { ...doc.employees[idx], ...updatesWithTs };
  writeEmployees(dataDir, doc);
  return doc.employees[idx];
}

async function deleteEmployee(dataDir, id) {
  if (pg.enabled()) {
    const result = await pg.query('DELETE FROM ai_employees WHERE id = $1 RETURNING id', [id]);
    return result.rows.length > 0;
  }
  const doc = readEmployees(dataDir);
  const idx = doc.employees.findIndex(e => e.id === id);
  if (idx === -1) return false;
  doc.employees.splice(idx, 1);
  writeEmployees(dataDir, doc);
  return true;
}

// Export
module.exports = {
  EMPLOYEE_CODES,
  EMPLOYEE_TEMPLATES,
  generateAiId,
  listEmployees,
  findById,
  findByCode,
  initializeEmployee,
  updateEmployee,
  deleteEmployee,
  ensureSchema,
  pgUpsertEmployees,
};