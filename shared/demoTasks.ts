/**
 * Deterministic demo tasks for the fixture repo created by `npm run demo:setup`.
 *  - "Storage" asks the team PostgreSQL vs SQLite, then appends to the END of README.md.
 *  - "Rebrand: TaskForge" edits the TOP of README.md (clean overlap with Storage → yellow)
 *    and APP_NAME in src/config.js.
 *  - "Rebrand: TodoPro" edits APP_NAME in src/config.js (real conflict with TaskForge → red).
 * Each task has a real-agent prompt and a mock script (offline fallback, no AI).
 */
export interface DemoTask {
  title: string;
  prompt: string;
  mock: string;
}

export const DEMO_TASKS: DemoTask[] = [
  {
    title: "Storage",
    prompt:
      "We want todos to persist. The team has not chosen a database yet. Before writing any code, use your question tool to ask the team " +
      'exactly: "Which database should the todo app use?" with two options, "PostgreSQL" and "SQLite". After the team answers: ' +
      "(1) create src/db.js exporting a placeholder connect() function for the chosen database (no dependencies, no network), " +
      '(2) append a "## Storage" section to the END of README.md naming the chosen database in one sentence. ' +
      "Do not change anything else. Run npm test, then commit with git.",
    mock:
      "say Looking at src/store.js. Persistence needs a database choice first.\n" +
      "ask Which database should the todo app use? | PostgreSQL | SQLite\n" +
      "write src/db.js :: // Placeholder connection for the team's chosen database.\\nexport function connect() {\\n  return { connected: true };\\n}\\n\n" +
      "append README.md :: \\n## Storage\\n\\nTodos will be stored using the database the team chose.\\n\n" +
      "run npm test\n" +
      "say Added src/db.js and a Storage section to README.md.",
  },
  {
    title: "Rebrand: TaskForge",
    prompt:
      'Rename the product to "TaskForge". Change the APP_NAME value in src/config.js to "TaskForge", and change the first line of ' +
      'README.md (the "# Todo" heading) to "# TaskForge". Do not change anything else. Run npm test, then commit with git.',
    mock:
      "say Renaming the product to TaskForge.\n" +
      "run node scripts/rename.mjs TaskForge\n" +
      "say Updated APP_NAME and the README heading.",
  },
  {
    title: "Rebrand: TodoPro",
    prompt:
      'Rename the product to "TodoPro". Change only the APP_NAME value in src/config.js to "TodoPro". Do not change anything else. ' +
      "Run npm test, then commit with git.",
    mock: "say Renaming the product to TodoPro.\nrun node scripts/rename.mjs TodoPro --config-only\nsay Updated APP_NAME.",
  },
];
